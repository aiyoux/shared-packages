import { liveQuery, type Observable } from 'dexie';
import { createChangeBus } from './changeBus.js';
import { notifyTabChannel, subscribeTabChannel } from './crossTab.js';
import { ROOT_PARENT_KEY, SharedVfsDatabase } from './db.js';
import { generateId } from './id.js';
import { sanitizeName, withNumericSuffix } from './names.js';
import { createMemoryOpfs, createOpfsBlobStore, type OpfsBlobStore } from './opfs.js';
import {
	ensurePersistentStorage,
	type PersistenceResult
} from './persist.js';
import { forceExtension, getFileType, inferFileTypeFromName } from './registry.js';
import { parseJsonBytes, serializeBody } from './serialize.js';
import {
	createOpenDocument,
	watchNode,
	type DocumentHost
} from './documentSession.js';
import {
	type BlobRef,
	type DocumentEvent,
	type DocumentSnapshot,
	type FileTypeId,
	type GcReport,
	type OpenDocument,
	type UpdateFileOpts,
	type VfsListOptions,
	type VfsNode,
	type WriteFileInput,
	VfsError
} from './types.js';
import type { PackOpProgress, PackOpStage } from './types.js';

export interface VfsServiceOptions {
	dbName?: string;
	opfsRoot?: string;
	/** Force memory OPFS (tests). */
	memoryOpfs?: boolean;
	opfs?: OpfsBlobStore;
	/** Write lease / tmp GC grace ms */
	graceMs?: number;
	/**
	 * Request navigator.storage.persist() on first ready() (default true in browser).
	 * Set false for pure unit tests / memory backends.
	 */
	requestPersist?: boolean;
}

const DEFAULT_GRACE = 120_000;

/**
 * Upper bound on one packed file, and the only knob for the layout.
 *
 * Bigger packs mean fewer OPFS round trips but a coarser unit of reclamation:
 * a pack's storage is only freed once every member in it is gone. 64MB matches
 * the write chunk cap, so a chunk maps to at most one pack.
 */
const PACK_CAP_BYTES = 64 << 20;
/** Fraction of a pack that must be dead before rewriting it is worth the IO. */
const COMPACT_WHEN_DEAD_FRACTION = 0.5;
/** Never rewrite a pack to reclaim a trivial amount. */
const COMPACT_MIN_RECLAIM_BYTES = 1 << 20;

/** Byte sizes for pack progress lines. */
function formatPackBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
/** Never shrink the budget below this — a tiny cap costs round trips for nothing. */
const MIN_PACK_BUDGET_BYTES = 4 << 20;
/** At most this share of what storage says is still free may sit in one pack. */
const PACK_BUDGET_SHARE = 0.25;
/** Re-asking storage on every batch is wasted work; the number moves slowly. */
const BUDGET_TTL_MS = 30_000;

export type EmptyTrashProgress = {
	done: number;
	total: number;
	name?: string;
};

export type EmptyTrashOpts = {
	onProgress?: (ev: EmptyTrashProgress) => void;
	/** Staged pack messages (wiping -> compacting -> verifying). */
	onPackProgress?: (ev: PackOpProgress) => void;
	signal?: AbortSignal;
	/** Skip reclaiming dead space in packs the trashed files shared. */
	skipCompaction?: boolean;
};

export type EmptyTrashResult = {
	deleted: number;
	compactedPacks: number;
	reclaimedBytes: number;
	/**
	 * Packs whose dead space could not be reclaimed.
	 *
	 * The node and ref rows are dropped in a transaction BEFORE compaction runs,
	 * and compaction needs that — survivors are defined by what is left. So a
	 * failure here cannot un-delete anything; it leaves dead space. The
	 * operation is therefore reported as incomplete rather than successful,
	 * which is the honest reading of "the op did not finish".
	 */
	failedPacks: string[];
};

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const e = new Error('Cancelled');
	e.name = 'AbortError';
	throw e;
}

function yieldPaint(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export class VfsService {
	readonly db: SharedVfsDatabase;
	readonly opfs: OpfsBlobStore;
	readonly graceMs: number;
	private readyPromise: Promise<void> | null = null;
	private requestPersist: boolean;
	private lastPersistence: PersistenceResult | null = null;
	private readonly changeBus = createChangeBus();
	/** `sweepOnLoad` is once per instance, however many mounts call it. */
	private sweptThisLoad = false;

	constructor(opts: VfsServiceOptions = {}) {
		this.db = new SharedVfsDatabase(opts.dbName ?? 'SharedVFS');
		this.graceMs = opts.graceMs ?? DEFAULT_GRACE;
		const isMemory =
			!!opts.memoryOpfs ||
			!!opts.opfs ||
			typeof navigator === 'undefined' ||
			!navigator.storage?.getDirectory;
		this.requestPersist = opts.requestPersist ?? !isMemory;
		if (opts.opfs) {
			this.opfs = opts.opfs;
		} else if (opts.memoryOpfs || typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
			this.opfs = createMemoryOpfs();
		} else {
			this.opfs = createOpfsBlobStore(opts.opfsRoot ?? 'shared-vfs');
		}
	}

	private tabChannelName(): string {
		return `shared-vfs:${this.db.name}`;
	}

	/** Live list refresh for FileExplorer (same contract as monitor subscribeChanges).
	 * changeBus is same-tab; BroadcastChannel carries the signal to other tabs
	 * because Dexie liveQuery on `.filter()` collections can miss storagemutated. */
	subscribe(listener: () => void): () => void {
		const unsubBus = this.changeBus.subscribe(listener);
		const unsubTab = subscribeTabChannel(this.tabChannelName(), listener);
		return () => {
			unsubBus();
			unsubTab();
		};
	}

	private asDocumentHost(): DocumentHost {
		return {
			get: (id) => this.get(id),
			getPath: (id) => this.getPath(id),
			subscribe: (listener) => this.subscribe(listener),
			updateFile: (id, body, opts) => this.updateFile(id, body, opts),
			writeFile: (input) => this.writeFile(input),
			liveSnapshot: (id) =>
				liveQuery(async (): Promise<DocumentSnapshot> => {
					const node = await this.db.nodes.get(id);
					const path = node ? await this.getPath(id) : [];
					return { node, path };
				})
		};
	}

	subscribeNode(id: string, listener: (event: DocumentEvent) => void): () => void {
		return watchNode(this.asDocumentHost(), id, listener);
	}

	async openDocument(id: string, opts?: { generation?: number }): Promise<OpenDocument> {
		await this.ready();
		return createOpenDocument(this.asDocumentHost(), id, opts);
	}

	private emitChange(): void {
		this.changeBus.notify();
		notifyTabChannel(this.tabChannelName());
	}

	async ready(): Promise<void> {
		if (!this.readyPromise) {
			this.readyPromise = (async () => {
				await this.db.open();
				const ver = await this.db.meta.get('schemaVersion');
				if (!ver) {
					await this.db.meta.put({ key: 'schemaVersion', value: 1 });
				}
				// Best-effort: mark origin storage as persistent (IDB + OPFS).
				// Never fail ready() if the browser denies or lacks the API.
				if (this.requestPersist) {
					try {
						this.lastPersistence = await ensurePersistentStorage();
						await this.db.meta.put({
							key: 'storage:persistence',
							value: {
								status: this.lastPersistence.status,
								requested: this.lastPersistence.requested,
								usage: this.lastPersistence.usage,
								quota: this.lastPersistence.quota,
								at: Date.now()
							}
						});
					} catch {
						/* ignore */
					}
				}
			})();
		}
		return this.readyPromise;
	}

	/** Last result from ensurePersistentStorage (null until ready()). */
	get persistence(): PersistenceResult | null {
		return this.lastPersistence;
	}

	/**
	 * Re-request persistent storage (e.g. after user gesture on first save).
	 * Safe to call anytime after ready().
	 */
	async requestPersistentStorage(): Promise<PersistenceResult> {
		await this.ready();
		const result = await ensurePersistentStorage();
		this.lastPersistence = result;
		try {
			await this.db.meta.put({
				key: 'storage:persistence',
				value: {
					status: result.status,
					requested: result.requested,
					usage: result.usage,
					quota: result.quota,
					at: Date.now()
				}
			});
		} catch {
			/* ignore */
		}
		return result;
	}

	// ── Meta / flags ──────────────────────────────────────────────

	async getMeta<T = unknown>(key: string): Promise<T | undefined> {
		await this.ready();
		const row = await this.db.meta.get(key);
		return row?.value as T | undefined;
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		await this.ready();
		await this.db.meta.put({ key, value });
	}

	// ── List / get ────────────────────────────────────────────────

	async list(opts: VfsListOptions): Promise<VfsNode[]> {
		await this.ready();
		const parentId = opts.parentId ?? null;
		let rows: VfsNode[];

		if (opts.trashOnly) {
			const allDeleted = await this.db.nodes.filter((n) => n.deletedAt != null).toArray();
			const deletedIds = new Set(allDeleted.map((n) => n.id));
			// trash roots: deleted and parent not deleted (or parent null)
			rows = allDeleted.filter((n) => {
				if (n.parentId == null) return true;
				return !deletedIds.has(n.parentId);
			});
		} else {
			// parentKey exists so the root is an index hit like any other folder:
			// IndexedDB cannot index null, so this used to be a full table scan
			// and filter for root listings.
			rows = await this.db.nodes
				.where('parentKey')
				.equals(parentId ?? ROOT_PARENT_KEY)
				.toArray();
			if (!opts.includeDeleted) {
				rows = rows.filter((n) => n.deletedAt == null);
			}
		}

		const sort = opts.sort ?? 'name';
		rows.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
			if (sort === 'updatedAt') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			if (sort === 'order') {
				const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
				const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
				if (ao !== bo) return ao - bo;
				return a.name.localeCompare(b.name);
			}
			return a.name.localeCompare(b.name);
		});
		return rows;
	}

	/** Reactive list (Dexie liveQuery). Querier must be async so awaits inside
	 * `list()` stay in Dexie's observation zone. */
	liveList(opts: VfsListOptions): Observable<VfsNode[]> {
		return liveQuery(async () => this.list(opts));
	}

	async get(id: string): Promise<VfsNode | undefined> {
		await this.ready();
		return this.db.nodes.get(id);
	}

	async getPath(id: string): Promise<VfsNode[]> {
		const chain: VfsNode[] = [];
		let cur = await this.get(id);
		const guard = new Set<string>();
		while (cur) {
			if (guard.has(cur.id)) break;
			guard.add(cur.id);
			chain.unshift(cur);
			if (!cur.parentId) break;
			cur = await this.get(cur.parentId);
		}
		return chain;
	}

	// ── Uniqueness helpers ────────────────────────────────────────

	private async activeSiblings(parentId: string | null, excludeId?: string): Promise<VfsNode[]> {
		let rows: VfsNode[];
		if (parentId === null) {
			rows = await this.db.nodes.filter((n) => n.parentId === null && n.deletedAt == null).toArray();
		} else {
			rows = await this.db.nodes
				.where('parentId')
				.equals(parentId)
				.filter((n) => n.deletedAt == null)
				.toArray();
		}
		if (excludeId) rows = rows.filter((n) => n.id !== excludeId);
		return rows;
	}

	/** Active siblings sorted for order mid calculation (folders-first then sortOrder then name). */
	private sortSiblingsForOrder(rows: VfsNode[]): VfsNode[] {
		return [...rows].sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
			const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
			const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
			if (ao !== bo) return ao - bo;
			return a.name.localeCompare(b.name);
		});
	}

	private async nextAppendSortOrder(parentId: string | null): Promise<number> {
		// Indexed max-sortOrder read: extracting thousands of files into one
		// folder used to load and sort every sibling per write (quadratic).
		// Rows without a sortOrder fall outside the compound index, but the v2
		// upgrade backfilled every active row and every writer sets one, so the
		// indexed max is the real max. Root (parentId null) cannot use the
		// index — null is not an IndexedDB key — so it keeps the scan.
		if (parentId !== null) {
			const last = await this.db.nodes
				.where('[parentId+sortOrder]')
				.between([parentId, -Infinity], [parentId, Infinity])
				.last();
			return (last?.sortOrder ?? -16384) + 16384;
		}
		const siblings = this.sortSiblingsForOrder(await this.activeSiblings(parentId));
		if (!siblings.length) return 0;
		const last = siblings[siblings.length - 1]!;
		const lastOrder = last.sortOrder ?? (siblings.length - 1) * 16384;
		return lastOrder + 16384;
	}

	/**
	 * Same-parent reorder by before/after anchors. Mid from full active siblings.
	 * Rebalances entire sibling group when mid collapses.
	 */
	async reorder(
		id: string,
		opts: { beforeId?: string | null; afterId?: string | null } = {}
	): Promise<VfsNode> {
		await this.ready();
		const { calculateMidOrder, needsRebalance, rebalanceOrders } = await import(
			'./ui/treeDnd/order.js'
		);
		return this.db.transaction('rw', this.db.nodes, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');
			if (node.deletedAt != null) throw new VfsError('TRASH_STATE');

			const siblings = this.sortSiblingsForOrder(
				await this.activeSiblings(node.parentId, id)
			);
			const beforeId = opts.beforeId ?? null;
			const afterId = opts.afterId ?? null;

			let beforeOrder: number | null = null;
			let afterOrder: number | null = null;
			if (beforeId) {
				const b = siblings.find((s) => s.id === beforeId) ?? (await this.db.nodes.get(beforeId));
				if (b && b.parentId === node.parentId) beforeOrder = b.sortOrder ?? 0;
			}
			if (afterId) {
				const a = siblings.find((s) => s.id === afterId) ?? (await this.db.nodes.get(afterId));
				if (a && a.parentId === node.parentId) afterOrder = a.sortOrder ?? 0;
			}
			// If only afterId: insert before that id → before=null, after=afterOrder
			// If only beforeId: insert after that id → before=beforeOrder, after=null
			// If both: between them
			// If neither: append
			if (!beforeId && !afterId && siblings.length) {
				const last = siblings[siblings.length - 1]!;
				beforeOrder = last.sortOrder ?? (siblings.length - 1) * 16384;
				afterOrder = null;
			}

			let mid = calculateMidOrder(beforeOrder, afterOrder);
			if (needsRebalance(mid, beforeOrder, afterOrder)) {
				// Rebuild full group including moving node at desired index
				const ordered = [...siblings];
				let insertAt = ordered.length;
				if (afterId) {
					const i = ordered.findIndex((s) => s.id === afterId);
					if (i >= 0) insertAt = i;
				} else if (beforeId) {
					const i = ordered.findIndex((s) => s.id === beforeId);
					if (i >= 0) insertAt = i + 1;
				}
				ordered.splice(insertAt, 0, node);
				const ranks = rebalanceOrders(ordered.length);
				const now = Date.now();
				for (let i = 0; i < ordered.length; i++) {
					const n = ordered[i]!;
					n.sortOrder = ranks[i];
					n.updatedAt = now;
					await this.db.nodes.put(n);
				}
				return (await this.db.nodes.get(id))!;
			}

			node.sortOrder = mid;
			node.updatedAt = Date.now();
			await this.db.nodes.put(node);
			return node;
		}).then((node) => {
			this.emitChange();
			return node;
		});
	}

	async ensureUniqueName(
		parentId: string | null,
		name: string,
		excludeId?: string,
		onConflict: 'rename' | 'error' | 'overwrite' = 'rename'
	): Promise<string> {
		// Name-probe via the [parentId+name] index instead of loading every
		// sibling: writing thousands of extracted files used to rescan the
		// whole folder per file (quadratic). Root keeps the scan — null parent
		// cannot ride a compound index.
		let taken: (candidate: string) => Promise<boolean>;
		if (parentId === null) {
			const siblings = await this.activeSiblings(parentId, excludeId);
			const names = new Set(siblings.map((s) => s.name));
			taken = async (candidate) => names.has(candidate);
		} else {
			taken = async (candidate) => {
				const hit = await this.db.nodes
					.where('[parentId+name]')
					.equals([parentId, candidate])
					.and((n) => n.deletedAt == null && n.id !== excludeId)
					.first();
				return hit != null;
			};
		}
		if (!(await taken(name))) return name;
		if (onConflict === 'error') {
			throw new VfsError('NAME_CONFLICT', `Name already exists: ${name}`);
		}
		if (onConflict === 'overwrite') return name;
		let i = 1;
		while (await taken(withNumericSuffix(name, i))) i++;
		return withNumericSuffix(name, i);
	}

	// ── mkdir ─────────────────────────────────────────────────────

	async mkdir(
		parentId: string | null,
		name: string,
		opts?: { id?: string; onConflict?: 'rename' | 'error'; meta?: Record<string, unknown> }
	): Promise<VfsNode> {
		await this.ready();
		const clean = sanitizeName(name);
		const id = opts?.id ?? generateId('fld');
		const now = Date.now();

		return this.db.transaction('rw', this.db.nodes, async () => {
			if (parentId) {
				const parent = await this.db.nodes.get(parentId);
				if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER', 'Parent not a folder');
				if (parent.deletedAt != null) throw new VfsError('TRASH_STATE', 'Parent is in trash');
			}
			const unique = await this.ensureUniqueName(parentId, clean, undefined, opts?.onConflict ?? 'rename');
			const existing = await this.db.nodes.get(id);
			if (existing) return existing;
			const sortOrder = await this.nextAppendSortOrder(parentId);
			const node: VfsNode = {
				id,
				parentId,
				name: unique,
				kind: 'folder',
				createdAt: now,
				updatedAt: now,
				generation: 1,
				deletedAt: null,
				sortOrder,
				...(opts?.meta ? { meta: opts.meta } : {})
			};
			await this.db.nodes.put(node);
			return node;
		}).then((node) => {
			this.emitChange();
			return node;
		});
	}

	// ── write / update ────────────────────────────────────────────

	async writeFile(input: WriteFileInput): Promise<VfsNode> {
		await this.ready();
		let name = sanitizeName(input.name);
		const fileType = input.fileType ?? inferFileTypeFromName(name);
		if (fileType !== 'unknown' && getFileType(fileType)) {
			name = forceExtension(name, fileType);
		}

		// Overwrite-in-place: a live sibling file with this exact name is replaced
		// (same id/parent, new bytes, generation bump so bound docs elsewhere see
		// GENERATION_CONFLICT). A same-name folder is not a valid overwrite target.
		if (input.onConflict === 'overwrite') {
			// Look the one name up rather than loading every sibling to find it:
			// the [parentId+name] index exists for exactly this. Root keeps the
			// scan — null is not an IndexedDB key.
			const sameName =
				input.parentId === null
					? (await this.activeSiblings(null)).find((n) => n.name === name)
					: await this.db.nodes
							.where('[parentId+name]')
							.equals([input.parentId, name])
							.and((n) => n.deletedAt == null)
							.first();
			if (sameName?.kind === 'folder') {
				throw new VfsError('NAME_CONFLICT', `A folder named ${name} already exists`);
			}
			if (sameName?.kind === 'file') {
				return this.updateFile(sameName.id, input.body, {
					force: true,
					meta: input.meta,
					contentType: input.contentType
				});
			}
		}

		const nodeId = input.id ?? generateId('file');
		const blobId = generateId('blob');
		const writeId = generateId('w');
		const tmpPath = `tmp/${writeId}.partial`;
		const finalPath = `blobs/${blobId}.bin`;
		const { bytes, contentType } = await serializeBody(input.body, input.contentType);
		const leaseKey = `write:${blobId}`;
		const owner = generateId('lease');
		const now = Date.now();

		if (input.id) {
			const existing = await this.db.nodes.get(input.id);
			if (existing) {
				throw new VfsError('NAME_CONFLICT', `Node id already exists: ${input.id}`, {
					id: input.id,
					trashed: existing.deletedAt != null
				});
			}
		}

		// Reserve name + pending blobRef + lease. Parent is re-checked inside
		// the txn so a concurrent trash cannot park a live child under it.
		await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, this.db.leases, async () => {
			if (input.parentId) {
				const parent = await this.db.nodes.get(input.parentId);
				if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
				if (parent.deletedAt != null) throw new VfsError('TRASH_STATE');
			}
			const unique = await this.ensureUniqueName(
				input.parentId,
				name,
				undefined,
				input.onConflict ?? 'rename'
			);
			name = unique;
			const existing = await this.db.nodes.get(nodeId);
			if (existing) {
				throw new VfsError('NAME_CONFLICT', `Node id already exists: ${nodeId}`, {
					id: nodeId,
					trashed: existing.deletedAt != null
				});
			}
			await this.db.blobRefs.put({
				id: blobId,
				opfsPath: tmpPath,
				byteLength: 0,
				createdAt: now,
				contentType,
				pending: true,
				pendingPromote: true
			});
			await this.db.leases.put({
				key: leaseKey,
				owner,
				expiresAt: now + this.graceMs
			});
			const sortOrder = await this.nextAppendSortOrder(input.parentId);
			const node: VfsNode = {
				id: nodeId,
				parentId: input.parentId,
				name,
				kind: 'file',
				fileType: fileType === 'unknown' ? undefined : fileType,
				size: 0,
				createdAt: now,
				updatedAt: now,
				generation: 1,
				blobId,
				meta: input.meta,
				contentType,
				deletedAt: null,
				sortOrder
			};
			await this.db.nodes.put(node);
		});

		try {
			const partial = await this.opfs.writePartial(writeId, bytes);
			await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, async () => {
				if (input.parentId) {
					const parent = await this.db.nodes.get(input.parentId);
					if (!parent || parent.kind !== 'folder' || parent.deletedAt != null) {
						throw new VfsError('TRASH_STATE');
					}
				}
				await this.db.blobRefs.put({
					id: blobId,
					opfsPath: partial.tmpPath,
					byteLength: partial.byteLength,
					createdAt: now,
					contentType,
					pending: true,
					pendingPromote: true
				});
				const node = await this.db.nodes.get(nodeId);
				if (!node) throw new VfsError('NOT_FOUND');
				node.size = partial.byteLength;
				node.updatedAt = Date.now();
				await this.db.nodes.put(node);
			});
			await this.opfs.promote(partial.tmpPath, finalPath);
			await this.db.transaction('rw', this.db.blobRefs, this.db.leases, async () => {
				const ref = await this.db.blobRefs.get(blobId);
				if (ref) {
					ref.opfsPath = finalPath;
					ref.pendingPromote = false;
					ref.pending = false;
					await this.db.blobRefs.put(ref);
				}
				await this.db.leases.delete(leaseKey);
			});
		} catch (e) {
			await this.db.nodes.delete(nodeId);
			await this.db.blobRefs.delete(blobId);
			await this.db.leases.delete(leaseKey);
			for (const p of [tmpPath, finalPath]) {
				try {
					await this.opfs.remove(p);
				} catch {
					/* ignore */
				}
			}
			if (e instanceof VfsError) throw e;
			throw new VfsError('OPFS_IO', String(e));
		}

		const final = await this.db.nodes.get(nodeId);
		if (!final) throw new VfsError('NOT_FOUND');
		this.emitChange();
		return final;
	}

	/**
	 * Bulk-write files for extract jobs (decompress / decrypt dest writes).
	 *
	 * Same durability guarantees as writeFile — a pending blobRef + lease
	 * reserve the name before any bytes land, and GC reclaims everything if a
	 * chunk dies mid-flight — but the whole chunk shares two IndexedDB
	 * transactions instead of paying three per file, and each member is one
	 * direct OPFS blob write instead of the writePartial→promote cycle that
	 * wrote every byte twice. Extracting thousands of members was dominated by
	 * that per-write churn, not by the inflate itself.
	 *
	 * Extract-shaped inputs only: no explicit `id`, conflict 'rename' (the
	 * writeFile default). A failed chunk rolls back best-effort exactly like
	 * writeFile's catch, and later chunks do not run.
	 */
	private budgetCache: { at: number; bytes: number } | null = null;

	/**
	 * How many bytes one pack / write chunk may hold, given actual free space.
	 *
	 * The fixed 64MB cap assumes desktop-sized storage. Chrome incognito caps
	 * an origin near 100MB, so a single pack was ~64% of the entire budget and
	 * a project large enough to fill one simply could not be written. Sizing
	 * against `navigator.storage.estimate()` keeps the cap proportionate.
	 *
	 * Advisory, not a guarantee: the estimate is deliberately imprecise and can
	 * be stale, so this only shrinks the batch — the write still has to handle
	 * QUOTA_EXCEEDED, which is why that error path exists.
	 */
	private async packBudgetBytes(): Promise<number> {
		const now = Date.now();
		if (this.budgetCache && now - this.budgetCache.at < BUDGET_TTL_MS) {
			return this.budgetCache.bytes;
		}
		let bytes = PACK_CAP_BYTES;
		try {
			const est = await navigator?.storage?.estimate?.();
			const quota = est?.quota;
			const usage = est?.usage ?? 0;
			if (typeof quota === 'number' && quota > 0) {
				const free = Math.max(0, quota - usage);
				bytes = Math.max(
					MIN_PACK_BUDGET_BYTES,
					Math.min(PACK_CAP_BYTES, Math.floor(free * PACK_BUDGET_SHARE))
				);
			}
		} catch {
			// No estimate available — keep the fixed cap rather than guess.
		}
		this.budgetCache = { at: now, bytes };
		return bytes;
	}

	async writeFiles(
		inputs: WriteFileInput[],
		opts?: {
			signal?: AbortSignal;
			/**
			 * Called as each chunk lands, with the nodes just written. Callers
			 * paint per-member UI from this instead of pre-slicing their own
			 * small batches — chunking belongs here, where the cost lives.
			 */
			onProgress?: (written: VfsNode[]) => void;
			/**
			 * Store this chunk's small members inside one shared pack file
			 * instead of one file each. OFF by default, and deliberately so.
			 *
			 * Packing trades robustness for write speed: members share storage,
			 * so releasing one has to prove no sibling still needs the file, and
			 * space only comes back when the last member of a pack dies. That is
			 * a good trade only where deletion happens at the same granularity
			 * as the pack — a project, deleted whole — and a bad one for a
			 * general filesystem where arbitrary files are deleted in arbitrary
			 * order.
			 *
			 * Currently opted in only by the Projects app. The general
			 * extract/decrypt/drop paths leave it off and get their speed from
			 * write concurrency instead.
			 */
			pack?: boolean;
		}
	): Promise<VfsNode[]> {
		await this.ready();
		const out: VfsNode[] = [];
		// Chunk size is governed by BYTES, not file count. OPFS charges per
		// operation regardless of payload, so a bigger chunk is strictly fewer
		// round trips; the byte cap exists to bound how much sits in the heap
		// at once (bodies are serialized up front, before any transaction).
		// Measured on 3000 members: 2015ms at 24/chunk, 1391ms at 128,
		// 1237ms at 512 — past ~512 the curve is flat.
		const CHUNK_FILES = 512;
		const CHUNK_BYTES = await this.packBudgetBytes();
		let chunk: Array<{ input: WriteFileInput; bytes: Uint8Array; contentType: string }> = [];
		let chunkBytes = 0;
		const flush = async () => {
			if (!chunk.length) return;
			if (opts?.signal?.aborted) {
				const e = new Error('Cancelled');
				e.name = 'AbortError';
				throw e;
			}
			const group = chunk;
			chunk = [];
			chunkBytes = 0;
			const written = await this.writeFilesChunk(group, opts?.signal, opts?.pack === true);
			out.push(...written);
			opts?.onProgress?.(written);
		};
		for (const input of inputs) {
			const { bytes, contentType } = await serializeBody(input.body, input.contentType);
			chunk.push({ input, bytes, contentType });
			chunkBytes += bytes.byteLength;
			if (chunk.length >= CHUNK_FILES || chunkBytes >= CHUNK_BYTES) await flush();
		}
		await flush();
		return out;
	}

	/** One reserve→blob-write→confirm cycle for a batch of files. */
	private async writeFilesChunk(
		inputs: Array<{ input: WriteFileInput; bytes: Uint8Array; contentType: string }>,
		signal?: AbortSignal,
		pack = false
	): Promise<VfsNode[]> {
		const prepared = inputs.map(({ input, bytes, contentType }) => {
			let name = sanitizeName(input.name);
			const fileType = input.fileType ?? inferFileTypeFromName(name);
			if (fileType !== 'unknown' && getFileType(fileType)) {
				name = forceExtension(name, fileType);
			}
			const nodeId = input.id ?? generateId('file');
			return {
				input,
				bytes,
				contentType,
				name,
				fileType,
				nodeId,
				blobId: generateId('blob'),
				now: Date.now()
			};
		});
		for (const p of prepared) {
			if (p.input.onConflict && p.input.onConflict !== 'rename') {
				throw new VfsError(
					'API_MISUSE',
					'writeFiles only supports onConflict "rename"; write conflicting files individually'
				);
			}
			if (p.input.id) {
				throw new VfsError('API_MISUSE', 'writeFiles does not accept explicit ids');
			}
		}

		type Reserved = {
			p: (typeof prepared)[number];
			name: string;
		};
		const reserved: Reserved[] = [];
		const leaseKeys = prepared.map((p) => `write:${p.blobId}`);
		const owner = generateId('lease');
		const abortError = () => {
			const e = new Error('Cancelled');
			e.name = 'AbortError';
			return e;
		};
		const cleanup = async () => {
			// Best-effort rollback, matching writeFile's catch. If the failure
			// was inside the reserve txn, Dexie already rolled the puts back and
			// these deletes are no-ops.
			for (const p of prepared) {
				try {
					await this.db.nodes.delete(p.nodeId);
				} catch {
					/* ignore */
				}
				try {
					await this.db.blobRefs.delete(p.blobId);
				} catch {
					/* ignore */
				}
			}
			for (const key of leaseKeys) {
				try {
					await this.db.leases.delete(key);
				} catch {
					/* ignore */
				}
			}
			for (const p of prepared) {
				try {
					await this.opfs.remove(`blobs/${p.blobId}.bin`);
				} catch {
					/* ignore */
				}
			}
		};
		try {
			// Reserve names + pending blobRefs + leases for the whole chunk in
			// one txn. Parent rows are read and sibling names loaded once per
			// parent (root included); names and append sortOrders are then
			// assigned in memory — the write txn excludes other writers, so this
			// is the same result per-file probes would produce, without the
			// per-file sibling scan (quadratic for root, which has no compound
			// index). In-memory naming also makes collisions WITHIN the batch
			// visible, which per-file probes could not see now that rows land
			// via bulkPut after the loop.
			// The blobRef names the FINAL blob path from the start; GC already
			// treats blobs/<id>.bin as live for pendingPromote refs, so a crash
			// mid-write leaves a GC-able orphan, same window as the old
			// tmp→promote protocol.
			// Layout decision, before anything is reserved.
			//
			// OPFS charges per operation regardless of payload, so writing N
			// members as N files costs N x (getFileHandle + createWritable +
			// write + close) round trips. Writing them as ONE multi-part Blob
			// into ONE pack file costs four, total — `new Blob([...])` is a
			// zero-copy reference list, not a buffer.
			//
			// A member at or above half the pack cap gets its own file: it would
			// dominate a pack, and its per-file overhead is already amortised.
			// Packing needs a store that can read a byte range back cheaply;
			// `readRange` is that capability gate (the in-memory store, used by
			// inner-fs sessions, deliberately lacks it and stays unpacked).
			const packable = pack && typeof this.opfs.readRange === 'function' && prepared.length > 1;
			// Scale the "too big to share a pack" line with the same budget the
			// chunk uses, so a shrunken budget does not end up with a pack that
			// one member nearly fills on its own.
			const standaloneAt = (await this.packBudgetBytes()) / 2;
			const packId = generateId('pack');
			const packPath = `packs/${packId}.bin`;
			const packMembers: Array<{ index: number; offset: number }> = [];
			let packBytes = 0;
			if (packable) {
				for (let i = 0; i < prepared.length; i++) {
					const len = prepared[i]!.bytes.byteLength;
					if (len >= standaloneAt) continue;
					packMembers.push({ index: i, offset: packBytes });
					packBytes += len;
				}
			}
			// One member in a pack is byte-identical to a standalone blob at the
			// same cost, so don't pay the shared-storage semantics for it.
			const packedIndexes = new Set(
				packMembers.length > 1 ? packMembers.map((m) => m.index) : []
			);
			const packOffsetByIndex = new Map(
				packMembers.length > 1 ? packMembers.map((m) => [m.index, m.offset]) : []
			);

			const nextAppend = new Map<string, number>();
			const siblingNames = new Map<string, Set<string>>();
			const refPuts: BlobRef[] = [];
			const leasePuts: Array<{ key: string; owner: string; expiresAt: number }> = [];
			const nodePuts: VfsNode[] = [];
			await this.db.transaction(
				'rw',
				this.db.nodes,
				this.db.blobRefs,
				this.db.leases,
				async () => {
					for (const [pIndex, p] of prepared.entries()) {
						if (signal?.aborted) throw abortError();
						const pid = p.input.parentId;
						const stateKey = pid ?? '';
						let taken = siblingNames.get(stateKey);
						let nextSortOrder = nextAppend.get(stateKey);
						if (taken === undefined || nextSortOrder === undefined) {
							if (pid !== null) {
								const parent = await this.db.nodes.get(pid);
								if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
								if (parent.deletedAt != null) throw new VfsError('TRASH_STATE');
							}
							taken = new Set(
								(await this.activeSiblings(pid)).map((n) => n.name.toLowerCase())
							);
							nextSortOrder = await this.nextAppendSortOrder(pid);
							siblingNames.set(stateKey, taken);
							nextAppend.set(stateKey, nextSortOrder);
						}
						// Same 'rename' resolution ensureUniqueName performs.
						let unique = p.name;
						if (taken.has(unique.toLowerCase())) {
							let i = 1;
							while (taken.has(withNumericSuffix(unique, i).toLowerCase())) i++;
							unique = withNumericSuffix(unique, i);
						}
						taken.add(unique.toLowerCase());
						const sortOrder = nextSortOrder;
						nextAppend.set(stateKey, nextSortOrder + 16384);
						const packOffset = packOffsetByIndex.get(pIndex);
						refPuts.push({
							id: p.blobId,
							opfsPath: packOffset != null ? packPath : `blobs/${p.blobId}.bin`,
							byteLength: 0,
							createdAt: p.now,
							contentType: p.contentType,
							pending: true,
							// A packed member's bytes are inside a shared file, so the
							// standalone promote convention does not apply to it.
							pendingPromote: packOffset == null,
							...(packOffset != null ? { packOffset } : {})
						});
						leasePuts.push({
							key: `write:${p.blobId}`,
							owner,
							expiresAt: p.now + this.graceMs
						});
						nodePuts.push({
							id: p.nodeId,
							parentId: pid,
							name: unique,
							kind: 'file',
							fileType: p.fileType === 'unknown' ? undefined : p.fileType,
							size: 0,
							createdAt: p.now,
							updatedAt: p.now,
							generation: 1,
							blobId: p.blobId,
							meta: p.input.meta,
							contentType: p.contentType,
							deletedAt: null,
							sortOrder
						});
						reserved.push({ p, name: unique });
					}
					await this.db.blobRefs.bulkPut(refPuts);
					await this.db.leases.bulkPut(leasePuts);
					await this.db.nodes.bulkPut(nodePuts);
				}
			);
			// The pack is ONE write for every member in it. Blob assembly is
			// zero-copy (a reference list), so this does not duplicate the
			// chunk in memory. Refs stay pending until the confirm txn, so no
			// reader can reach a half-written pack.
			if (packedIndexes.size) {
				if (signal?.aborted) throw abortError();
				const parts: BlobPart[] = [];
				for (let i = 0; i < prepared.length; i++) {
					if (packedIndexes.has(i)) parts.push(prepared[i]!.bytes as BlobPart);
				}
				await this.opfs.writeFinal(packPath, new Blob(parts));
			}
			// Anything not packed (large members, or a chunk too small to be
			// worth a pack) keeps the one-file-per-blob path.
			const standalone = reserved.filter((_, i) => !packedIndexes.has(i));
			// Each standalone write is ~4 IPC round trips to the browser process,
			// so overlapping them hides latency that no amount of batching can
			// remove. Swept on the real path: 1-way 6.19 ms/file, 4-way 3.49,
			// 8-way 2.83, 12-way 2.26, 16-way 2.59, 24-way 2.68, 32-way 4.87 —
			// the curve turns once the browser's own IO queue saturates, so
			// this sits at the measured floor rather than "as parallel as
			// possible".
			const WRITE_CONCURRENCY = 12;
			let cursor = 0;
			const workers = Array.from({ length: WRITE_CONCURRENCY }, async () => {
				while (cursor < standalone.length) {
					if (signal?.aborted) throw abortError();
					const r = standalone[cursor++]!;
					await this.opfs.writeFinal(`blobs/${r.p.blobId}.bin`, r.p.bytes);
				}
			});
			await Promise.all(workers);
			// Confirm sizes + clear pending + drop leases for the whole chunk in
			// one txn (parent re-checked inside the txn so a concurrent trash
			// cannot park a live child under it, as in writeFile). Rows are read
			// in one bulkGet and written back in one bulkPut — per-file get/put
			// round trips were the remaining IDB cost after batching.
			await this.db.transaction(
				'rw',
				this.db.nodes,
				this.db.blobRefs,
				this.db.leases,
				async () => {
					const confirmAt = Date.now();
					const [refs, nodes] = await Promise.all([
						this.db.blobRefs.bulkGet(reserved.map((r) => r.p.blobId)),
						this.db.nodes.bulkGet(reserved.map((r) => r.p.nodeId))
					]);
					const refUpdates: BlobRef[] = [];
					const nodeUpdates: VfsNode[] = [];
					const checkedParents = new Set<string>();
					for (const [i, r] of reserved.entries()) {
						const pid = r.p.input.parentId;
						if (pid !== null && !checkedParents.has(pid)) {
							const parent = await this.db.nodes.get(pid);
							if (!parent || parent.kind !== 'folder' || parent.deletedAt != null) {
								throw new VfsError('TRASH_STATE');
							}
							checkedParents.add(pid);
						}
						const ref = refs[i]!;
						if (ref) {
							refUpdates.push({
								...ref,
								byteLength: r.p.bytes.byteLength,
								pending: false,
								pendingPromote: false
							});
						}
						const node = nodes[i];
						if (!node) throw new VfsError('NOT_FOUND');
						nodeUpdates.push({
							...node,
							size: r.p.bytes.byteLength,
							updatedAt: confirmAt
						});
					}
					await this.db.nodes.bulkPut(nodeUpdates);
					await this.db.blobRefs.bulkPut(refUpdates);
					await this.db.leases.bulkDelete(leaseKeys);
				}
			);
		} catch (e) {
			await cleanup();
			throw e;
		}

		const nodes = await this.db.nodes.bulkGet(reserved.map((r) => r.p.nodeId));
		const out = nodes.filter((n): n is VfsNode => n != null);
		this.emitChange();
		return out;
	}

	/**
	 * Release blob storage for refs whose nodes are gone. THE ONLY PLACE
	 * ALLOWED TO UNLINK A BLOB FILE.
	 *
	 * Today every ref owns its file 1:1 (vfs.copy re-writes bytes rather than
	 * sharing), so this is exactly the old behaviour. It exists as one funnel
	 * because a shared-storage layout — several members inside one packed file
	 * — turns each scattered `opfs.remove(ref.opfsPath)` into a mass delete:
	 * the first dead member would unlink the whole file and every live sibling
	 * would become a dangling ref, silently, since these unlinks are wrapped in
	 * `catch { /* GC later *\/ }`. With one funnel that becomes a single
	 * "is anything still naming this path?" check.
	 *
	 * Callers pass ref ids; rows are deleted here. Unlink failures are
	 * swallowed and left to gc(), as before.
	 */
	private async releaseBlobRefs(refIds: string[]): Promise<void> {
		if (!refIds.length) return;
		const unique = [...new Set(refIds)];
		const refs = (await this.db.blobRefs.bulkGet(unique)).filter(
			(r): r is BlobRef => r != null
		);
		if (!refs.length) return;
		const releasing = new Set(refs.map((r) => r.id));
		await this.db.blobRefs.bulkDelete([...releasing]);

		// Unlink a path only when NOTHING still names it. With one ref per file
		// this is always true and behaves exactly as before; with several
		// members sharing one packed file it is what stops the first dead
		// member destroying every live sibling.
		const candidates = new Set(refs.map((r) => r.opfsPath));
		if (!candidates.size) return;
		// Ask whether ANY ref still names each path, one bounded lookup at a
		// time. Loading every surviving ref to answer that yes/no made deleting
		// N members of one pack quadratic — measured 26.57ms per delete against
		// 0.90ms for this existence check.
		for (const path of [...candidates]) {
			const survivor = await this.db.blobRefs.where('opfsPath').equals(path).first();
			if (survivor) candidates.delete(path);
		}
		await this.unlinkUnreferenced(candidates);
	}

	/**
	 * Unlink each path that no blobRef names any more.
	 *
	 * The second half of releaseBlobRefs, split out because repacking REPOINTS
	 * refs rather than deleting them: the rows must live on while their old
	 * storage is retired. Same rule either way — a path is only unlinked once
	 * nothing names it, which is what stops shared storage turning a rewrite
	 * into a mass delete of live siblings.
	 */
	private async unlinkUnreferenced(paths: Iterable<string>): Promise<void> {
		for (const path of new Set(paths)) {
			const survivor = await this.db.blobRefs.where('opfsPath').equals(path).first();
			if (survivor) continue;
			try {
				await this.opfs.remove(path);
			} catch {
				/* GC later */
			}
		}
	}

	async updateFile(id: string, body: unknown, opts: UpdateFileOpts): Promise<VfsNode> {
		await this.ready();
		const force = 'force' in opts && opts.force === true;
		const expected = !force ? opts.expectedGeneration : undefined;
		if (!force && typeof expected !== 'number') {
			throw new VfsError('API_MISUSE', 'updateFile requires expectedGeneration or force:true');
		}

		const node = await this.db.nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		if (node.kind !== 'file') throw new VfsError('NOT_A_FILE');
		if (node.deletedAt != null) throw new VfsError('TRASH_STATE');

		const prevBlobId = node.blobId;
		const blobId = generateId('blob');
		const writeId = generateId('w');
		const finalPath = `blobs/${blobId}.bin`;
		const { bytes, contentType } = await serializeBody(body, opts.contentType ?? node.contentType);
		const leaseKey = `write:${blobId}`;
		const owner = generateId('lease');
		const now = Date.now();

		let tmpPath: string | undefined;

		try {
			// First, validate the generation inside a read transaction
			await this.db.transaction('r', this.db.nodes, async () => {
				const cur = await this.db.nodes.get(id);
				if (!cur) throw new VfsError('NOT_FOUND');
				if (cur.deletedAt != null) throw new VfsError('TRASH_STATE');
				if (!force && cur.generation !== expected) {
					throw new VfsError('GENERATION_CONFLICT', 'File changed in another tab', {
						expected,
						actual: cur.generation
					});
				}
			});

			// Write to OPFS only after generation check passes
			const partial = await this.opfs.writePartial(writeId, bytes);
			tmpPath = partial.tmpPath;

			// Stage the new blob. Keep node.blobId on the previous ref until
			// promote + path swap succeed so a crash/failed promote cannot
			// unreference the last-good bytes.
			await this.db.transaction('rw', this.db.blobRefs, this.db.leases, async () => {
				await this.db.blobRefs.put({
					id: blobId,
					opfsPath: tmpPath!,
					byteLength: partial.byteLength,
					createdAt: now,
					contentType,
					pendingPromote: true
				});
				await this.db.leases.put({ key: leaseKey, owner, expiresAt: now + this.graceMs });
			});

			await this.opfs.promote(tmpPath, finalPath);

			await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, this.db.leases, async () => {
				const cur = await this.db.nodes.get(id);
				if (!cur) throw new VfsError('NOT_FOUND');
				if (cur.deletedAt != null) throw new VfsError('TRASH_STATE');
				if (!force && cur.generation !== expected) {
					throw new VfsError('GENERATION_CONFLICT', 'File changed in another tab', {
						expected,
						actual: cur.generation
					});
				}
				const ref = await this.db.blobRefs.get(blobId);
				if (ref) {
					ref.opfsPath = finalPath;
					ref.pendingPromote = false;
					await this.db.blobRefs.put(ref);
				}
				cur.blobId = blobId;
				cur.size = partial.byteLength;
				cur.updatedAt = Date.now();
				cur.generation = cur.generation + 1;
				cur.contentType = contentType;
				if (opts.meta !== undefined) cur.meta = opts.meta;
				await this.db.nodes.put(cur);
				await this.db.leases.delete(leaseKey);
			});
		} catch (e) {
			await this.db.blobRefs.delete(blobId);
			await this.db.leases.delete(leaseKey);
			for (const p of [tmpPath, finalPath]) {
				if (!p) continue;
				try {
					await this.opfs.remove(p);
				} catch {
					/* ignore */
				}
			}
			throw e;
		}

		// best-effort previous blob cleanup (node now points at the new blob)
		if (prevBlobId && prevBlobId !== blobId) {
			await this.releaseBlobRefs([prevBlobId]);
		}

		const final = await this.db.nodes.get(id);
		if (!final) throw new VfsError('NOT_FOUND');
		this.emitChange();
		return final;
	}

	// ── Read ──────────────────────────────────────────────────────

	async readBytes(nodeId: string): Promise<Uint8Array> {
		await this.ready();
		const node = await this.db.nodes.get(nodeId);
		if (!node) throw new VfsError('NOT_FOUND');
		if (node.kind !== 'file') throw new VfsError('NOT_A_FILE');
		if (!node.blobId) throw new VfsError('OPFS_IO', 'Missing blobId', { nodeId });
		const ref = await this.db.blobRefs.get(node.blobId);
		if (!ref) throw new VfsError('OPFS_IO', 'Missing blobRef', { nodeId, blobId: node.blobId });
		if (ref.packOffset != null) {
			const slice = await this.readPacked(ref);
			return new Uint8Array(await slice.arrayBuffer());
		}
		return this.opfs.read(ref.opfsPath);
	}

	/**
	 * One member out of a shared pack file. Lazy where the store supports it,
	 * so pulling a 40KB member out of a 64MB pack costs a slice rather than a
	 * full read.
	 */
	private async readPacked(ref: BlobRef, contentType?: string): Promise<Blob> {
		const offset = ref.packOffset ?? 0;
		if (this.opfs.readRange) {
			return this.opfs.readRange(ref.opfsPath, offset, ref.byteLength, contentType);
		}
		// A store without range reads should never have been given packs — the
		// packable check gates on readRange — so reaching here means a pack was
		// written by a store that can slice and is now being read by one that
		// cannot. The bytes are still correct, but every member read pulls the
		// WHOLE pack, so this is loud rather than a quiet slowdown.
		console.warn(
			`[vfs] reading packed blob ${ref.id} without readRange: the whole pack ` +
				`(${ref.opfsPath}) is being read for a ${ref.byteLength}-byte member. ` +
				`This is a correctness-preserving fallback, not a supported path.`
		);
		const all = await this.opfs.read(ref.opfsPath);
		const view = all.subarray(offset, offset + ref.byteLength);
		return new Blob([view as BlobPart], { type: contentType ?? 'application/octet-stream' });
	}

	async readJson<T = unknown>(nodeId: string): Promise<T> {
		const bytes = await this.readBytes(nodeId);
		return parseJsonBytes(bytes) as T;
	}

	async readBlob(nodeId: string): Promise<Blob> {
		await this.ready();
		const node = await this.db.nodes.get(nodeId);
		if (!node) throw new VfsError('NOT_FOUND');
		if (node.kind !== 'file') throw new VfsError('NOT_A_FILE');
		if (!node.blobId) throw new VfsError('OPFS_IO', 'Missing blobId');
		const ref = await this.db.blobRefs.get(node.blobId);
		if (!ref) throw new VfsError('OPFS_IO', 'Missing blobRef');
		const contentType = node.contentType ?? ref.contentType;
		if (ref.packOffset != null) return this.readPacked(ref, contentType);
		return this.opfs.readBlob(ref.opfsPath, contentType);
	}

	// ── rename / move / copy ──────────────────────────────────────

	async rename(id: string, name: string): Promise<VfsNode> {
		await this.ready();
		const clean = sanitizeName(name);
		return this.db.transaction('rw', this.db.nodes, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');
			if (node.deletedAt != null) throw new VfsError('TRASH_STATE');
			let finalName = clean;
			if (node.kind === 'file' && node.fileType && node.fileType !== 'unknown') {
				finalName = forceExtension(clean, node.fileType);
			}
			finalName = await this.ensureUniqueName(node.parentId, finalName, id, 'rename');
			node.name = finalName;
			node.updatedAt = Date.now();
			await this.db.nodes.put(node);
			return node;
		}).then((node) => {
			this.emitChange();
			return node;
		});
	}

	async move(
		id: string,
		newParentId: string | null,
		opts?: { name?: string; beforeId?: string | null; afterId?: string | null }
	): Promise<VfsNode> {
		await this.ready();
		return this.db.transaction('rw', this.db.nodes, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');
			if (node.deletedAt != null) throw new VfsError('TRASH_STATE');
			if (newParentId) {
				const parent = await this.db.nodes.get(newParentId);
				if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
				if (parent.deletedAt != null) throw new VfsError('TRASH_STATE');
				// cycle check
				let walk: string | null = newParentId;
				while (walk) {
					if (walk === id) throw new VfsError('CYCLE', 'Cannot move folder into itself');
					const p: VfsNode | undefined = await this.db.nodes.get(walk);
					walk = p?.parentId ?? null;
				}
			}
			const name = opts?.name ? sanitizeName(opts.name) : node.name;
			const unique = await this.ensureUniqueName(newParentId, name, id, 'rename');
			const sameParent = node.parentId === newParentId;
			node.parentId = newParentId;
			node.name = unique;
			node.updatedAt = Date.now();
			if (!sameParent || opts?.beforeId != null || opts?.afterId != null) {
				// append rank in new parent; precise before/after via reorder after put
				const siblings = this.sortSiblingsForOrder(await this.activeSiblings(newParentId, id));
				if (!siblings.length) node.sortOrder = 0;
				else {
					const last = siblings[siblings.length - 1]!;
					node.sortOrder = (last.sortOrder ?? (siblings.length - 1) * 16384) + 16384;
				}
			}
			await this.db.nodes.put(node);
			return node;
		}).then(async (moved) => {
			if (opts?.beforeId != null || opts?.afterId != null) {
				return this.reorder(id, { beforeId: opts.beforeId, afterId: opts.afterId });
			}
			this.emitChange();
			return moved;
		});
	}

	async copy(id: string, newParentId: string | null): Promise<VfsNode> {
		await this.ready();
		const src = await this.db.nodes.get(id);
		if (!src) throw new VfsError('NOT_FOUND');
		if (src.kind === 'file') {
			const bytes = await this.readBytes(id);
			return this.writeFile({
				parentId: newParentId,
				name: src.name,
				body: bytes,
				fileType: src.fileType,
				contentType: src.contentType,
				meta: src.meta ? { ...src.meta } : undefined
			});
		}
		// folder: recursive
		const folder = await this.mkdir(newParentId, src.name);
		const children = await this.list({ parentId: id });
		for (const child of children) {
			await this.copy(child.id, folder.id);
		}
		return folder;
	}

	// ── Trash ─────────────────────────────────────────────────────

	async trash(id: string): Promise<void> {
		await this.ready();
		const now = Date.now();
		await this.db.transaction('rw', this.db.nodes, async () => {
			const root = await this.db.nodes.get(id);
			if (!root) throw new VfsError('NOT_FOUND');
			if (root.deletedAt != null) return;

			const toTrash: VfsNode[] = [root];
			if (root.kind === 'folder') {
				const all = await this.db.nodes.toArray();
				const byParent = new Map<string | null, VfsNode[]>();
				for (const n of all) {
					const list = byParent.get(n.parentId) ?? [];
					list.push(n);
					byParent.set(n.parentId, list);
				}
				const stack = [root.id];
				while (stack.length) {
					const pid = stack.pop()!;
					for (const c of byParent.get(pid) ?? []) {
						toTrash.push(c);
						if (c.kind === 'folder') stack.push(c.id);
					}
				}
			}
			for (const n of toTrash) {
				if (n.deletedAt != null) continue;
				n.trashParentId = n.trashParentId ?? n.parentId;
				n.deletedAt = now;
				n.updatedAt = now;
				await this.db.nodes.put(n);
			}
		});
		this.emitChange();
	}

	async restore(id: string): Promise<VfsNode> {
		await this.ready();
		return this.db.transaction('rw', this.db.nodes, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');
			if (node.deletedAt == null) return node;

			// if parent still trashed, reparent
			let parentId = node.parentId;
			if (parentId) {
				const parent = await this.db.nodes.get(parentId);
				if (!parent || parent.deletedAt != null) {
					const fallback = node.trashParentId ?? null;
					if (fallback) {
						const fb = await this.db.nodes.get(fallback);
						parentId = fb && fb.deletedAt == null ? fallback : null;
					} else {
						parentId = null;
					}
					node.parentId = parentId;
				}
			}

			const collect: VfsNode[] = [node];
			if (node.kind === 'folder') {
				const all = await this.db.nodes.toArray();
				const stack = [node.id];
				while (stack.length) {
					const pid = stack.pop()!;
					for (const c of all) {
						if (c.parentId === pid && c.deletedAt != null) {
							collect.push(c);
							if (c.kind === 'folder') stack.push(c.id);
						}
					}
				}
			}

			// unique name on root only
			const unique = await this.ensureUniqueName(node.parentId, node.name, node.id, 'rename');
			node.name = unique;

			for (const n of collect) {
				n.deletedAt = null;
				n.trashParentId = null;
				n.updatedAt = Date.now();
				await this.db.nodes.put(n);
			}
			return (await this.db.nodes.get(id))!;
		}).then((node) => {
			this.emitChange();
			return node;
		});
	}

	async permanentDelete(
		id: string,
		opts?: { recursive?: boolean; compact?: boolean }
	): Promise<void> {
		await this.ready();
		const recursive = opts?.recursive ?? false;
		const blobIds: string[] = [];
		const opfsPaths: string[] = [];

		await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');

			const toDelete: VfsNode[] = [node];
			if (node.kind === 'folder') {
				if (!recursive) {
					// Existence, not enumeration: an unindexed scan that loaded
					// every child to ask "are there any?" measured 43ms against
					// 1.3ms for an indexed lookup on a folder of 800.
					const firstChild = await this.db.nodes
						.where('parentId')
						.equals(id)
						.first();
					if (firstChild) throw new VfsError('HAS_CHILDREN', 'Folder has children');
				}
				if (recursive) {
					const all = await this.db.nodes.toArray();
					const stack = [id];
					while (stack.length) {
						const pid = stack.pop()!;
						for (const c of all) {
							if (c.parentId === pid) {
								toDelete.push(c);
								if (c.kind === 'folder') stack.push(c.id);
							}
						}
					}
				}
			}

			for (const n of toDelete) {
				if (n.blobId) blobIds.push(n.blobId);
				await this.db.nodes.delete(n.id);
			}
		});

		// Which packs are about to lose members. Collected BEFORE the release,
		// because releaseBlobRefs drops the very refs that name them.
		const touchedPacks = await this.packPathsForBlobs(blobIds);

		// Rows and files are released together, after the node txn commits, so
		// storage is never unlinked while a node could still name it.
		await this.releaseBlobRefs(blobIds);

		// Deleting permanently bypasses the trash entirely — from the Projects
		// app, or "delete permanently" on a single trashed item — so without
		// this the space would sit dead until some unrelated emptyTrash
		// happened to run. Only packs past the thresholds are rewritten.
		if (opts?.compact !== false && touchedPacks.length) {
			const alive: string[] = [];
			for (const p of touchedPacks) {
				if (await this.opfs.exists(p)) alive.push(p);
			}
			try {
				await this.compactPacks(alive);
			} catch {
				// The delete has committed and cannot be undone; leaving dead
				// space is the lesser outcome, and the load sweep retries.
			}
		}
		this.emitChange();
	}

	async emptyTrash(opts?: EmptyTrashOpts): Promise<EmptyTrashResult> {
		await this.ready();
		throwIfAborted(opts?.signal);
		const trashed = await this.db.nodes.filter((n) => n.deletedAt != null).toArray();
		if (!trashed.length) {
			opts?.onProgress?.({ done: 0, total: 0 });
			return { deleted: 0, compactedPacks: 0, reclaimedBytes: 0, failedPacks: [] };
		}

		const blobIds: string[] = [];
		const nameByBlob = new Map<string, string>();
		for (const n of trashed) {
			if (!n.blobId) continue;
			blobIds.push(n.blobId);
			nameByBlob.set(n.blobId, n.name);
		}
		const uniqueBlobIds = [...new Set(blobIds)];
		const opfsPaths: Array<{ path: string; name: string }> = [];
		// Which packs are about to lose members. Collected NOW, because the refs
		// that name them are dropped in the transaction below — after that there
		// is nothing left to tell us which packs were touched.
		const touchedPacks = new Set<string>();
		for (const bid of uniqueBlobIds) {
			const ref = await this.db.blobRefs.get(bid);
			if (!ref?.opfsPath) continue;
			opfsPaths.push({ path: ref.opfsPath, name: nameByBlob.get(bid) ?? 'file' });
			if (ref.packOffset != null) touchedPacks.add(ref.opfsPath);
		}

		const nodeCount = trashed.length;
		const blobCount = opfsPaths.length;
		const total = nodeCount + blobCount;
		opts?.onProgress?.({ done: 0, total, name: 'Emptying trash…' });
		throwIfAborted(opts?.signal);

		let compactedPacks = 0;
		let reclaimedBytes = 0;
		let failedPacks: string[] = [];

		try {
			await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, async () => {
				await this.db.nodes.bulkDelete(trashed.map((n) => n.id));
				if (uniqueBlobIds.length) await this.db.blobRefs.bulkDelete(uniqueBlobIds);
			});
			opts?.onProgress?.({ done: nodeCount, total, name: 'Emptying trash…' });
			await yieldPaint();

			// Unlink one distinct path at a time so progress stays per file and
			// the op remains cancellable. Ref rows were already dropped in the
			// txn above, so this is the release half of releaseBlobRefs, kept
			// inline for the progress/abort contract — including its survivor
			// check: emptying the trash must never take storage that a file
			// still outside the trash is sharing.
			const seen = new Set<string>();
			for (let i = 0; i < opfsPaths.length; i++) {
				throwIfAborted(opts?.signal);
				const item = opfsPaths[i]!;
				if (!seen.has(item.path)) {
					seen.add(item.path);
					const survivor = await this.db.blobRefs
						.where('opfsPath')
						.equals(item.path)
						.first();
					if (!survivor) {
						try {
							await this.opfs.remove(item.path);
						} catch {
							/* GC later */
						}
					}
				}
				opts?.onProgress?.({ done: nodeCount + i + 1, total, name: item.name });
				if ((i & 7) === 7) await yieldPaint();
			}

			// Packs that lost members but kept survivors are now carrying dead
			// space. Whole-pack unlinking above only covers packs nothing
			// survives in; without this, emptying the trash of packed files
			// appears to free nothing at all. Only packs past the thresholds are
			// rewritten, so five files across two packs costs two rewrites at
			// most, not one per file.
			if (!opts?.skipCompaction && touchedPacks.size) {
				const stillThere: string[] = [];
				for (const p of touchedPacks) {
					if (await this.opfs.exists(p)) stillThere.push(p);
				}
				try {
					const res = await this.compactPacks(stillThere, {
						onProgress: opts?.onPackProgress,
						signal: opts?.signal
					});
					compactedPacks = res.compactedPacks;
					reclaimedBytes = res.reclaimedBytes;
				} catch (e) {
					// The delete itself already committed and cannot be undone, so
					// this is reported as an incomplete operation rather than
					// swallowed or raised as a failed delete.
					if (e instanceof Error && e.name === 'AbortError') throw e;
					failedPacks = stillThere;
					opts?.onPackProgress?.({
						stage: 'failed',
						label: `Files deleted, but ${stillThere.length} pack${
							stillThere.length === 1 ? '' : 's'
						} could not be compacted — space will be reclaimed later.`
					});
				}
			}
		} finally {
			this.emitChange();
		}
		return { deleted: nodeCount, compactedPacks, reclaimedBytes, failedPacks };
	}

	// ── Drafts ────────────────────────────────────────────────────

	async putDraft(draft: import('./types.js').AppDraft): Promise<void> {
		await this.ready();
		await this.db.drafts.put(draft);
		this.emitChange();
	}

	async getDraft(id: string): Promise<import('./types.js').AppDraft | undefined> {
		await this.ready();
		return this.db.drafts.get(id);
	}

	async deleteDraft(id: string): Promise<void> {
		await this.ready();
		await this.db.drafts.delete(id);
		this.emitChange();
	}

	// ── Migration helpers ─────────────────────────────────────────

	/**
	 * Upsert node by id. Migration/backfill only — bypasses CAS and
	 * generation policy. Not a live save path.
	 */
	async migratePutNode(node: VfsNode): Promise<void> {
		await this.ready();
		await this.db.nodes.put(node);
	}

	async migratePutBlob(
		blobId: string,
		body: unknown,
		contentType?: string
	): Promise<{ byteLength: number; opfsPath: string }> {
		await this.ready();
		const writeId = generateId('mw');
		const finalPath = `blobs/${blobId}.bin`;
		const { bytes, contentType: ct } = await serializeBody(body, contentType);
		const { tmpPath, byteLength } = await this.opfs.writePartial(writeId, bytes);
		await this.db.blobRefs.put({
			id: blobId,
			opfsPath: tmpPath,
			byteLength,
			createdAt: Date.now(),
			contentType: ct,
			pendingPromote: true
		});
		await this.opfs.promote(tmpPath, finalPath);
		await this.db.blobRefs.put({
			id: blobId,
			opfsPath: finalPath,
			byteLength,
			createdAt: Date.now(),
			contentType: ct,
			pendingPromote: false
		});
		return { byteLength, opfsPath: finalPath };
	}

	// ── GC ────────────────────────────────────────────────────────

	/**
	 * Sweep crash debris, at most once per VFS load.
	 *
	 * Reclaiming space that a delete should have freed is NOT this method's job
	 * — deletes do their own reclamation synchronously and fail loudly if they
	 * cannot (see `releaseBlobRefs` and `deleteFromProject`). What is left for a
	 * sweep is genuine debris: a tab killed mid-write leaves a pending blobRef
	 * and an orphaned file that no delete will ever visit.
	 *
	 * That distinction sets the schedule. This runs on load, not on a timer: an
	 * interval long enough to be unobtrusive is one that short sessions never
	 * reach, and an app used in short bursts would sweep approximately never.
	 * Debris only appears when a session dies, so the next session opening the
	 * store is exactly when it is worth looking.
	 *
	 * Cross-tab safety reuses the lease table rather than inventing anything:
	 * whichever tab claims `gc:run` inside the claim transaction is the one that
	 * sweeps, and the claim expires on its own if that tab dies mid-run. Callers
	 * fire and forget; failures are swallowed because a missed sweep is deferred
	 * cleanup, never a correctness problem.
	 *
	 * Returns the report when this call actually swept, or null when it skipped
	 * (already swept this load, or another tab holds the claim).
	 */
	async maybeGc(opts?: { minIntervalMs?: number; force?: boolean }): Promise<GcReport | null> {
		await this.ready();
		// Default 0: every load is eligible. A caller can still pass an interval
		// to throttle a hot path, but nothing in the app does.
		const minInterval = opts?.minIntervalMs ?? 0;
		const now = Date.now();
		const CLAIM = 'gc:run';
		const LAST_RUN = 'gc:lastRun';

		try {
			const claimed = await this.db.transaction(
				'rw',
				this.db.meta,
				this.db.leases,
				async () => {
					if (!opts?.force) {
						const last = (await this.db.meta.get(LAST_RUN))?.value;
						if (typeof last === 'number' && now - last < minInterval) return false;
					}
					const held = await this.db.leases.get(CLAIM);
					if (held && held.expiresAt > now) return false;
					// Stamp the run BEFORE sweeping: a tab that dies mid-sweep must
					// not leave every other tab retrying immediately.
					await this.db.meta.put({ key: LAST_RUN, value: now });
					await this.db.leases.put({
						key: CLAIM,
						owner: generateId('gc'),
						expiresAt: now + Math.max(this.graceMs, 60_000)
					});
					return true;
				}
			);
			if (!claimed) return null;
		} catch {
			return null;
		}

		try {
			return await this.gc();
		} catch {
			return null;
		} finally {
			try {
				await this.db.leases.delete(CLAIM);
			} catch {
				/* the lease expires on its own */
			}
		}
	}

	/**
	 * Sweep once for this VFS instance, off the critical path.
	 *
	 * Idempotent per instance, so callers can invoke it from any mount without
	 * coordinating. Deferred behind a timeout (and `requestIdleCallback` where
	 * available) so it never competes with the work the user is waiting for,
	 * and returns a canceller for teardown.
	 */
	/**
	 * Reclaim packs that have quietly gone mostly-dead.
	 *
	 * Nothing in the delete path sees this: `updateFile` moves a file OUT of
	 * its pack to a standalone blob (packs are immutable and never appended
	 * to), releasing the old member without any delete ever happening. Edit
	 * enough of a project and its packs are mostly dead bytes with nothing to
	 * trigger cleanup.
	 *
	 * No marker set is kept. Per-pack live bytes come from blobRefs, which is
	 * one query, and the only added cost is a `.size` per pack — cheap because
	 * readBlob is lazy. That also makes this self-correcting: it reclaims drift
	 * from any source, including one nobody thought to instrument.
	 *
	 * Deliberately NOT part of `gc()`. Those four gc tests encode its contract,
	 * and rewriting packs is not in it — a sweep that collects garbage is a
	 * different promise from one that rewrites live data.
	 */
	async compactStalePacks(opts?: {
		signal?: AbortSignal;
		onProgress?: (ev: PackOpProgress) => void;
	}): Promise<{ compactedPacks: number; reclaimedBytes: number }> {
		await this.ready();
		const refs = await this.db.blobRefs.toArray();
		const liveByPack = new Map<string, number>();
		for (const r of refs) {
			if (r.packOffset == null) continue;
			liveByPack.set(r.opfsPath, (liveByPack.get(r.opfsPath) ?? 0) + r.byteLength);
		}
		if (!liveByPack.size) return { compactedPacks: 0, reclaimedBytes: 0 };

		const candidates: string[] = [];
		for (const [path, live] of liveByPack) {
			if (opts?.signal?.aborted) break;
			let onDisk = 0;
			try {
				onDisk = (await this.opfs.readBlob(path)).size;
			} catch {
				continue;
			}
			const dead = onDisk - live;
			if (
				dead >= COMPACT_MIN_RECLAIM_BYTES &&
				dead / Math.max(onDisk, 1) >= COMPACT_WHEN_DEAD_FRACTION
			) {
				candidates.push(path);
			}
		}
		if (!candidates.length) return { compactedPacks: 0, reclaimedBytes: 0 };
		return this.compactPacks(candidates, opts);
	}

	sweepOnLoad(opts?: { delayMs?: number }): () => void {
		if (this.sweptThisLoad) return () => {};
		this.sweptThisLoad = true;
		if (typeof window === 'undefined') return () => {};
		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			void this.maybeGc().then(() => {
				if (cancelled) return;
				// After the garbage is gone, reclaim packs that editing left
				// mostly dead. Idle time is the right place for it: it rewrites
				// live data, so it must never land on a save the user is waiting
				// on.
				return this.compactStalePacks().catch(() => {});
			});
		};
		const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
			.requestIdleCallback;
		const timer = setTimeout(() => {
			if (idle) idle(run);
			else run();
		}, opts?.delayMs ?? 2_000);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}

	/**
	 * Rewrite one pack without its dead space.
	 *
	 * Order matters and is the whole safety argument:
	 *   1. build the new pack from SLICES of the old (lazy Blobs — no bytes in JS)
	 *   2. verify it is the size the new layout demands
	 *   3. swap every affected ref in one transaction, re-reading each row so a
	 *      ref changed by a concurrent write is skipped rather than clobbered
	 *   4. only then unlink the old file
	 * A crash at any point before 3 leaves the old pack authoritative.
	 */
	private async compactOnePack(
			packPath: string,
			survivors: BlobRef[],
			report: (stage: PackOpStage, label: string, bytes?: number) => void
		): Promise<number> {
		const source = await this.opfs.readBlob(packPath);
		const before = source.size;

		const ordered = [...survivors].sort((a, b) => (a.packOffset ?? 0) - (b.packOffset ?? 0));
		const parts: BlobPart[] = [];
		const layout: Array<{ id: string; offset: number; length: number }> = [];
		let cursor = 0;
		for (const ref of ordered) {
			const from = ref.packOffset ?? 0;
			// slice() is lazy: the bytes are copied browser-side on write, never
			// materialised here, so a 64MB pack costs no heap to compact.
			parts.push(source.slice(from, from + ref.byteLength));
			layout.push({ id: ref.id, offset: cursor, length: ref.byteLength });
			cursor += ref.byteLength;
		}

		const newPath = `packs/${`pack_${crypto.randomUUID()}`}.bin`;
		await this.opfs.writeFinal(newPath, new Blob(parts));

		report('verifying', 'Deleting — verifying blob integrity…');
		const written = await this.opfs.readBlob(newPath);
		if (written.size !== cursor) {
			// Nothing has been swapped yet, so the old pack is still authoritative.
			try {
				await this.opfs.remove(newPath);
			} catch {
				/* gc sweeps packs/ */
			}
			throw new Error(
				`Pack compaction verification failed: expected ${cursor} bytes, wrote ${written.size}`
			);
		}

		await this.db.transaction('rw', this.db.blobRefs, async () => {
			for (const item of layout) {
				// Re-read inside the txn: a concurrent updateFile may have moved this
				// node to its own blob, in which case its ref must not be dragged
				// into the new pack.
				const current = await this.db.blobRefs.get(item.id);
				if (!current || current.opfsPath !== packPath) continue;
				await this.db.blobRefs.put({
					...current,
					opfsPath: newPath,
					packOffset: item.offset
				});
			}
		});

		// Retire the old pack only when NOTHING still names it.
		//
		// The swap deliberately skips refs that changed underneath it, and a ref
		// can also appear between the survivor scan and the swap. Either way it may
		// still point into the old pack, so unlinking unconditionally would destroy
		// live bytes — the same shared-storage trap that releaseBlobRefs exists to
		// avoid, and it applies here too.
		const stillNamed = await this.db.blobRefs.where('opfsPath').equals(packPath).first();
		if (stillNamed) {
			// The new pack is a superset copy, so nothing is lost — but the space is
			// not reclaimed either, and a caller reporting bytes freed must not lie.
			console.warn(
				`[vfs] pack ${packPath} still has live references after compaction; ` +
					'keeping it. Space will be reclaimed on a later delete.'
			);
			return 0;
		}
		try {
			await this.opfs.remove(packPath);
		} catch {
			/* gc sweeps packs/ */
		}
		return Math.max(0, before - cursor);
	}

	/**
	 * Reclaim dead space in the packs named by `packPaths`.
	 *
	 * Pack mutation lives here because this class also creates packs: one owner
	 * for the format means a caller cannot compact without the survivor rules
	 * that make it safe. `deleteFromProject`, `emptyTrash` and `permanentDelete`
	 * all funnel through it.
	 *
	 * Only packs worth rewriting are touched. Compaction rewrites the LIVE bytes
	 * to reclaim the dead ones, so at 50% dead it writes one byte per byte
	 * returned — below that it costs more than it gives back, and the absolute
	 * floor stops a favourable ratio on a tiny pack paying several OPFS round
	 * trips for nothing.
	 */
	async compactPacks(
		packPaths: Iterable<string>,
		opts?: {
			onProgress?: (ev: PackOpProgress) => void;
			signal?: AbortSignal;
		}
	): Promise<{ compactedPacks: number; reclaimedBytes: number }> {
		await this.ready();
		const report = (stage: PackOpStage, label: string, reclaimedBytes?: number) =>
			opts?.onProgress?.({ stage, label, reclaimedBytes });

		let compactedPacks = 0;
		let reclaimedBytes = 0;
		for (const packPath of new Set(packPaths)) {
			if (opts?.signal?.aborted) break;
			// Survivors decide the outcome: none means releaseBlobRefs already
			// unlinked the file and there is nothing to compact.
			const survivors = await this.db.blobRefs.where('opfsPath').equals(packPath).toArray();
			if (!survivors.length) continue;

			let onDisk = 0;
			try {
				onDisk = (await this.opfs.readBlob(packPath)).size;
			} catch {
				continue;
			}
			const live = survivors.reduce((n, r) => n + r.byteLength, 0);
			const dead = onDisk - live;
			if (
				dead < COMPACT_MIN_RECLAIM_BYTES ||
				dead / Math.max(onDisk, 1) < COMPACT_WHEN_DEAD_FRACTION
			) {
				continue;
			}

			report('compacting', `Compacting ${formatPackBytes(dead)}…`);
			const freed = await this.compactOnePack(packPath, survivors, report);
			reclaimedBytes += freed;
			// compactOnePack returns 0 when it had to keep the old file because a
			// live ref still names it; counting that would overstate the result.
			if (freed > 0) compactedPacks += 1;
		}
		return { compactedPacks, reclaimedBytes };
	}

	/**
	 * Read a blob ref's bytes as a LAZY Blob, wherever they currently live.
	 *
	 * Lazy matters: a repack builds its new pack from these, and slices are not
	 * materialised until the write, so rewriting a 25MB pack costs no heap.
	 */
	private async refAsBlob(ref: BlobRef): Promise<Blob> {
		const file = await this.opfs.readBlob(ref.opfsPath);
		if (ref.packOffset == null) return file;
		return file.slice(ref.packOffset, ref.packOffset + ref.byteLength);
	}

	/**
	 * Move the given nodes' bytes OUT of packs into one blob each.
	 *
	 * This is what "turn packing off" means for a project that already has
	 * packs: afterwards every file is an ordinary standalone blob and the
	 * folder behaves like any other part of the filesystem.
	 *
	 * The ref row is kept and repointed rather than replaced, so node.blobId
	 * never changes and nothing holding an id goes stale.
	 */
	async unpackNodes(
		nodeIds: string[],
		opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
	): Promise<{ movedFiles: number }> {
		await this.ready();
		const report = (stage: PackOpStage, label: string) => opts?.onProgress?.({ stage, label });

		const packed: BlobRef[] = [];
		for (const id of new Set(nodeIds)) {
			const node = await this.db.nodes.get(id);
			if (!node?.blobId) continue;
			const ref = await this.db.blobRefs.get(node.blobId);
			if (ref?.packOffset != null) packed.push(ref);
		}
		if (!packed.length) return { movedFiles: 0 };

		report('compacting', `Unpacking ${packed.length} file${packed.length === 1 ? '' : 's'}…`);
		const oldPaths = new Set(packed.map((r) => r.opfsPath));
		let moved = 0;
		for (const ref of packed) {
			throwIfAborted(opts?.signal);
			const blob = await this.refAsBlob(ref);
			const destPath = `blobs/${ref.id}.bin`;
			await this.opfs.writeFinal(destPath, blob);
			// Re-read inside the transaction: a concurrent updateFile may have
			// already moved this ref off the pack, and must not be dragged back.
			const swapped = await this.db.transaction('rw', this.db.blobRefs, async () => {
				const current = await this.db.blobRefs.get(ref.id);
				if (!current || current.opfsPath !== ref.opfsPath) return false;
				const { packOffset: _drop, ...rest } = current;
				await this.db.blobRefs.put({ ...rest, opfsPath: destPath });
				return true;
			});
			if (swapped) moved += 1;
			else {
				try {
					await this.opfs.remove(destPath);
				} catch {
					/* gc sweeps blobs/ */
				}
			}
		}

		// Only now, and only where nothing still points into them.
		await this.unlinkUnreferenced(oldPaths);
		report('done', `Unpacked ${moved} file${moved === 1 ? '' : 's'}`);
		this.emitChange();
		return { movedFiles: moved };
	}

	/**
	 * Rewrite the given nodes' storage into fresh packs.
	 *
	 * Does double duty, because both halves are the same operation: it drops
	 * dead space (the members it copies are the live ones) AND re-absorbs files
	 * that drifted out to standalone blobs when they were edited. The automatic
	 * sweep can only do the first half — nothing may silently pull a file back
	 * into shared storage — so this is always user-initiated.
	 *
	 * Order is the safety argument, same as compaction: build, verify the size
	 * the layout demands, swap refs re-reading each row, and only then retire
	 * whatever nothing names any more.
	 */
	async repackNodes(
		nodeIds: string[],
		opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
	): Promise<{ packs: number; movedFiles: number }> {
		await this.ready();
		if (typeof this.opfs.readRange !== 'function') return { packs: 0, movedFiles: 0 };
		const report = (stage: PackOpStage, label: string) => opts?.onProgress?.({ stage, label });

		const budget = await this.packBudgetBytes();
		const standaloneAt = budget / 2;
		const refs: BlobRef[] = [];
		for (const id of new Set(nodeIds)) {
			const node = await this.db.nodes.get(id);
			if (!node?.blobId) continue;
			const ref = await this.db.blobRefs.get(node.blobId);
			// Members at or above half the budget stay on their own: a pack one
			// file nearly fills buys nothing and complicates everything.
			if (ref && ref.byteLength < standaloneAt) refs.push(ref);
		}
		if (refs.length < 2) return { packs: 0, movedFiles: 0 };

		let packs = 0;
		let movedFiles = 0;
		const retired = new Set<string>();
		for (let i = 0; i < refs.length; ) {
			throwIfAborted(opts?.signal);
			const group: BlobRef[] = [];
			let bytes = 0;
			while (i < refs.length && group.length < 512 && bytes + refs[i]!.byteLength <= budget) {
				bytes += refs[i]!.byteLength;
				group.push(refs[i]!);
				i += 1;
			}
			if (!group.length) break;

			report('compacting', `Packing ${group.length} file${group.length === 1 ? '' : 's'}…`);
			const parts: BlobPart[] = [];
			const layout: Array<{ id: string; from: string; offset: number; length: number }> = [];
			let cursor = 0;
			for (const ref of group) {
				parts.push(await this.refAsBlob(ref));
				layout.push({ id: ref.id, from: ref.opfsPath, offset: cursor, length: ref.byteLength });
				cursor += ref.byteLength;
			}

			const newPath = `packs/pack_${crypto.randomUUID()}.bin`;
			await this.opfs.writeFinal(newPath, new Blob(parts));

			report('verifying', 'Verifying pack integrity…');
			const written = await this.opfs.readBlob(newPath);
			if (written.size !== cursor) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc sweeps packs/ */
				}
				throw new VfsError(
					'OPFS_IO',
					`Repack verification failed: expected ${cursor} bytes, wrote ${written.size}`
				);
			}

			let swapped = 0;
			await this.db.transaction('rw', this.db.blobRefs, async () => {
				for (const item of layout) {
					const current = await this.db.blobRefs.get(item.id);
					// Changed underneath us — a concurrent save moved it to its own
					// blob. Leave it there; the new pack simply carries a copy that
					// nothing points at, which the sweep reclaims.
					if (!current || current.opfsPath !== item.from) continue;
					await this.db.blobRefs.put({
						...current,
						opfsPath: newPath,
						packOffset: item.offset
					});
					swapped += 1;
				}
			});
			movedFiles += swapped;
			if (swapped > 0) packs += 1;
			for (const item of layout) retired.add(item.from);
		}

		await this.unlinkUnreferenced(retired);
		report('done', `Packed ${movedFiles} file${movedFiles === 1 ? '' : 's'} into ${packs}`);
		this.emitChange();
		return { packs, movedFiles };
	}

	/** Packs named by the given blob refs — the set a delete may leave dead space in. */
	async packPathsForBlobs(blobIds: Iterable<string>): Promise<string[]> {
		const paths = new Set<string>();
		for (const id of new Set(blobIds)) {
			const ref = await this.db.blobRefs.get(id);
			if (ref?.packOffset != null) paths.add(ref.opfsPath);
		}
		return [...paths];
	}

	async gc(): Promise<GcReport> {
		await this.ready();
		const report: GcReport = {
			orphanOpfsRemoved: 0,
			orphanBlobRefsRemoved: 0,
			unreferencedBlobsRemoved: 0,
			tmpPartialsRemoved: 0,
			expiredLeasesRemoved: 0
		};
		const now = Date.now();
		const nodes = await this.db.nodes.toArray();
		const referenced = new Set(nodes.map((n) => n.blobId).filter(Boolean) as string[]);
		const leases = await this.db.leases.toArray();
		const activeLeases = new Set(
			leases.filter((l) => l.expiresAt > now).map((l) => l.key.replace(/^write:/, ''))
		);

		const refs = await this.db.blobRefs.toArray();
		const namedPaths = new Set<string>();
		for (const ref of refs) {
			namedPaths.add(ref.opfsPath);
			// Promote may have already moved bytes to blobs/<id>.bin while
			// the live row still names tmp/… — treat both as live.
			if (ref.pendingPromote) namedPaths.add(`blobs/${ref.id}.bin`);
		}

		const releasable: string[] = [];
		for (const ref of refs) {
			if (referenced.has(ref.id)) continue;
			if (activeLeases.has(ref.id)) continue;
			const inFlight = !!(ref.pending || ref.pendingPromote);
			if (inFlight && now - ref.createdAt < this.graceMs) continue;
			releasable.push(ref.id);
		}
		if (releasable.length) {
			// Through the one funnel: it drops the rows and unlinks each distinct
			// path once, so a shared-storage layout cannot turn this sweep into a
			// mass delete of live siblings.
			await this.releaseBlobRefs(releasable);
			report.orphanBlobRefsRemoved += releasable.length;
			report.unreferencedBlobsRemoved += releasable.length;
		}

		// tmp GC — never unlink a path a blobRef still names
		const tmps = await this.opfs.listTmp();
		for (const t of tmps) {
			if (namedPaths.has(t.path)) continue;
			const age = t.mtimeMs != null ? now - t.mtimeMs : this.graceMs + 1;
			if (age > this.graceMs) {
				try {
					await this.opfs.remove(t.path);
					report.tmpPartialsRemoved++;
				} catch {
					/* ignore */
				}
			}
		}

		// expired leases
		for (const l of leases) {
			if (l.expiresAt <= now) {
				await this.db.leases.delete(l.key);
				report.expiredLeasesRemoved++;
			}
		}

		// OPFS orphans under blobs/ and packs/.
		//
		// A pack holds many members, so a crashed pack write leaks the whole
		// file at once rather than a single blob — it has to be swept. Its
		// filename is a packId, not a blobId, so the blobId-derived lease check
		// below cannot protect it; a pack in flight is protected instead by the
		// pending blobRefs its reserve txn wrote, which are already in
		// `namedPaths`.
		for (const prefix of ['blobs', 'packs']) {
			try {
				const found = await this.opfs.listOrphans(prefix);
				for (const p of found) {
					if (namedPaths.has(p)) continue;
					if (prefix === 'blobs') {
						const blobId = p.replace(/^blobs\//, '').replace(/\.bin$/, '');
						if (activeLeases.has(blobId)) continue;
					}
					try {
						await this.opfs.remove(p);
						report.orphanOpfsRemoved++;
					} catch {
						/* ignore */
					}
				}
			} catch {
				/* ignore */
			}
		}

		return report;
	}

	/** Test helper: wipe everything */
	async dangerClearAll(): Promise<void> {
		await this.ready();
		await this.db.transaction(
			'rw',
			this.db.nodes,
			this.db.blobRefs,
			this.db.drafts,
			this.db.meta,
			this.db.leases,
			async () => {
				await this.db.nodes.clear();
				await this.db.blobRefs.clear();
				await this.db.drafts.clear();
				await this.db.meta.clear();
				await this.db.leases.clear();
			}
		);
		if (this.opfs.clearAll) await this.opfs.clearAll();
		this.emitChange();
	}
}

let singleton: VfsService | null = null;

export function createVfs(opts?: VfsServiceOptions): VfsService {
	return new VfsService(opts);
}

export function getSharedVfs(opts?: VfsServiceOptions): VfsService {
	if (!singleton) singleton = new VfsService(opts);
	return singleton;
}

export function resetSharedVfsForTests(): void {
	singleton = null;
}

export function isActionable(node: VfsNode, accept?: FileTypeId[]): boolean {
	if (node.kind === 'folder') return true;
	if (!accept || accept.length === 0) return true;
	return !!node.fileType && accept.includes(node.fileType);
}
