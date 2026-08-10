/**
 * Fail-closed tab-ephemeral VFS: in-memory metadata Maps + createMemoryOpfs.
 * NEVER opens IndexedDB / SharedVfsDatabase.
 * @see docs/design/dnd-inmem-copy.md
 */
import { generateId } from './id.js';
import { sanitizeName, withNumericSuffix } from './names.js';
import { createMemoryOpfs, type OpfsBlobStore } from './opfs.js';
import { forceExtension, getFileType, inferFileTypeFromName } from './registry.js';
import { serializeBody } from './serialize.js';
import {
	type FileTypeId,
	type UpdateFileOpts,
	type VfsListOptions,
	type VfsNode,
	type WriteFileInput,
	VfsError
} from './types.js';
import { calculateMidOrder, needsRebalance, rebalanceOrders } from './ui/treeDnd/order.js';

type MemoryScope = 'files' | 'cm' | string;

type MemState = {
	nodes: Map<string, VfsNode>;
	/** blobId → Uint8Array */
	blobs: Map<string, { bytes: Uint8Array; contentType?: string }>;
	opfs: OpfsBlobStore;
};

const scopes = new Map<MemoryScope, MemState>();

function getState(scope: MemoryScope): MemState {
	let s = scopes.get(scope);
	if (!s) {
		s = {
			nodes: new Map(),
			blobs: new Map(),
			opfs: createMemoryOpfs()
		};
		scopes.set(scope, s);
	}
	return s;
}

function sortSiblings(rows: VfsNode[]): VfsNode[] {
	return [...rows].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
		const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
		if (ao !== bo) return ao - bo;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Minimal VfsService-compatible surface for FileExplorer / local driver / CM.
 * Intentionally not a SharedVfsDatabase subclass.
 */
export class MemoryVfsService {
	readonly scope: MemoryScope;
	private state: MemState;

	constructor(scope: MemoryScope = 'files') {
		this.scope = scope;
		this.state = getState(scope);
	}

	async ready(): Promise<void> {
		/* no-op — never opens IDB */
	}

	get persistence() {
		return { status: 'memory' as const, requested: false };
	}

	private activeSiblings(parentId: string | null, excludeId?: string): VfsNode[] {
		const rows = [...this.state.nodes.values()].filter(
			(n) => n.parentId === parentId && n.deletedAt == null && n.id !== excludeId
		);
		return sortSiblings(rows);
	}

	private nextAppend(parentId: string | null): number {
		const siblings = this.activeSiblings(parentId);
		if (!siblings.length) return 0;
		const last = siblings[siblings.length - 1]!;
		return (last.sortOrder ?? (siblings.length - 1) * 16384) + 16384;
	}

	private ensureUnique(
		parentId: string | null,
		name: string,
		excludeId?: string,
		onConflict: 'rename' | 'error' = 'rename'
	): string {
		const taken = new Set(
			this.activeSiblings(parentId, excludeId).map((s) => s.name)
		);
		if (!taken.has(name)) return name;
		if (onConflict === 'error') throw new VfsError('NAME_CONFLICT', name);
		let i = 1;
		while (taken.has(withNumericSuffix(name, i))) i++;
		return withNumericSuffix(name, i);
	}

	async list(opts: VfsListOptions): Promise<VfsNode[]> {
		let rows: VfsNode[];
		if (opts.trashOnly) {
			const allDeleted = [...this.state.nodes.values()].filter((n) => n.deletedAt != null);
			const deletedIds = new Set(allDeleted.map((n) => n.id));
			rows = allDeleted.filter(
				(n) => n.parentId == null || !deletedIds.has(n.parentId)
			);
		} else {
			rows = [...this.state.nodes.values()].filter((n) => n.parentId === (opts.parentId ?? null));
			if (!opts.includeDeleted) rows = rows.filter((n) => n.deletedAt == null);
		}
		const sort = opts.sort ?? 'order';
		rows.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
			if (sort === 'updatedAt') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			if (sort === 'order') {
				const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
				const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
				if (ao !== bo) return ao - bo;
			}
			return a.name.localeCompare(b.name);
		});
		return rows;
	}

	async get(id: string): Promise<VfsNode | undefined> {
		return this.state.nodes.get(id);
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

	async mkdir(
		parentId: string | null,
		name: string,
		opts?: { id?: string; onConflict?: 'rename' | 'error' }
	): Promise<VfsNode> {
		const clean = sanitizeName(name);
		if (parentId) {
			const p = this.state.nodes.get(parentId);
			if (!p || p.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
		}
		const unique = this.ensureUnique(parentId, clean, undefined, opts?.onConflict ?? 'rename');
		const now = Date.now();
		const node: VfsNode = {
			id: opts?.id ?? generateId('fld'),
			parentId,
			name: unique,
			kind: 'folder',
			createdAt: now,
			updatedAt: now,
			generation: 1,
			deletedAt: null,
			sortOrder: this.nextAppend(parentId)
		};
		this.state.nodes.set(node.id, node);
		return node;
	}

	async writeFile(input: WriteFileInput): Promise<VfsNode> {
		let name = sanitizeName(input.name);
		const fileType = input.fileType ?? inferFileTypeFromName(name);
		if (fileType !== 'unknown' && getFileType(fileType)) {
			name = forceExtension(name, fileType);
		}
		if (input.parentId) {
			const p = this.state.nodes.get(input.parentId);
			if (!p || p.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
		}
		name = this.ensureUnique(input.parentId, name, undefined, input.onConflict ?? 'rename');
		const { bytes, contentType } = await serializeBody(input.body, input.contentType);
		const nodeId = input.id ?? generateId('file');
		const blobId = generateId('blob');
		const now = Date.now();
		this.state.blobs.set(blobId, { bytes, contentType });
		// also store via memory OPFS for parity
		try {
			const writeId = generateId('w');
			const { tmpPath } = await this.state.opfs.writePartial(writeId, bytes);
			await this.state.opfs.promote(tmpPath, `blobs/${blobId}.bin`);
		} catch {
			/* map store is source of truth */
		}
		const node: VfsNode = {
			id: nodeId,
			parentId: input.parentId,
			name,
			kind: 'file',
			fileType: fileType === 'unknown' ? undefined : fileType,
			size: bytes.byteLength,
			createdAt: now,
			updatedAt: now,
			generation: 1,
			blobId,
			contentType,
			meta: input.meta,
			deletedAt: null,
			sortOrder: this.nextAppend(input.parentId)
		};
		this.state.nodes.set(node.id, node);
		return node;
	}

	async updateFile(id: string, body: unknown, opts: UpdateFileOpts): Promise<VfsNode> {
		const node = this.state.nodes.get(id);
		if (!node || node.kind !== 'file') throw new VfsError('NOT_A_FILE');
		if (!opts.force && opts.expectedGeneration !== node.generation) {
			throw new VfsError('GENERATION_CONFLICT');
		}
		const { bytes, contentType } = await serializeBody(body, node.contentType);
		const blobId = node.blobId ?? generateId('blob');
		this.state.blobs.set(blobId, { bytes, contentType });
		node.blobId = blobId;
		node.size = bytes.byteLength;
		node.contentType = contentType;
		node.updatedAt = Date.now();
		node.generation += 1;
		this.state.nodes.set(id, node);
		return node;
	}

	async readBytes(id: string): Promise<Uint8Array> {
		const node = this.state.nodes.get(id);
		if (!node || node.kind !== 'file' || !node.blobId) throw new VfsError('NOT_A_FILE');
		const b = this.state.blobs.get(node.blobId);
		if (!b) throw new VfsError('OPFS_IO', 'missing blob');
		return b.bytes;
	}

	async readBlob(id: string): Promise<Blob> {
		const node = this.state.nodes.get(id);
		const bytes = await this.readBytes(id);
		return new Blob([bytes as BlobPart], {
			type: node?.contentType || 'application/octet-stream'
		});
	}

	async readJson(id: string): Promise<unknown> {
		const bytes = await this.readBytes(id);
		return JSON.parse(new TextDecoder().decode(bytes));
	}

	async rename(id: string, name: string): Promise<VfsNode> {
		const node = this.state.nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		let finalName = sanitizeName(name);
		if (node.kind === 'file' && node.fileType && node.fileType !== 'unknown') {
			finalName = forceExtension(finalName, node.fileType);
		}
		finalName = this.ensureUnique(node.parentId, finalName, id, 'rename');
		node.name = finalName;
		node.updatedAt = Date.now();
		node.generation += 1;
		this.state.nodes.set(id, node);
		return node;
	}

	async move(
		id: string,
		newParentId: string | null,
		opts?: { name?: string; beforeId?: string | null; afterId?: string | null }
	): Promise<VfsNode> {
		const node = this.state.nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		if (newParentId) {
			const p = this.state.nodes.get(newParentId);
			if (!p || p.kind !== 'folder') throw new VfsError('NOT_A_FOLDER');
			let walk: string | null = newParentId;
			while (walk) {
				if (walk === id) throw new VfsError('CYCLE');
				walk = this.state.nodes.get(walk)?.parentId ?? null;
			}
		}
		const name = opts?.name ? sanitizeName(opts.name) : node.name;
		node.parentId = newParentId;
		node.name = this.ensureUnique(newParentId, name, id, 'rename');
		node.sortOrder = this.nextAppend(newParentId);
		node.updatedAt = Date.now();
		node.generation += 1;
		this.state.nodes.set(id, node);
		if (opts?.beforeId != null || opts?.afterId != null) {
			return this.reorder(id, { beforeId: opts.beforeId, afterId: opts.afterId });
		}
		return node;
	}

	async copy(id: string, newParentId: string | null): Promise<VfsNode> {
		const src = this.state.nodes.get(id);
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
		const folder = await this.mkdir(newParentId, src.name);
		const children = await this.list({ parentId: id });
		for (const child of children) {
			await this.copy(child.id, folder.id);
		}
		return folder;
	}

	async reorder(
		id: string,
		opts: { beforeId?: string | null; afterId?: string | null } = {}
	): Promise<VfsNode> {
		const node = this.state.nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		const siblings = this.activeSiblings(node.parentId, id);
		let beforeOrder: number | null = null;
		let afterOrder: number | null = null;
		if (opts.beforeId) {
			const b = this.state.nodes.get(opts.beforeId);
			if (b) beforeOrder = b.sortOrder ?? 0;
		}
		if (opts.afterId) {
			const a = this.state.nodes.get(opts.afterId);
			if (a) afterOrder = a.sortOrder ?? 0;
		}
		if (!opts.beforeId && !opts.afterId && siblings.length) {
			const last = siblings[siblings.length - 1]!;
			beforeOrder = last.sortOrder ?? 0;
		}
		let mid = calculateMidOrder(beforeOrder, afterOrder);
		if (needsRebalance(mid, beforeOrder, afterOrder)) {
			const ordered = [...siblings];
			let insertAt = ordered.length;
			if (opts.afterId) {
				const i = ordered.findIndex((s) => s.id === opts.afterId);
				if (i >= 0) insertAt = i;
			} else if (opts.beforeId) {
				const i = ordered.findIndex((s) => s.id === opts.beforeId);
				if (i >= 0) insertAt = i + 1;
			}
			ordered.splice(insertAt, 0, node);
			const ranks = rebalanceOrders(ordered.length);
			for (let i = 0; i < ordered.length; i++) {
				ordered[i]!.sortOrder = ranks[i];
				this.state.nodes.set(ordered[i]!.id, ordered[i]!);
			}
			return this.state.nodes.get(id)!;
		}
		node.sortOrder = mid;
		node.updatedAt = Date.now();
		node.generation += 1;
		this.state.nodes.set(id, node);
		return node;
	}

	async trash(id: string): Promise<void> {
		const root = this.state.nodes.get(id);
		if (!root) throw new VfsError('NOT_FOUND');
		const now = Date.now();
		const mark = (n: VfsNode) => {
			n.deletedAt = now;
			n.trashParentId = n.parentId;
			this.state.nodes.set(n.id, n);
			if (n.kind === 'folder') {
				for (const c of this.state.nodes.values()) {
					if (c.parentId === n.id && c.deletedAt == null) mark(c);
				}
			}
		};
		mark(root);
	}

	async restore(id: string): Promise<void> {
		const root = this.state.nodes.get(id);
		if (!root) throw new VfsError('NOT_FOUND');
		if (root.deletedAt == null) return;

		// If parent is still trashed, reparent to root
		if (root.parentId) {
			const parent = this.state.nodes.get(root.parentId);
			if (!parent || parent.deletedAt != null) {
				const fallback = root.trashParentId ?? null;
				if (fallback) {
					const fb = this.state.nodes.get(fallback);
					root.parentId = fb && fb.deletedAt == null ? fallback : null;
				} else {
					root.parentId = null;
				}
			}
		}

		// Collect root + all trashed descendants
		const collect: VfsNode[] = [root];
		if (root.kind === 'folder') {
			const stack = [root.id];
			while (stack.length) {
				const pid = stack.pop()!;
				for (const c of this.state.nodes.values()) {
					if (c.parentId === pid && c.deletedAt != null) {
						collect.push(c);
						if (c.kind === 'folder') stack.push(c.id);
					}
				}
			}
		}

		// Unique name on root only
		root.name = this.ensureUnique(root.parentId, root.name, root.id, 'rename');

		for (const n of collect) {
			n.deletedAt = null;
			n.trashParentId = null;
			n.updatedAt = Date.now();
			n.generation += 1;
			this.state.nodes.set(n.id, n);
		}
	}

	async permanentDelete(id: string, _opts?: { recursive?: boolean }): Promise<void> {
		const remove = (nid: string) => {
			const n = this.state.nodes.get(nid);
			if (!n) return;
			if (n.kind === 'folder') {
				for (const c of [...this.state.nodes.values()]) {
					if (c.parentId === nid) remove(c.id);
				}
			}
			if (n.blobId) this.state.blobs.delete(n.blobId);
			this.state.nodes.delete(nid);
		};
		remove(id);
	}

	async emptyTrash(): Promise<void> {
		for (const n of [...this.state.nodes.values()]) {
			if (n.deletedAt != null) await this.permanentDelete(n.id);
		}
	}

	async dangerClearAll(): Promise<void> {
		this.state.nodes.clear();
		this.state.blobs.clear();
		if (this.state.opfs.clearAll) await this.state.opfs.clearAll();
	}
}

/** Tab-scoped singleton per scope name. */
export function getMemoryVfs(scope: MemoryScope = 'files'): MemoryVfsService {
	return new MemoryVfsService(scope);
}

export function createMemoryVfs(scope: MemoryScope = 'files'): MemoryVfsService {
	// Always returns service bound to scope singleton store
	return new MemoryVfsService(scope);
}

export function disposeMemoryVfs(scope: MemoryScope = 'files'): void {
	const s = scopes.get(scope);
	if (!s) return;
	s.nodes.clear();
	s.blobs.clear();
	void s.opfs.clearAll?.();
	scopes.delete(scope);
}

export function clearAllMemoryVfsForTests(): void {
	for (const key of [...scopes.keys()]) disposeMemoryVfs(key);
}

/** Design alias — clear one named scope (or all if omitted). */
export function resetMemoryVfsForTests(scope?: MemoryScope): void {
	if (scope == null) {
		clearAllMemoryVfsForTests();
		return;
	}
	disposeMemoryVfs(scope);
}

/** Assert no IndexedDB open for memory product path (unit spies). */
export function assertMemoryNeverUsesIdb(): void {
	/* documentation hook — real spies in tests wrap indexedDB.open */
}
