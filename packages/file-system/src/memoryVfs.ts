/**
 * Central, app-global in-memory VFS: a flat list of files (no folders).
 * Tab-ephemeral metadata Map + in-memory blob Map; never opens IndexedDB / OPFS.
 *
 * This is the single shared "in memory" store for the whole app — `/tools/files`
 * "In memory" pane, Connections received files, and any other consumer all read
 * and write the same global list. The legacy per-scope argument is accepted but
 * ignored (kept only to ease migration of existing call sites).
 *
 * @see docs/design/dnd-inmem-copy.md
 */
import { createChangeBus } from './changeBus.js';
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

/**
 * Flat file node. No `parentId` / `kind` / `sortOrder` / trash fields — the list
 * is a single rootless collection of files. Carries `parentId: null` and
 * `kind: 'file'` only so it stays structurally compatible with `ExplorerEntry`
 * / `nodeToEntry` consumers that still read those fields.
 */
export interface MemoryVfsNode {
	id: string;
	/** Always null — flat list, no parents. */
	parentId: null;
	/** Always 'file' — no folders. */
	kind: 'file';
	name: string;
	fileType?: FileTypeId;
	size: number;
	createdAt: number;
	updatedAt: number;
	/** Monotonic CAS token; starts at 1. */
	generation: number;
	blobId: string;
	contentType?: string;
	meta?: Record<string, unknown>;
}

type MemState = {
	/** id → node */
	nodes: Map<string, MemoryVfsNode>;
	/** blobId → bytes */
	blobs: Map<string, { bytes: Uint8Array; contentType?: string }>;
	opfs: OpfsBlobStore;
	bus: ReturnType<typeof createChangeBus>;
};

/** Single global store — one flat list for the whole app. */
let globalState: MemState | null = null;

function getState(): MemState {
	if (!globalState) {
		globalState = {
			nodes: new Map(),
			blobs: new Map(),
			opfs: createMemoryOpfs(),
			bus: createChangeBus()
		};
	}
	return globalState;
}

function ensureUnique(name: string, excludeId?: string): string {
	const taken = new Set<string>();
	for (const n of getState().nodes.values()) {
		if (n.id !== excludeId) taken.add(n.name);
	}
	if (!taken.has(name)) return name;
	let i = 1;
	while (taken.has(withNumericSuffix(name, i))) i++;
	return withNumericSuffix(name, i);
}

/**
 * Minimal flat-list VFS for the FileExplorer memory driver, Connections
 * received files, and `/tools/files` "In memory" pane. Intentionally not a
 * `SharedVfsDatabase` subclass and intentionally not folder-capable.
 */
function emitMemoryChange(): void {
	getState().bus.notify();
}

export class MemoryVfsService {
	async ready(): Promise<void> {
		/* no-op — never opens IDB */
	}

	subscribe(listener: () => void): () => void {
		return getState().bus.subscribe(listener);
	}

	get persistence() {
		return { status: 'memory' as const, requested: false };
	}

	async list(opts?: Partial<VfsListOptions>): Promise<MemoryVfsNode[]> {
		const sort = opts?.sort ?? 'name';
		const rows = [...getState().nodes.values()];
		rows.sort((a, b) => {
			if (sort === 'updatedAt') return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			return a.name.localeCompare(b.name);
		});
		return rows;
	}

	async get(id: string): Promise<MemoryVfsNode | undefined> {
		return getState().nodes.get(id);
	}

	/** Single-node "path" — flat list has no ancestors. */
	async getPath(id: string): Promise<MemoryVfsNode[]> {
		const n = await this.get(id);
		return n ? [n] : [];
	}

	async writeFile(input: WriteFileInput): Promise<MemoryVfsNode> {
		let name = sanitizeName(input.name);
		const fileType = input.fileType ?? inferFileTypeFromName(name);
		if (fileType !== 'unknown' && getFileType(fileType)) {
			name = forceExtension(name, fileType);
		}
		const taken = [...getState().nodes.values()].some((n) => n.name === name);
		if (taken && input.onConflict === 'error') {
			throw new VfsError('NAME_CONFLICT', `Name already exists: ${name}`);
		}
		name = ensureUnique(name, undefined);
		const { bytes, contentType } = await serializeBody(input.body, input.contentType);
		const nodeId = input.id ?? generateId('file');
		if (input.id && getState().nodes.has(input.id)) {
			throw new VfsError('NAME_CONFLICT', `Node id already exists: ${input.id}`);
		}
		const blobId = generateId('blob');
		const now = Date.now();
		getState().blobs.set(blobId, { bytes: new Uint8Array(bytes), contentType });
		// mirror to memory OPFS for parity with the durable path (best-effort)
		try {
			const writeId = generateId('w');
			const { tmpPath } = await getState().opfs.writePartial(writeId, bytes);
			await getState().opfs.promote(tmpPath, `blobs/${blobId}.bin`);
		} catch {
			/* map store is source of truth */
		}
		const node: MemoryVfsNode = {
			id: nodeId,
			parentId: null,
			kind: 'file',
			name,
			fileType: fileType === 'unknown' ? undefined : fileType,
			size: bytes.byteLength,
			createdAt: now,
			updatedAt: now,
			generation: 1,
			blobId,
			contentType,
			meta: input.meta
		};
		getState().nodes.set(node.id, node);
		emitMemoryChange();
		return node;
	}

	async updateFile(id: string, body: unknown, opts: UpdateFileOpts): Promise<MemoryVfsNode> {
		const node = getState().nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		if (!opts.force && opts.expectedGeneration !== node.generation) {
			throw new VfsError('GENERATION_CONFLICT');
		}
		const { bytes, contentType } = await serializeBody(body, node.contentType);
		const prevBlobId = node.blobId;
		const blobId = generateId('blob');
		getState().blobs.set(blobId, { bytes: new Uint8Array(bytes), contentType });
		try {
			const writeId = generateId('w');
			const { tmpPath } = await getState().opfs.writePartial(writeId, bytes);
			await getState().opfs.promote(tmpPath, `blobs/${blobId}.bin`);
		} catch {
			/* map store is source of truth */
		}
		if (prevBlobId && prevBlobId !== blobId) {
			getState().blobs.delete(prevBlobId);
			try {
				await getState().opfs.remove(`blobs/${prevBlobId}.bin`);
			} catch {
				/* ignore */
			}
		}
		node.blobId = blobId;
		node.size = bytes.byteLength;
		node.contentType = contentType;
		node.updatedAt = Date.now();
		node.generation += 1;
		getState().nodes.set(id, node);
		emitMemoryChange();
		return node;
	}

	async readBytes(id: string): Promise<Uint8Array> {
		const node = getState().nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		const b = getState().blobs.get(node.blobId);
		if (!b) throw new VfsError('OPFS_IO', 'missing blob');
		return new Uint8Array(b.bytes);
	}

	async readBlob(id: string): Promise<Blob> {
		const node = getState().nodes.get(id);
		const bytes = await this.readBytes(id);
		return new Blob([bytes as BlobPart], {
			type: node?.contentType || 'application/octet-stream'
		});
	}

	async readJson(id: string): Promise<unknown> {
		const bytes = await this.readBytes(id);
		return JSON.parse(new TextDecoder().decode(bytes));
	}

	async rename(id: string, name: string): Promise<MemoryVfsNode> {
		const node = getState().nodes.get(id);
		if (!node) throw new VfsError('NOT_FOUND');
		let finalName = sanitizeName(name);
		if (node.fileType && node.fileType !== 'unknown') {
			finalName = forceExtension(finalName, node.fileType);
		}
		finalName = ensureUnique(finalName, id);
		node.name = finalName;
		node.updatedAt = Date.now();
		node.generation += 1;
		getState().nodes.set(id, node);
		emitMemoryChange();
		return node;
	}

	/** Hard delete a file and its blob. No trash/restore in the flat model. */
	async delete(id: string): Promise<void> {
		const node = getState().nodes.get(id);
		if (!node) return;
		getState().blobs.delete(node.blobId);
		try {
			await getState().opfs.remove(`blobs/${node.blobId}.bin`);
		} catch {
			/* ignore */
		}
		getState().nodes.delete(id);
		emitMemoryChange();
	}

	async dangerClearAll(): Promise<void> {
		getState().nodes.clear();
		getState().blobs.clear();
		await getState().opfs.clearAll?.();
		emitMemoryChange();
	}
}

/** Single global memory VFS. The `scope` arg is ignored (kept for migration). */
export function getMemoryVfs(_scope?: string): MemoryVfsService {
	return new MemoryVfsService();
}

/** Alias — same global store as getMemoryVfs. */
export function createMemoryVfs(_scope?: string): MemoryVfsService {
	return new MemoryVfsService();
}

/** Clear the global memory store. The `scope` arg is ignored. */
export function disposeMemoryVfs(_scope?: string): void {
	if (!globalState) return;
	globalState.bus.notify();
	globalState.bus.clear();
	globalState.nodes.clear();
	globalState.blobs.clear();
	void globalState.opfs.clearAll?.();
	globalState = null;
}

export function clearAllMemoryVfsForTests(): void {
	disposeMemoryVfs();
}

/** Design alias — clear the global store (scope ignored). */
export function resetMemoryVfsForTests(_scope?: string): void {
	disposeMemoryVfs();
}

/** Assert no IndexedDB open for memory product path (unit spies). */
export function assertMemoryNeverUsesIdb(): void {
	/* documentation hook — real spies in tests wrap indexedDB.open */
}

/**
 * Convenience: coerce a MemoryVfsNode into a `VfsNode`-shaped object for
 * consumers (e.g. copyAcross / saveToLibrary) that read the durable VfsNode
 * shape. All folder/trash fields are absent; readers must treat the node as a
 * root-level file.
 */
export function toVfsNodeLike(n: MemoryVfsNode): VfsNode {
	return {
		id: n.id,
		parentId: null,
		name: n.name,
		kind: 'file',
		fileType: n.fileType,
		size: n.size,
		createdAt: n.createdAt,
		updatedAt: n.updatedAt,
		generation: n.generation,
		blobId: n.blobId,
		contentType: n.contentType,
		meta: n.meta
	};
}