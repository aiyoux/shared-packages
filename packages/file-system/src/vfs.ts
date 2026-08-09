import { liveQuery, type Observable } from 'dexie';
import { SharedVfsDatabase } from './db.js';
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
	type FileTypeId,
	type GcReport,
	type UpdateFileOpts,
	type VfsListOptions,
	type VfsNode,
	type WriteFileInput,
	VfsError
} from './types.js';

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

export class VfsService {
	readonly db: SharedVfsDatabase;
	readonly opfs: OpfsBlobStore;
	readonly graceMs: number;
	private readyPromise: Promise<void> | null = null;
	private requestPersist: boolean;
	private lastPersistence: PersistenceResult | null = null;

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
			const collection = this.db.nodes.where('parentId').equals(parentId as string);
			// Dexie: null parentId — use filter when null
			if (parentId === null) {
				rows = await this.db.nodes.filter((n) => n.parentId === null).toArray();
			} else {
				rows = await collection.toArray();
			}
			if (!opts.includeDeleted) {
				rows = rows.filter((n) => n.deletedAt == null);
			}
		}

		const sort = opts.sort ?? 'name';
		rows.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
			if (sort === 'updatedAt') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			return a.name.localeCompare(b.name);
		});
		return rows;
	}

	/** Reactive list (Dexie liveQuery). */
	liveList(opts: VfsListOptions): Observable<VfsNode[]> {
		return liveQuery(() => this.list(opts));
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

	async ensureUniqueName(
		parentId: string | null,
		name: string,
		excludeId?: string,
		onConflict: 'rename' | 'error' = 'rename'
	): Promise<string> {
		const siblings = await this.activeSiblings(parentId, excludeId);
		const taken = new Set(siblings.map((s) => s.name));
		if (!taken.has(name)) return name;
		if (onConflict === 'error') {
			throw new VfsError('NAME_CONFLICT', `Name already exists: ${name}`);
		}
		let i = 1;
		while (taken.has(withNumericSuffix(name, i))) i++;
		return withNumericSuffix(name, i);
	}

	// ── mkdir ─────────────────────────────────────────────────────

	async mkdir(
		parentId: string | null,
		name: string,
		opts?: { id?: string; onConflict?: 'rename' | 'error' }
	): Promise<VfsNode> {
		await this.ready();
		const clean = sanitizeName(name);
		if (parentId) {
			const parent = await this.db.nodes.get(parentId);
			if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER', 'Parent not a folder');
			if (parent.deletedAt != null) throw new VfsError('TRASH_STATE', 'Parent is in trash');
		}

		const id = opts?.id ?? generateId('fld');
		const now = Date.now();

		return this.db.transaction('rw', this.db.nodes, async () => {
			const unique = await this.ensureUniqueName(parentId, clean, undefined, opts?.onConflict ?? 'rename');
			const existing = await this.db.nodes.get(id);
			if (existing) return existing;
			const node: VfsNode = {
				id,
				parentId,
				name: unique,
				kind: 'folder',
				createdAt: now,
				updatedAt: now,
				generation: 1,
				deletedAt: null
			};
			await this.db.nodes.put(node);
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
		if (input.parentId) {
			const parent = await this.db.nodes.get(input.parentId);
			if (!parent || parent.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
			if (parent.deletedAt != null) throw new VfsError('TRASH_STATE');
		}

		const nodeId = input.id ?? generateId('file');
		const blobId = generateId('blob');
		const writeId = generateId('w');
		const finalPath = `blobs/${blobId}.bin`;
		const { bytes, contentType } = await serializeBody(input.body, input.contentType);
		const leaseKey = `write:${blobId}`;
		const owner = generateId('lease');
		const now = Date.now();

		// Reserve name + pending blobRef + lease
		await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, this.db.leases, async () => {
			const unique = await this.ensureUniqueName(
				input.parentId,
				name,
				undefined,
				input.onConflict ?? 'rename'
			);
			name = unique;
			const existing = await this.db.nodes.get(nodeId);
			if (existing && existing.deletedAt == null) {
				throw new VfsError('NAME_CONFLICT', `Node id already exists: ${nodeId}`);
			}
			await this.db.blobRefs.put({
				id: blobId,
				opfsPath: `tmp/${writeId}.partial`,
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
				deletedAt: null
			};
			await this.db.nodes.put(node);
		});

		try {
			const { tmpPath, byteLength } = await this.opfs.writePartial(writeId, bytes);
			await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, this.db.leases, async () => {
				await this.db.blobRefs.put({
					id: blobId,
					opfsPath: tmpPath,
					byteLength,
					createdAt: now,
					contentType,
					pendingPromote: true
				});
				const node = await this.db.nodes.get(nodeId);
				if (!node) throw new VfsError('NOT_FOUND');
				node.size = byteLength;
				node.updatedAt = Date.now();
				await this.db.nodes.put(node);
			});
			await this.opfs.promote(tmpPath, finalPath);
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
			// rollback
			await this.db.nodes.delete(nodeId);
			await this.db.blobRefs.delete(blobId);
			await this.db.leases.delete(leaseKey);
			try {
				await this.opfs.remove(`tmp/${writeId}.partial`);
			} catch {
				/* ignore */
			}
			if (e instanceof VfsError) throw e;
			throw new VfsError('OPFS_IO', String(e));
		}

		const final = await this.db.nodes.get(nodeId);
		if (!final) throw new VfsError('NOT_FOUND');
		return final;
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
		const { bytes, contentType } = await serializeBody(body, node.contentType);
		const leaseKey = `write:${blobId}`;
		const owner = generateId('lease');
		const now = Date.now();

		const { tmpPath, byteLength } = await this.opfs.writePartial(writeId, bytes);

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
				await this.db.blobRefs.put({
					id: blobId,
					opfsPath: tmpPath,
					byteLength,
					createdAt: now,
					contentType,
					pendingPromote: true
				});
				await this.db.leases.put({ key: leaseKey, owner, expiresAt: now + this.graceMs });
				cur.blobId = blobId;
				cur.size = byteLength;
				cur.updatedAt = Date.now();
				cur.generation = cur.generation + 1;
				cur.contentType = contentType;
				await this.db.nodes.put(cur);
			});
		} catch (e) {
			try {
				await this.opfs.remove(tmpPath);
			} catch {
				/* ignore */
			}
			throw e;
		}

		await this.opfs.promote(tmpPath, finalPath);
		await this.db.transaction('rw', this.db.blobRefs, this.db.leases, async () => {
			const ref = await this.db.blobRefs.get(blobId);
			if (ref) {
				ref.opfsPath = finalPath;
				ref.pendingPromote = false;
				await this.db.blobRefs.put(ref);
			}
			await this.db.leases.delete(leaseKey);
		});

		// best-effort previous blob cleanup
		if (prevBlobId && prevBlobId !== blobId) {
			const oldRef = await this.db.blobRefs.get(prevBlobId);
			if (oldRef) {
				try {
					await this.opfs.remove(oldRef.opfsPath);
				} catch {
					/* GC later */
				}
				await this.db.blobRefs.delete(prevBlobId);
			}
		}

		const final = await this.db.nodes.get(id);
		if (!final) throw new VfsError('NOT_FOUND');
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
		return this.opfs.read(ref.opfsPath);
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
		return this.opfs.readBlob(ref.opfsPath, node.contentType ?? ref.contentType);
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
			node.generation += 1;
			await this.db.nodes.put(node);
			return node;
		});
	}

	async move(id: string, newParentId: string | null, opts?: { name?: string }): Promise<VfsNode> {
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
					const p = await this.db.nodes.get(walk);
					walk = p?.parentId ?? null;
				}
			}
			const name = opts?.name ? sanitizeName(opts.name) : node.name;
			const unique = await this.ensureUniqueName(newParentId, name, id, 'rename');
			node.parentId = newParentId;
			node.name = unique;
			node.updatedAt = Date.now();
			node.generation += 1;
			await this.db.nodes.put(node);
			return node;
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
				n.generation += 1;
				await this.db.nodes.put(n);
			}
			return (await this.db.nodes.get(id))!;
		});
	}

	async permanentDelete(id: string, opts?: { recursive?: boolean }): Promise<void> {
		await this.ready();
		const recursive = opts?.recursive ?? false;
		const blobIds: string[] = [];
		const opfsPaths: string[] = [];

		await this.db.transaction('rw', this.db.nodes, this.db.blobRefs, async () => {
			const node = await this.db.nodes.get(id);
			if (!node) throw new VfsError('NOT_FOUND');

			const toDelete: VfsNode[] = [node];
			if (node.kind === 'folder') {
				const children = await this.db.nodes.filter((n) => n.parentId === id).toArray();
				if (children.length && !recursive) {
					throw new VfsError('HAS_CHILDREN', 'Folder has children');
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
				if (n.blobId) {
					blobIds.push(n.blobId);
					const ref = await this.db.blobRefs.get(n.blobId);
					if (ref) opfsPaths.push(ref.opfsPath);
				}
				await this.db.nodes.delete(n.id);
			}
			for (const bid of blobIds) {
				await this.db.blobRefs.delete(bid);
			}
		});

		for (const p of opfsPaths) {
			try {
				await this.opfs.remove(p);
			} catch {
				/* GC later */
			}
		}
	}

	async emptyTrash(): Promise<void> {
		await this.ready();
		const trashed = await this.db.nodes.filter((n) => n.deletedAt != null).toArray();
		// delete leaves-first-ish: all with recursive
		for (const n of trashed) {
			const still = await this.db.nodes.get(n.id);
			if (still) {
				try {
					await this.permanentDelete(n.id, { recursive: true });
				} catch {
					/* continue */
				}
			}
		}
	}

	// ── Drafts ────────────────────────────────────────────────────

	async putDraft(draft: import('./types.js').AppDraft): Promise<void> {
		await this.ready();
		await this.db.drafts.put(draft);
	}

	async getDraft(id: string): Promise<import('./types.js').AppDraft | undefined> {
		await this.ready();
		return this.db.drafts.get(id);
	}

	async deleteDraft(id: string): Promise<void> {
		await this.ready();
		await this.db.drafts.delete(id);
	}

	// ── Migration helpers ─────────────────────────────────────────

	/** Upsert node by id (migration). */
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
		for (const ref of refs) {
			if (referenced.has(ref.id)) continue;
			if (activeLeases.has(ref.id)) continue;
			if (ref.pending && now - ref.createdAt < this.graceMs) continue;
			try {
				await this.opfs.remove(ref.opfsPath);
			} catch {
				/* ignore */
			}
			await this.db.blobRefs.delete(ref.id);
			report.orphanBlobRefsRemoved++;
			report.unreferencedBlobsRemoved++;
		}

		// tmp GC
		const tmps = await this.opfs.listTmp();
		for (const t of tmps) {
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

		// OPFS orphans under blobs/
		try {
			const opfsBlobs = await this.opfs.listOrphans('blobs');
			const livePaths = new Set((await this.db.blobRefs.toArray()).map((r) => r.opfsPath));
			for (const p of opfsBlobs) {
				if (livePaths.has(p)) continue;
				const blobId = p.replace(/^blobs\//, '').replace(/\.bin$/, '');
				if (activeLeases.has(blobId)) continue;
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
