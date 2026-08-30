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
import { crc32 } from './crc32.js';

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
	if (typeof blob.arrayBuffer === 'function') {
		return new Uint8Array(await blob.arrayBuffer());
	}
	const bytes = (blob as Blob & { bytes?: () => Promise<Uint8Array> }).bytes;
	if (typeof bytes === 'function') return bytes.call(blob);
	if (typeof Response !== 'undefined') {
		return new Uint8Array(await new Response(blob).arrayBuffer());
	}
	throw new VfsError('OPFS_IO', 'Blob has no arrayBuffer()');
}
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

/**
 * Lease key for the exclusive right to rewrite one pack.
 *
 * Namespaced away from `write:<blobId>` because gc reads that prefix off to
 * decide which blobs are still being written; a pack path must never be
 * mistaken for a blob id.
 */
function packClaimKey(packPath: string): string {
	return `compact:${packPath}`;
}

/** Lease on a dest pack/blob path that does not yet have a blobRef naming it. */
function packWriteKey(opfsPath: string): string {
	return `packwrite:${opfsPath}`;
}

/**
 * Tests inject a crash between compact phases. Production leaves this null.
 * after-write: dest bytes exist, no refs yet. after-swap: refs name dest, old still there.
 */
export type CompactCrashPhase = 'after-write' | 'after-swap' | 'before-unlink';
export const compactCrash = {
	hook: null as ((phase: CompactCrashPhase, newPath: string, oldPath: string) => Promise<void>) | null
};

/** Exclusive Web Lock. If the API is missing, run anyway. Never re-invoke `fn` after it threw. */
export async function withWebLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const locks = (globalThis as { navigator?: { locks?: { request: Function } } }).navigator?.locks;
	if (!locks?.request) return fn();
	let started = false;
	try {
		return await locks.request(name, { mode: 'exclusive' }, () => {
			started = true;
			return fn();
		});
	} catch (e) {
		if (started) throw e;
		return fn();
	}
}

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

export type CompactPacksResult = {
	compactedPacks: number;
	reclaimedBytes: number;
	/** Packs skipped because a claim/pending/IO blocked a delete-time compact. */
	failedPacks: string[];
};

export type EmptyTrashResult = {
	deleted: number;
	compactedPacks: number;
	reclaimedBytes: number;
	/**
	 * Packs that could not be compacted before the drop.
	 *
	 * Compaction runs FIRST (C3). Members whose pack is listed here are left in
	 * the trash rather than deleted, so a busy or pending rewrite cannot strand
	 * survivors on a pack that this tab then unlinks.
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
	/**
	 * Instance hook for e2e (Vite may load a second module copy of vfs.ts).
	 * Unit tests can still assign `compactCrash.hook`.
	 */
	compactCrashHook: typeof compactCrash.hook = null;
	/** Nested: suppress explorer/git notify until the outer dump/commit ends. */
	private changeMute = 0;
	private changeMutedDirty = false;

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
		if (this.changeMute > 0) {
			this.changeMutedDirty = true;
			return;
		}
		this.changeBus.notify();
		notifyTabChannel(this.tabChannelName());
	}

	/**
	 * Run a dump/commit without notifying listeners per inner write.
	 * One notify fires if anything changed, when the outermost batch ends.
	 */
	async batch<T>(fn: () => Promise<T>): Promise<T> {
		this.changeMute += 1;
		try {
			return await fn();
		} finally {
			this.changeMute -= 1;
			if (this.changeMute === 0 && this.changeMutedDirty) {
				this.changeMutedDirty = false;
				this.changeBus.notify();
				notifyTabChannel(this.tabChannelName());
			}
		}
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
				// Crash debris belongs to the next session that opens the store,
				// not only the Files page. sweepOnLoad is once-per-instance, so
				// a later mount calling it is a no-op.
				this.sweepOnLoad({ delayMs: 0 });
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
		return this.hidePendingWrites(rows);
	}

	/** Reactive list (Dexie liveQuery). Querier must be async so awaits inside
	 * `list()` stay in Dexie's observation zone. */
	liveList(opts: VfsListOptions): Observable<VfsNode[]> {
		return liveQuery(async () => this.list(opts));
	}

	/**
	 * Reserved packed/standalone writes are live IDB rows with size 0 until
	 * confirm. Listing them looks like a successful empty file; hide them so
	 * copy/git/the explorer cannot persist that empty view.
	 */
	private async hidePendingWrites(rows: VfsNode[]): Promise<VfsNode[]> {
		const blobIds = rows.map((n) => n.blobId).filter((id): id is string => !!id);
		if (!blobIds.length) return rows;
		const refs = await this.db.blobRefs.bulkGet(blobIds);
		const pending = new Set<string>();
		for (const r of refs) {
			if (r?.pending) pending.add(r.id);
		}
		if (!pending.size) return rows;
		return rows.filter((n) => !n.blobId || !pending.has(n.blobId));
	}

	async get(id: string): Promise<VfsNode | undefined> {
		await this.ready();
		return this.db.nodes.get(id);
	}

	/**
	 * The one live child of `parentId` named `name`, or undefined.
	 *
	 * Exists because "does this folder contain X?" is the hot operation in path
	 * resolution, and answering it by listing every sibling makes any repeated
	 * walk quadratic in directory size. Uses [parentKey+name], which covers the
	 * root as well as ordinary folders.
	 *
	 * Trashed nodes are skipped: a path names a live file, and a deleted one
	 * must not shadow a new file that reuses its name.
	 */
	async childByName(parentId: string | null, name: string): Promise<VfsNode | undefined> {
		await this.ready();
		const node = await this.db.nodes
			.where('[parentKey+name]')
			.equals([parentId ?? ROOT_PARENT_KEY, name])
			.and((n) => n.deletedAt == null)
			.first();
		if (!node) return undefined;
		if (await this.isPendingBlob(node.blobId)) return undefined;
		return node;
	}

	private async isPendingBlob(blobId: string | undefined): Promise<boolean> {
		if (!blobId) return false;
		const ref = await this.db.blobRefs.get(blobId);
		return !!ref?.pending;
	}

	private async throwIfPendingBlob(blobId: string | undefined, nodeId?: string): Promise<void> {
		if (await this.isPendingBlob(blobId)) {
			throw new VfsError('WRITE_IN_FLIGHT', 'File is still being written', { nodeId, blobId });
		}
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

	/**
	 * Create missing folders for many relative paths in a few IDB writes.
	 *
	 * Extract/git dumps were paying `list()` + `mkdir` per directory. Paths are
	 * segment arrays relative to `parentId` (`[['src','lib'], ['docs']]`).
	 * Existing folders are reused (childByName, not a full listing).
	 */
	async ensureFolders(
		parentId: string | null,
		paths: Iterable<string[]>,
		opts?: { signal?: AbortSignal }
	): Promise<Map<string, string | null>> {
		await this.ready();
		const map = new Map<string, string | null>([['', parentId]]);
		const byDepth: string[][][] = [];
		const seen = new Set<string>();
		for (const raw of paths) {
			const segs = raw.map((s) => sanitizeName(s)).filter(Boolean);
			for (let i = 1; i <= segs.length; i++) {
				const slice = segs.slice(0, i);
				const key = slice.join('/');
				if (seen.has(key)) continue;
				seen.add(key);
				(byDepth[i - 1] ??= []).push(slice);
			}
		}
		if (!byDepth.length) return map;

		return this.batch(async () => {
			for (const level of byDepth) {
				throwIfAborted(opts?.signal);
				const grouped = new Map<string, string[][]>();
				for (const segs of level) {
					const parentKey = segs.slice(0, -1).join('/');
					const g = grouped.get(parentKey);
					if (g) g.push(segs);
					else grouped.set(parentKey, [segs]);
				}
				for (const [parentKey, children] of grouped) {
					const pid = map.get(parentKey);
					if (pid === undefined) {
						throw new VfsError('NOT_FOUND', `Missing parent folder ${parentKey}`);
					}
					if (pid !== null) {
						const parent = await this.db.nodes.get(pid);
						if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
						if (parent.deletedAt != null) throw new VfsError('TRASH_STATE');
					}
					const siblings = await this.activeSiblings(pid);
					const folderByName = new Map(
						siblings.filter((n) => n.kind === 'folder').map((n) => [n.name, n])
					);
					const taken = new Set(siblings.map((n) => n.name.toLowerCase()));
					const toCreate: VfsNode[] = [];
					let sortOrder = await this.nextAppendSortOrder(pid);
					const now = Date.now();
					for (const segs of children) {
						const name = segs[segs.length - 1]!;
						const key = segs.join('/');
						const hit = folderByName.get(name);
						if (hit) {
							map.set(key, hit.id);
							continue;
						}
						const fileHit = siblings.find((n) => n.name === name && n.kind === 'file');
						if (fileHit) {
							throw new VfsError('NAME_CONFLICT', `A file named ${name} already exists`);
						}
						let unique = name;
						if (taken.has(unique.toLowerCase())) {
							let i = 1;
							while (taken.has(withNumericSuffix(name, i).toLowerCase())) i++;
							unique = withNumericSuffix(name, i);
						}
						taken.add(unique.toLowerCase());
						const node: VfsNode = {
							id: generateId('fld'),
							parentId: pid,
							name: unique,
							kind: 'folder',
							createdAt: now,
							updatedAt: now,
							generation: 1,
							deletedAt: null,
							sortOrder
						};
						sortOrder += 16384;
						toCreate.push(node);
						folderByName.set(unique, node);
						map.set(key, node.id);
					}
					if (toCreate.length) await this.db.nodes.bulkPut(toCreate);
				}
			}
			return map;
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

		const sameName =
			input.parentId === null
				? (await this.activeSiblings(null)).find((n) => n.name === name)
				: await this.db.nodes
						.where('[parentId+name]')
						.equals([input.parentId, name])
						.and((n) => n.deletedAt == null)
						.first();
		if (sameName?.kind === 'file') {
			await this.throwIfPendingBlob(sameName.blobId, sameName.id);
		}

		// Overwrite-in-place: a live sibling file with this exact name is replaced
		// (same id/parent, new bytes, generation bump so bound docs elsewhere see
		// GENERATION_CONFLICT). A same-name folder is not a valid overwrite target.
		if (input.onConflict === 'overwrite') {
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
		const direct = input.direct === true;
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
				opfsPath: direct ? finalPath : tmpPath,
				byteLength: 0,
				createdAt: now,
				contentType,
				pending: true,
				pendingPromote: !direct
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
			if (direct) {
				await this.opfs.writeFinal(finalPath, bytes);
				await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, this.db.leases, async () => {
					if (input.parentId) {
						const parent = await this.db.nodes.get(input.parentId);
						if (!parent || parent.kind !== 'folder' || parent.deletedAt != null) {
							throw new VfsError('TRASH_STATE');
						}
					}
					const ref = await this.db.blobRefs.get(blobId);
					if (ref) {
						ref.opfsPath = finalPath;
						ref.byteLength = bytes.byteLength;
						ref.pending = false;
						ref.pendingPromote = false;
						ref.crc32 = crc32(bytes);
						await this.db.blobRefs.put(ref);
					}
					const node = await this.db.nodes.get(nodeId);
					if (!node) throw new VfsError('NOT_FOUND');
					node.size = bytes.byteLength;
					node.updatedAt = Date.now();
					await this.db.nodes.put(node);
					await this.db.leases.delete(leaseKey);
				});
			} else {
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
					ref.crc32 = crc32(bytes);
					await this.db.blobRefs.put(ref);
				}
				await this.db.leases.delete(leaseKey);
			});
			}
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
		return this.batch(async () => {
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

		// Chunks overlap, but only from the byte-writing stage onward.
		//
		// The reserve transaction reads and allocates sibling names, so running
		// two of those at once against one folder would hand out the same
		// `dup (1).txt` twice. `reserveChain` keeps them strictly ordered while
		// the writes — which are the slow part, and touch disjoint blobs — run
		// together.
		//
		// In-flight bytes are capped at one chunk's budget rather than a chunk
		// COUNT, because a chunk can be up to a quarter of free storage: many
		// small chunks overlap freely, one enormous one does not, and heap
		// stays bounded either way.
		let reserveChain: Promise<void> = Promise.resolve();
		const inFlight = new Set<Promise<void>>();
		const ordered: VfsNode[][] = [];
		let inFlightBytes = 0;

		const flush = async () => {
			if (!chunk.length) return;
			if (opts?.signal?.aborted) {
				const e = new Error('Cancelled');
				e.name = 'AbortError';
				throw e;
			}
			const group = chunk;
			const groupBytes = chunkBytes;
			chunk = [];
			chunkBytes = 0;

			const slot = ordered.length;
			ordered.push([]);
			const waitFor = reserveChain;
			let release!: () => void;
			reserveChain = new Promise<void>((r) => (release = r));

			// Wait BEFORE starting this chunk so in-flight bytes stay at one
			// budget, not two overlapping max packs. An empty set still starts
			// even when this group is the full budget.
			while (inFlight.size > 0 && inFlightBytes + groupBytes > CHUNK_BYTES) {
				await Promise.race(inFlight);
			}
			inFlightBytes += groupBytes;
			const task = (async () => {
				await waitFor;
				try {
					ordered[slot] = await this.writeFilesChunk(
						group,
						opts?.signal,
						opts?.pack === true,
						release
					);
				} finally {
					// Idempotent, and mandatory: a chunk that throws before its
					// reserve commits would otherwise leave every later chunk
					// waiting on a promise nothing resolves.
					release();
				}
				opts?.onProgress?.(ordered[slot]!);
			})();
			const tracked = task.finally(() => {
				inFlight.delete(tracked);
				inFlightBytes -= groupBytes;
			});
			inFlight.add(tracked);
			// Swallow here only so an early rejection cannot surface as an
			// unhandled rejection; it is re-thrown by the awaits below.
			tracked.catch(() => {});
		};

		try {
			for (const input of inputs) {
				const { bytes, contentType } = await serializeBody(input.body, input.contentType);
				chunk.push({ input, bytes, contentType });
				chunkBytes += bytes.byteLength;
				if (chunk.length >= CHUNK_FILES || chunkBytes >= CHUNK_BYTES) await flush();
			}
			await flush();
			await Promise.all(inFlight);
		} catch (e) {
			// Let the rest settle before rethrowing, so a failure does not leave
			// writes running against a store the caller thinks it is done with.
			await Promise.allSettled(inFlight);
			throw e;
		}
		for (const group of ordered) out.push(...group);
		return out;
		});
	}

	/** One reserve→blob-write→confirm cycle for a batch of files. */
	private async writeFilesChunk(
		inputs: Array<{ input: WriteFileInput; bytes: Uint8Array; contentType: string }>,
		signal?: AbortSignal,
		pack = false,
		/**
		 * Fired the instant the reserve transaction commits.
		 *
		 * That transaction is where sibling names are read and allocated, so it
		 * has to stay strictly ordered between chunks — two chunks writing into
		 * one folder would otherwise both hand out `dup (1).txt`. Everything
		 * after it is byte writing, which is the slow part and safe to overlap.
		 */
		onReserved?: () => void
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
		let packPathToUnlink: string | undefined;
		let heldPackPath: string | undefined;
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
			if (packPathToUnlink) {
				try {
					await this.opfs.remove(packPathToUnlink);
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
			if (packedIndexes.size) packPathToUnlink = packPath;
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
			// Names are settled and committed, so the next chunk may start its
			// own reserve while this one writes bytes.
			onReserved?.();
			// The pack is ONE write for every member in it. Blob assembly is
			// zero-copy (a reference list), so this does not duplicate the
			// chunk in memory. Refs stay pending until the confirm txn, so no
			// reader can reach a half-written pack.
			if (packedIndexes.size) {
				if (signal?.aborted) throw abortError();
				heldPackPath = packPath;
				await this.holdPackWrite(packPath);
				const payload = new Uint8Array(packBytes);
				for (const m of packMembers) {
					if (!packedIndexes.has(m.index)) continue;
					payload.set(prepared[m.index]!.bytes, m.offset);
				}
				const written = await this.opfs.writeAtomic(packPath, payload);
				if (written.byteLength !== packBytes) {
					throw new VfsError(
						'OPFS_IO',
						`Pack write short: expected ${packBytes} bytes, wrote ${written.byteLength}`
					);
				}
				const onDisk = await this.opfs.readBlob(packPath);
				if (onDisk.size !== packBytes) {
					throw new VfsError(
						'OPFS_IO',
						`Pack write short: expected ${packBytes} bytes, disk has ${onDisk.size}`
					);
				}
				for (const m of packMembers) {
					if (!packedIndexes.has(m.index)) continue;
					const expected = crc32(prepared[m.index]!.bytes);
					await this.checksumSlice(
						packPath,
						m.offset,
						prepared[m.index]!.bytes.byteLength,
						expected
					);
				}
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
								pendingPromote: false,
								crc32: crc32(r.p.bytes),
								packGeneration: packedIndexes.has(i) ? 1 : undefined
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
			packPathToUnlink = undefined;
		} catch (e) {
			await cleanup();
			throw e;
		} finally {
			if (heldPackPath) await this.dropPackWrite(heldPackPath);
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
			await this.unlinkIfOrphanNow(path);
		}
	}

	/**
	 * Re-stat immediately before unlink so a dest/pack born after gc's snapshot
	 * is not deleted out from under a live compact or writeFiles confirm.
	 */
	private async unlinkIfOrphanNow(path: string): Promise<boolean> {
		const now = Date.now();
		const packLease = await this.db.leases.get(packWriteKey(path));
		if (packLease && packLease.expiresAt > now) return false;
		const named = await this.db.blobRefs.where('opfsPath').equals(path).first();
		if (named) return false;
		if (path.startsWith('blobs/')) {
			const blobId = path.replace(/^blobs\//, '').replace(/\.bin$/, '');
			const writeLease = await this.db.leases.get(`write:${blobId}`);
			if (writeLease && writeLease.expiresAt > now) return false;
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.opfs.remove(path);
				return true;
			} catch {
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
				}
			}
		}
		return false;
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
		await this.throwIfPendingBlob(node.blobId, id);

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

			try {
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
						ref.crc32 = crc32(bytes);
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
				// Promote already moved bytes to the final path. Put them back
				// so IDB (still naming tmp) and OPFS agree, then the outer
				// cleanup can drop both.
				try {
					await this.opfs.promote(finalPath, tmpPath!);
				} catch {
					/* read path still falls back blobs/<id>.bin */
				}
				throw e;
			}
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
		const ref = await this.loadReadableRef(node.blobId, nodeId);
		if (ref.packOffset != null) {
			const slice = await this.readPacked(ref);
			const bytes = await blobToBytes(slice);
			this.assertMemberChecksum(ref, bytes);
			return bytes;
		}
		if (ref.pendingPromote) {
			try {
				return this.assertMemberChecksum(ref, await this.opfs.read(ref.opfsPath));
			} catch (e) {
				const alt = `blobs/${ref.id}.bin`;
				if (alt !== ref.opfsPath && (await this.opfs.exists(alt))) {
					return this.assertMemberChecksum(ref, await this.opfs.read(alt));
				}
				throw e;
			}
		}
		return this.assertMemberChecksum(ref, await this.opfs.read(ref.opfsPath));
	}

	private async loadReadableRef(blobId: string, nodeId?: string): Promise<BlobRef> {
		const ref = await this.db.blobRefs.get(blobId);
		if (!ref) throw new VfsError('OPFS_IO', 'Missing blobRef', { nodeId, blobId });
		if (ref.pending) {
			throw new VfsError('WRITE_IN_FLIGHT', 'File is still being written', { nodeId, blobId });
		}
		return ref;
	}

	private assertMemberChecksum(ref: BlobRef, bytes: Uint8Array): Uint8Array {
		if (ref.crc32 != null && crc32(bytes) !== ref.crc32) {
			throw new VfsError(
				'OPFS_IO',
				`Checksum mismatch for blob ${ref.id} at ${ref.opfsPath}:${ref.packOffset ?? 0}`
			);
		}
		return bytes;
	}

	private async checksumSlice(
		opfsPath: string,
		offset: number,
		length: number,
		expected?: number
	): Promise<number> {
		const all = await this.opfs.read(opfsPath);
		const bytes = all.subarray(offset, offset + length);
		if (bytes.byteLength !== length) {
			throw new VfsError(
				'OPFS_IO',
				`Short pack read from ${opfsPath}: got ${bytes.byteLength} of ${length} at ${offset}`
			);
		}
		const got = crc32(bytes);
		if (expected != null && got !== expected) {
			throw new VfsError(
				'OPFS_IO',
				`Checksum mismatch at ${opfsPath}:${offset}`
			);
		}
		return got;
	}

	/** Flatten Blob parts; some test Blobs do not concatenate. */
	private async materializePack(parts: BlobPart[], expected: number): Promise<Uint8Array> {
		const out = new Uint8Array(expected);
		let offset = 0;
		for (const part of parts) {
			const bytes =
				part instanceof Uint8Array
					? part
					: await blobToBytes(part as Blob);
			if (offset + bytes.byteLength > expected) {
				throw new VfsError(
					'OPFS_IO',
					`Pack assembly overflow: ${offset}+${bytes.byteLength} > ${expected}`
				);
			}
			out.set(bytes, offset);
			offset += bytes.byteLength;
		}
		if (offset !== expected) {
			throw new VfsError(
				'OPFS_IO',
				`Pack assembly short: expected ${expected} bytes, assembled ${offset}`
			);
		}
		return out;
	}

	/**
	 * One member out of a shared pack file. Lazy where the store supports it,
	 * so pulling a 40KB member out of a 64MB pack costs a slice rather than a
	 * full read.
	 */
	private async readPacked(ref: BlobRef, contentType?: string): Promise<Blob> {
		try {
			return await this.readPackedOnce(ref, contentType);
		} catch (e) {
			const latest = await this.db.blobRefs.get(ref.id);
			if (
				latest &&
				!latest.pending &&
				(latest.opfsPath !== ref.opfsPath ||
					latest.packOffset !== ref.packOffset ||
					latest.packGeneration !== ref.packGeneration)
			) {
				return this.readPackedOnce(latest, contentType);
			}
			throw e;
		}
	}

	private async readPackedOnce(ref: BlobRef, contentType?: string): Promise<Blob> {
		if (ref.pending) {
			throw new VfsError('WRITE_IN_FLIGHT', 'File is still being written', { blobId: ref.id });
		}
		const offset = ref.packOffset ?? 0;
		if (this.opfs.readRange) {
			const slice = await this.opfs.readRange(ref.opfsPath, offset, ref.byteLength, contentType);
			if (slice.size !== ref.byteLength) {
				throw new VfsError(
					'OPFS_IO',
					`Short pack read from ${ref.opfsPath}: got ${slice.size} of ${ref.byteLength} at ${offset}`
				);
			}
			return slice;
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
		if (view.byteLength !== ref.byteLength) {
			throw new VfsError(
				'OPFS_IO',
				`Short pack read from ${ref.opfsPath}: got ${view.byteLength} of ${ref.byteLength} at ${offset}`
			);
		}
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
		const ref = await this.loadReadableRef(node.blobId);
		const contentType = node.contentType ?? ref.contentType;
		if (ref.packOffset != null) {
			const slice = await this.readPacked(ref, contentType);
			const bytes = await blobToBytes(slice);
			this.assertMemberChecksum(ref, bytes);
			return new Blob([bytes as BlobPart], { type: contentType ?? 'application/octet-stream' });
		}
		if (ref.pendingPromote) {
			try {
				return this.opfs.readBlob(ref.opfsPath, contentType);
			} catch (e) {
				const alt = `blobs/${ref.id}.bin`;
				if (alt !== ref.opfsPath && (await this.opfs.exists(alt))) {
					return this.opfs.readBlob(alt, contentType);
				}
				throw e;
			}
		}
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
		const nodeIds: string[] = [];

		const node = await this.db.nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		const toDelete: VfsNode[] = [node];
		if (node.kind === 'folder') {
			if (!recursive) {
				const firstChild = await this.db.nodes.where('parentId').equals(id).first();
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
			nodeIds.push(n.id);
			if (n.blobId) blobIds.push(n.blobId);
		}

		const touchedPacks = await this.packPathsForBlobs(blobIds);
		if (opts?.compact !== false && touchedPacks.length) {
			const alive: string[] = [];
			for (const p of touchedPacks) {
				if (await this.opfs.exists(p)) alive.push(p);
			}
			const compacted = await this.compactPacks(alive, { excludeBlobIds: blobIds });
			if (compacted.failedPacks.length) {
				throw new VfsError(
					'WRITE_IN_FLIGHT',
					`Cannot delete: pack still being rewritten (${compacted.failedPacks.join(', ')})`
				);
			}
		}

		await this.db.transaction('rw', this.db.nodes, async () => {
			for (const nid of nodeIds) {
				const cur = await this.db.nodes.get(nid);
				if (cur) await this.db.nodes.delete(nid);
			}
		});
		await this.releaseBlobRefs(blobIds);
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

		let compactedPacks = 0;
		let reclaimedBytes = 0;
		let failedPacks: string[] = [];
		let deletedIds: string[] = [];
		let deletedBlobIds: string[] = [];
		let nodeCount = 0;

		try {
			const dropIds: string[] = [];
			for (const n of trashed) {
				const cur = await this.db.nodes.get(n.id);
				if (cur?.deletedAt != null && cur.blobId) dropIds.push(cur.blobId);
			}
			if (!opts?.skipCompaction && touchedPacks.size) {
				const stillThere: string[] = [];
				for (const p of touchedPacks) {
					if (await this.opfs.exists(p)) stillThere.push(p);
				}
				const res = await this.compactPacks(stillThere, {
					excludeBlobIds: dropIds,
					onProgress: opts?.onPackProgress,
					signal: opts?.signal
				});
				compactedPacks = res.compactedPacks;
				reclaimedBytes = res.reclaimedBytes;
				failedPacks = res.failedPacks;
			}

			const blockedPacks = new Set(failedPacks);
			await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, async () => {
				const still: VfsNode[] = [];
				for (const n of trashed) {
					const cur = await this.db.nodes.get(n.id);
					if (!cur || cur.deletedAt == null) continue;
					if (cur.blobId) {
						const ref = await this.db.blobRefs.get(cur.blobId);
						if (ref?.opfsPath && blockedPacks.has(ref.opfsPath)) continue;
					}
					still.push(cur);
				}
				deletedIds = still.map((n) => n.id);
				deletedBlobIds = [
					...new Set(still.map((n) => n.blobId).filter((id): id is string => !!id))
				];
				if (deletedIds.length) await this.db.nodes.bulkDelete(deletedIds);
				if (deletedBlobIds.length) await this.db.blobRefs.bulkDelete(deletedBlobIds);
			});
		const deletedBlobSet = new Set(deletedBlobIds);
		const releasedPaths = opfsPaths.filter((_, i) => {
			const bid = uniqueBlobIds[i];
			return bid != null && deletedBlobSet.has(bid);
		});
		nodeCount = deletedIds.length;
		const blobCount = releasedPaths.length;
		const total = Math.max(nodeCount + blobCount, 1);
		opts?.onProgress?.({ done: 0, total, name: 'Emptying trash…' });
		throwIfAborted(opts?.signal);
			opts?.onProgress?.({ done: nodeCount, total, name: 'Emptying trash…' });
			await yieldPaint();

			// Unlink one distinct path at a time so progress stays per file and
			// the op remains cancellable. Ref rows were already dropped in the
			// txn above, so this is the release half of releaseBlobRefs, kept
			// inline for the progress/abort contract — including its survivor
			// check: emptying the trash must never take storage that a file
			// still outside the trash is sharing.
			const seen = new Set<string>();
			for (let i = 0; i < releasedPaths.length; i++) {
				throwIfAborted(opts?.signal);
				const item = releasedPaths[i]!;
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

			// Compaction ran before the delete (C3: compact failure fails the
			// empty). Unlink above only drops packs nothing still names.
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

	/**
	 * Restore a pack whole, with refs pointing into it at recorded offsets.
	 *
	 * The counterpart of `migratePutBlob` for pack-preserving import: the whole
	 * point of that format is that a project of thousands of files is a handful
	 * of pack blobs, so importing it must not re-extract every member.
	 *
	 * Offsets come from the bundle that was exported, and the pack is written
	 * before any ref names it — a crash in between leaves an unreferenced pack
	 * for the sweep, never a ref pointing at bytes that are not there.
	 */
	async migratePutPack(
		packPath: string,
		body: Blob | BufferSource,
		members: Array<{
			blobId: string;
			offset: number;
			byteLength: number;
			contentType?: string;
		}>
	): Promise<void> {
		await this.ready();
		const { byteLength } = await this.opfs.writeFinal(packPath, body as never);
		for (const m of members) {
			if (m.offset + m.byteLength > byteLength) {
				throw new VfsError(
					'OPFS_IO',
					`Pack member runs past the end of ${packPath}: ${m.offset}+${m.byteLength} > ${byteLength}`
				);
			}
		}
		await this.db.blobRefs.bulkPut(
			members.map((m) => ({
				id: m.blobId,
				opfsPath: packPath,
				packOffset: m.offset,
				byteLength: m.byteLength,
				createdAt: Date.now(),
				contentType: m.contentType ?? 'application/octet-stream'
			}))
		);
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
		// A pending ref's byteLength is 0 because the bytes have not landed yet,
		// NOT because the member is dead. A pack still being written therefore
		// looks 100% dead to the arithmetic below — and a sweep that believed
		// that would "reclaim" the whole live pack out from under the write.
		// That is the one state compaction must never touch.
		const inFlight = new Set<string>();
		for (const r of refs) {
			if (r.packOffset == null) continue;
			if (r.pending) inFlight.add(r.opfsPath);
			liveByPack.set(r.opfsPath, (liveByPack.get(r.opfsPath) ?? 0) + r.byteLength);
		}
		if (!liveByPack.size) return { compactedPacks: 0, reclaimedBytes: 0, failedPacks: [] };

		const candidates: string[] = [];
		for (const [path, live] of liveByPack) {
			if (opts?.signal?.aborted) break;
			if (inFlight.has(path)) continue;
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
		if (!candidates.length) return { compactedPacks: 0, reclaimedBytes: 0, failedPacks: [] };
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
		// Both callers screen for this; the check is repeated at the mutation
		// point because getting it wrong destroys live bytes rather than merely
		// wasting a rewrite.
		if (survivors.some((r) => r.pending)) return 0;

		return withWebLock(`vfs-pack:${packPath}`, () => this.compactOnePackLocked(packPath, survivors, report));
	}

	private async compactOnePackLocked(
		packPath: string,
		survivors: BlobRef[],
		report: (stage: PackOpStage, label: string, bytes?: number) => void
	): Promise<number> {
		const sourceBytes = await this.opfs.read(packPath);
		const before = sourceBytes.byteLength;

		const ordered = [...survivors].sort((a, b) => (a.packOffset ?? 0) - (b.packOffset ?? 0));
		const parts: Uint8Array[] = [];
		const layout: Array<{ id: string; offset: number; length: number }> = [];
		let cursor = 0;
		for (const ref of ordered) {
			const from = ref.packOffset ?? 0;
			parts.push(sourceBytes.subarray(from, from + ref.byteLength));
			layout.push({ id: ref.id, offset: cursor, length: ref.byteLength });
			cursor += ref.byteLength;
		}

		for (const ref of ordered) {
			if (ref.crc32 != null) {
				await this.checksumSlice(packPath, ref.packOffset ?? 0, ref.byteLength, ref.crc32);
			}
		}

		const newPath = `packs/${`pack_${crypto.randomUUID()}`}.bin`;
		await this.holdPackWrite(newPath);
		const stopBeat = this.startLeaseHeartbeat([packWriteKey(newPath), packClaimKey(packPath)]);
		try {
			const written = await this.opfs.writeAtomic(newPath, await this.materializePack(parts, cursor));
			if (written.byteLength !== cursor) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc */
				}
				throw new Error(
					`Pack compaction verification failed: expected ${cursor} bytes, wrote ${written.byteLength}`
				);
			}

			report('verifying', 'Deleting — verifying blob integrity…');
			const onDisk = await this.opfs.readBlob(newPath);
			if (onDisk.size !== cursor) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc sweeps packs/ */
				}
				throw new Error(
					`Pack compaction verification failed: expected ${cursor} bytes, wrote ${onDisk.size}`
				);
			}
			for (const item of layout) {
				const src = ordered.find((r) => r.id === item.id);
				await this.checksumSlice(newPath, item.offset, item.length, src?.crc32);
			}
			await this.runCompactCrash('after-write', newPath, packPath);

			if (!(await this.leaseStillHeld(packWriteKey(newPath)))) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc */
				}
				throw new VfsError(
					'WRITE_IN_FLIGHT',
					`Pack dest ${newPath} lease expired before swap`
				);
			}

			let swapped = 0;
			await this.db.transaction('rw', this.db.blobRefs, async () => {
				for (const item of layout) {
					const current = await this.db.blobRefs.get(item.id);
					if (!current || current.opfsPath !== packPath || current.pending) continue;
					await this.db.blobRefs.put({
						...current,
						opfsPath: newPath,
						packOffset: item.offset,
						packGeneration: (current.packGeneration ?? 0) + 1
					});
					swapped += 1;
				}
			});

			await this.runCompactCrash('after-swap', newPath, packPath);

			const stillNamed = await this.db.blobRefs.where('opfsPath').equals(packPath).first();
			if (stillNamed) {
				console.warn(
					`[vfs] pack ${packPath} still has live references after compaction; ` +
						'keeping it. Space will be reclaimed on a later delete.'
				);
				// Compact-before-delete leaves the soon-to-drop members on the
				// old pack on purpose. Count the rewrite so the caller knows it
				// happened; the old file goes away when those refs are released.
				return swapped > 0 ? Math.max(0, before - cursor) : 0;
			}
			await this.runCompactCrash('before-unlink', newPath, packPath);
			try {
				await this.opfs.remove(packPath);
			} catch {
				/* gc sweeps packs/ */
			}
			return Math.max(0, before - cursor);
		} finally {
			stopBeat();
			await this.dropPackWrite(newPath);
		}
	}

	private leaseTtlMs(): number {
		return Math.max(this.graceMs, 60_000);
	}

	private async holdPackWrite(opfsPath: string): Promise<void> {
		await this.db.leases.put({
			key: packWriteKey(opfsPath),
			owner: generateId('packw'),
			expiresAt: Date.now() + this.leaseTtlMs()
		});
	}

	private async leaseStillHeld(key: string): Promise<boolean> {
		const row = await this.db.leases.get(key);
		return !!row && row.expiresAt > Date.now();
	}

	/** Renew live leases; never resurrect an expired one. */
	private startLeaseHeartbeat(keys: string[]): () => void {
		const ttl = () => this.leaseTtlMs();
		const tick = async () => {
			const now = Date.now();
			for (const key of keys) {
				const row = await this.db.leases.get(key);
				if (!row || row.expiresAt <= now) continue;
				await this.db.leases.put({ ...row, expiresAt: now + ttl() });
			}
		};
		const iv = setInterval(() => void tick().catch(() => {}), 15_000);
		(iv as unknown as { unref?: () => void }).unref?.();
		void tick().catch(() => {});
		return () => clearInterval(iv);
	}

	private async runCompactCrash(
		phase: CompactCrashPhase,
		newPath: string,
		oldPath: string
	): Promise<void> {
		const hook = this.compactCrashHook ?? compactCrash.hook;
		if (hook) await hook(phase, newPath, oldPath);
	}

	private async dropPackWrite(opfsPath: string): Promise<void> {
		try {
			await this.db.leases.delete(packWriteKey(opfsPath));
		} catch {
			/* expires on its own */
		}
	}

	/**
	 * Take the exclusive right to rewrite one pack, or report that someone else
	 * holds it.
	 *
	 * Same mechanism `maybeGc` uses for `gc:run` — the lease table, claimed
	 * inside a transaction so two tabs cannot both read "free" and both write.
	 * Returns false when the pack is already being rewritten, which is not an
	 * error: the work is being done, just not here.
	 */
	private async claimPack(packPath: string, owner: string): Promise<boolean> {
		const key = packClaimKey(packPath);
		try {
			return await this.db.transaction('rw', this.db.leases, async () => {
				const now = Date.now();
				const held = await this.db.leases.get(key);
				if (held && held.expiresAt > now) return false;
				await this.db.leases.put({
					key,
					owner,
					expiresAt: now + this.leaseTtlMs()
				});
				return true;
			});
		} catch {
			// A claim we cannot take is a compaction we do not run. Deferring
			// costs disk space; guessing costs live bytes.
			return false;
		}
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
	 *
	 * Each pack is claimed for the duration, per pack rather than globally.
	 * `sweepOnLoad` runs this on every load, so two tabs opening together would
	 * otherwise rewrite the same pack at once: the loser's swap finds every ref
	 * already repointed at the winner's new pack, skips them all, and leaves the
	 * pack it just wrote referenced by nothing — an orphan, with every live file
	 * healthy, which is exactly the state that is hardest to explain from the
	 * outside. Claiming per pack rather than taking one global lock keeps a
	 * delete's compaction from being skipped just because an idle sweep is busy
	 * elsewhere. The claim expires on its own if the tab holding it dies, and
	 * `gc()` sweeps expired leases.
	 */
	async compactPacks(
		packPaths: Iterable<string>,
		opts?: {
			onProgress?: (ev: PackOpProgress) => void;
			signal?: AbortSignal;
			/** Compact as if these members were already gone (delete-fails-if-compact-fails). */
			excludeBlobIds?: Iterable<string>;
		}
	): Promise<CompactPacksResult> {
		await this.ready();
		const report = (stage: PackOpStage, label: string, reclaimedBytes?: number) =>
			opts?.onProgress?.({ stage, label, reclaimedBytes });
		const exclude = new Set(opts?.excludeBlobIds ?? []);
		const deleting = exclude.size > 0;

		let compactedPacks = 0;
		let reclaimedBytes = 0;
		const failedPacks: string[] = [];
		const owner = generateId('compact');
		for (const packPath of new Set(packPaths)) {
			if (opts?.signal?.aborted) break;
			// Claimed BEFORE the survivors are read: a claim taken afterwards
			// would still let two tabs plan the same rewrite from the same
			// snapshot, which is the whole race.
			if (!(await this.claimPack(packPath, owner))) {
				if (deleting) failedPacks.push(packPath);
				continue;
			}
			const stopBeat = this.startLeaseHeartbeat([packClaimKey(packPath)]);
			try {
				// Survivors decide the outcome: none means releaseBlobRefs already
				// unlinked the file and there is nothing to compact.
				const all = await this.db.blobRefs.where('opfsPath').equals(packPath).toArray();
				const survivors = exclude.size ? all.filter((r) => !exclude.has(r.id)) : all;
				if (!survivors.length) continue;
				// Mid-write: byteLength is 0 until the confirm txn, so the dead-space
				// sum below would read the whole pack as garbage. Leave it alone.
				if (survivors.some((r) => r.pending)) {
					if (deleting) failedPacks.push(packPath);
					continue;
				}

				let onDisk = 0;
				try {
					onDisk = (await this.opfs.readBlob(packPath)).size;
				} catch {
					if (deleting) failedPacks.push(packPath);
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
			} finally {
				stopBeat();
				try {
					await this.db.leases.delete(packClaimKey(packPath));
				} catch {
					/* the claim expires on its own */
				}
			}
		}
		return { compactedPacks, reclaimedBytes, failedPacks };
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
			// Mid-write: byteLength is 0 until the confirm txn, so refAsBlob would
			// hand back an empty slice and this would "move" nothing into the
			// file's new home, destroying it. Same rule as compaction.
			if (ref?.packOffset != null && !ref.pending) packed.push(ref);
		}
		if (!packed.length) return { movedFiles: 0 };

		report('compacting', `Unpacking ${packed.length} file${packed.length === 1 ? '' : 's'}…`);
		const oldPaths = new Set(packed.map((r) => r.opfsPath));
		const owner = generateId('unpack');
		for (const path of oldPaths) {
			if (!(await this.claimPack(path, owner))) {
				throw new VfsError('WRITE_IN_FLIGHT', `Pack ${path} is being rewritten`);
			}
		}
		const stopClaims = this.startLeaseHeartbeat([...oldPaths].map((p) => packClaimKey(p)));
		let moved = 0;
		try {
		for (const ref of packed) {
			throwIfAborted(opts?.signal);
			if (ref.crc32 != null) {
				await this.checksumSlice(ref.opfsPath, ref.packOffset ?? 0, ref.byteLength, ref.crc32);
			}
			const blob = await this.refAsBlob(ref);
			const destPath = `blobs/${ref.id}.bin`;
			await this.holdPackWrite(destPath);
			const stopDest = this.startLeaseHeartbeat([packWriteKey(destPath)]);
			try {
				await this.opfs.writeAtomic(destPath, blob);
				if (!(await this.leaseStillHeld(packWriteKey(destPath)))) {
					throw new VfsError('WRITE_IN_FLIGHT', `Unpack dest ${destPath} lease expired`);
				}
				const swapped = await this.db.transaction('rw', this.db.blobRefs, async () => {
					const current = await this.db.blobRefs.get(ref.id);
					if (!current || current.opfsPath !== ref.opfsPath || current.pending) return false;
					const { packOffset: _drop, ...rest } = current;
					await this.db.blobRefs.put({ ...rest, opfsPath: destPath });
					return true;
				});
				if (swapped) moved += 1;
				else {
					const named = await this.db.blobRefs.where('opfsPath').equals(destPath).first();
					if (!named) {
						try {
							await this.opfs.remove(destPath);
						} catch {
							/* gc sweeps blobs/ */
						}
					}
				}
			} finally {
				stopDest();
				await this.dropPackWrite(destPath);
			}
		}
		} finally {
			stopClaims();
			for (const path of oldPaths) {
				try {
					await this.db.leases.delete(packClaimKey(path));
				} catch {
					/* expires */
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
			//
			// A pending ref is excluded on the same rule compaction uses: its
			// byteLength is 0 until the bytes land, which both slips it under any
			// size test and makes refAsBlob return an empty slice — so repacking
			// it would write a zero-length copy over a file still being saved.
			if (ref && !ref.pending && ref.byteLength < standaloneAt) refs.push(ref);
		}
		if (refs.length < 2) return { packs: 0, movedFiles: 0 };

		const sourcePaths = [...new Set(refs.filter((r) => r.packOffset != null).map((r) => r.opfsPath))];
		const owner = generateId('repack');
		for (const path of sourcePaths) {
			if (!(await this.claimPack(path, owner))) {
				throw new VfsError('WRITE_IN_FLIGHT', `Pack ${path} is being rewritten`);
			}
		}
		const stopSources = this.startLeaseHeartbeat(sourcePaths.map((p) => packClaimKey(p)));

		let packs = 0;
		let movedFiles = 0;
		const retired = new Set<string>();
		try {
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
			const parts: Uint8Array[] = [];
			const layout: Array<{ id: string; from: string; offset: number; length: number }> = [];
			let cursor = 0;
			for (const ref of group) {
				if (ref.packOffset != null && ref.crc32 != null) {
					await this.checksumSlice(ref.opfsPath, ref.packOffset, ref.byteLength, ref.crc32);
				}
				const raw = await this.opfs.read(ref.opfsPath);
				const bytes =
					ref.packOffset != null
						? raw.subarray(ref.packOffset, ref.packOffset + ref.byteLength)
						: raw;
				if (bytes.byteLength !== ref.byteLength) {
					throw new VfsError(
						'OPFS_IO',
						`Short pack read from ${ref.opfsPath}: got ${bytes.byteLength} of ${ref.byteLength}`
					);
				}
				parts.push(bytes);
				layout.push({ id: ref.id, from: ref.opfsPath, offset: cursor, length: ref.byteLength });
				cursor += ref.byteLength;
			}

			const newPath = `packs/pack_${crypto.randomUUID()}.bin`;
			await this.holdPackWrite(newPath);
			const stopDest = this.startLeaseHeartbeat([packWriteKey(newPath)]);
			try {
			const written = await this.opfs.writeAtomic(newPath, await this.materializePack(parts, cursor));
			if (written.byteLength !== cursor) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc sweeps packs/ */
				}
				throw new VfsError(
					'OPFS_IO',
					`Repack verification failed: expected ${cursor} bytes, wrote ${written.byteLength}`
				);
			}

			report('verifying', 'Verifying pack integrity…');
			const onDisk = await this.opfs.readBlob(newPath);
			if (onDisk.size !== cursor) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc sweeps packs/ */
				}
				throw new VfsError(
					'OPFS_IO',
					`Repack verification failed: expected ${cursor} bytes, wrote ${onDisk.size}`
				);
			}
			for (const item of layout) {
				const src = group.find((r) => r.id === item.id);
				await this.checksumSlice(newPath, item.offset, item.length, src?.crc32);
			}
			if (!(await this.leaseStillHeld(packWriteKey(newPath)))) {
				try {
					await this.opfs.remove(newPath);
				} catch {
					/* gc */
				}
				throw new VfsError('WRITE_IN_FLIGHT', `Repack dest ${newPath} lease expired before swap`);
			}

			let swapped = 0;
			await this.db.transaction('rw', this.db.blobRefs, async () => {
				for (const item of layout) {
					const current = await this.db.blobRefs.get(item.id);
					// Changed underneath us — a concurrent save moved it to its own
					// blob, or started writing new bytes into this one. Leave it
					// there; the new pack simply carries a copy that nothing points
					// at, which the sweep reclaims.
					if (!current || current.opfsPath !== item.from || current.pending) continue;
					await this.db.blobRefs.put({
						...current,
						opfsPath: newPath,
						packOffset: item.offset,
						packGeneration: (current.packGeneration ?? 0) + 1
					});
					swapped += 1;
				}
			});
			movedFiles += swapped;
			if (swapped > 0) packs += 1;
			for (const item of layout) retired.add(item.from);
			} finally {
				stopDest();
				await this.dropPackWrite(newPath);
			}
		}
		} finally {
			stopSources();
			for (const path of sourcePaths) {
				try {
					await this.db.leases.delete(packClaimKey(path));
				} catch {
					/* expires */
				}
			}
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
		return withWebLock(`vfs-gc:${this.db.name}`, () => this.gcLocked());
	}

	private async gcLocked(): Promise<GcReport> {
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
		const packWriteLeases = new Set(
			leases
				.filter((l) => l.expiresAt > now && l.key.startsWith('packwrite:'))
				.map((l) => l.key.slice('packwrite:'.length))
		);
		for (const p of packWriteLeases) namedPaths.add(p);

		const releasable: string[] = [];
		const stalePendingNodes: string[] = [];
		const refById = new Map(refs.map((r) => [r.id, r]));
		for (const n of nodes) {
			if (!n.blobId) continue;
			const ref = refById.get(n.blobId);
			if (!ref?.pending) continue;
			if (activeLeases.has(ref.id)) continue;
			if (now - ref.createdAt < this.graceMs) continue;
			stalePendingNodes.push(n.id);
			releasable.push(ref.id);
		}
		if (stalePendingNodes.length) {
			await this.db.nodes.bulkDelete(stalePendingNodes);
		}
		for (const ref of refs) {
			if (referenced.has(ref.id) && !releasable.includes(ref.id)) continue;
			if (activeLeases.has(ref.id)) continue;
			const inFlight = !!(ref.pending || ref.pendingPromote);
			if (inFlight && now - ref.createdAt < this.graceMs) continue;
			if (!releasable.includes(ref.id)) releasable.push(ref.id);
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
			if (t.path.endsWith('.crswap')) {
				if (await this.unlinkIfOrphanNow(t.path)) report.tmpPartialsRemoved++;
				continue;
			}
			if (namedPaths.has(t.path)) continue;
			const age = t.mtimeMs != null ? now - t.mtimeMs : this.graceMs + 1;
			if (age > this.graceMs) {
				if (await this.unlinkIfOrphanNow(t.path)) report.tmpPartialsRemoved++;
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
					if (p.endsWith('.crswap')) {
						if (await this.unlinkIfOrphanNow(p)) report.orphanOpfsRemoved++;
						continue;
					}
					if (namedPaths.has(p)) continue;
					if (packWriteLeases.has(p)) continue;
					if (prefix === 'blobs') {
						const blobId = p.replace(/^blobs\//, '').replace(/\.bin$/, '');
						if (activeLeases.has(blobId)) continue;
					}
					if (await this.unlinkIfOrphanNow(p)) report.orphanOpfsRemoved++;
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
