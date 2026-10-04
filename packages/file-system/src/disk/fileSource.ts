/** Native-handle editor access. Only handles/version metadata persist here. */
import type { DiskDirHandle } from './handles.js';
import { generateId } from '../id.js';
import { notifyTabChannel } from '../crossTab.js';
import { diskFileId, diskFileLocation } from '../fileSourceIds.js';
import { serializeBody } from '../serialize.js';
import { inferFileTypeFromName } from '../registry.js';
import { sanitizeName, withNumericSuffix } from '../names.js';
import { VfsError, type VfsNode } from '../types.js';
import { sourceChanges, SOURCE_FILES_CHANNEL, type FileSource } from '../fileSources.js';

type Version = { generation: number; updatedAt: number; size: number; contentType?: string; meta?: Record<string, unknown> };
const roots = new Map<string, DiskDirHandle>();
const fallback = new Map<string, unknown>();
const queues = new Map<string, Promise<unknown>>();
let db: Promise<IDBDatabase> | null = null;

async function database(): Promise<IDBDatabase> {
	return db ??= new Promise((resolve, reject) => {
		const request = indexedDB.open('file-source-handles', 1);
		request.onupgradeneeded = () => request.result.createObjectStore('sources');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function stored<T>(key: string): Promise<T | undefined> {
	if (fallback.has(key)) return fallback.get(key) as T;
	if (typeof indexedDB === 'undefined') return undefined;
	const connection = await database();
	return new Promise((resolve, reject) => {
		const request = connection.transaction('sources').objectStore('sources').get(key);
		request.onsuccess = () => resolve(request.result as T | undefined);
		request.onerror = () => reject(request.error);
	});
}

async function put(key: string, value: unknown): Promise<void> {
	if (typeof indexedDB === 'undefined' || fallback.has(key)) { fallback.set(key, value); return; }
	const connection = await database();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = connection.transaction('sources', 'readwrite');
			tx.objectStore('sources').put(value, key);
			tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
		});
	} catch (error) {
		// Test handles are plain objects with methods; real FSA handles are cloneable.
		if ((error as DOMException)?.name !== 'DataCloneError') throw error;
		fallback.set(key, value);
	}
}

/** Save the granted root, deduplicating repeated opens of the same directory. */
async function rememberDiskRoot(root: DiskDirHandle, path: string): Promise<string> {
	let ids = await stored<string[]>('roots') ?? [];
	for (const id of ids) {
		const known = roots.get(id) ?? await stored<DiskDirHandle>(`root:${id}`);
		if (known && (known === root || await root.isSameEntry?.(known))) {
			roots.set(id, root); return diskFileId(id, path);
		}
	}
	const id = generateId('disk-root'); roots.set(id, root);
	await put(`root:${id}`, root);
	ids = [...ids, id]; await put('roots', ids);
	return diskFileId(id, path);
}

async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
	if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`file-source:${id}`, action);
	const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
	queues.set(id, next);
	try { return await next; }
	finally { if (queues.get(id) === next) queues.delete(id); }
}

export function openDiskFile(root: DiskDirHandle, path: string): Promise<string> {
	return locked('roots', () => rememberDiskRoot(root, path));
}

async function location(id: string) {
	const parsed = diskFileLocation(id);
	if (!parsed) throw new VfsError('NOT_FOUND');
	const root = roots.get(parsed.rootId) ?? await stored<DiskDirHandle>(`root:${parsed.rootId}`);
	if (!root) throw new VfsError('NOT_FOUND', 'Pick the original Disk folder again.');
	roots.set(parsed.rootId, root);
	// Restoring a session never prompts for permissions without a user gesture.
	if (root.queryPermission && await root.queryPermission({ mode: 'read' }) !== 'granted') {
		throw new Error('Access to this Disk folder needs to be granted again in Files.');
	}
	const segments = parsed.path.split('/').filter(Boolean);
	let dir = root;
	for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
	return { ...parsed, root, dir, name: segments.at(-1) ?? root.name };
}

async function version(id: string, file: File): Promise<Version> {
	const previous = await stored<Version>(`file:${id}`);
	if (previous && previous.updatedAt === file.lastModified && previous.size === file.size) return previous;
	const next: Version = { ...previous, generation: (previous?.generation ?? 0) + 1, updatedAt: file.lastModified, size: file.size };
	await put(`file:${id}`, next); return next;
}

async function nodeUnlocked(id: string): Promise<VfsNode | undefined> {
	try {
		const loc = await location(id);
		const folder = !loc.path || loc.path.endsWith('/');
		if (folder && loc.path) await loc.dir.getDirectoryHandle(loc.name);
		const file = folder ? null : await (await loc.dir.getFileHandle(loc.name)).getFile();
		const v = file ? await version(id, file) : null;
		const segments = loc.path.split('/').filter(Boolean);
		const parentPath = segments.slice(0, -1).join('/');
		return { id, name: loc.name, kind: folder ? 'folder' : 'file',
			parentId: loc.path ? diskFileId(loc.rootId, parentPath ? parentPath + '/' : '') : null,
			fileType: folder ? undefined : inferFileTypeFromName(loc.name), generation: v?.generation ?? 1,
			createdAt: 0, updatedAt: v?.updatedAt ?? 0, size: file?.size,
			blobId: file ? `${id}:${v!.generation}` : undefined, contentType: file?.type || v?.contentType,
			meta: v?.meta };
	} catch (error) {
		if ((error as DOMException)?.name === 'NotFoundError') return undefined;
		throw error;
	}
}

export const diskFileSource: FileSource = {
	get: (id) => locked(id, () => nodeUnlocked(id)),
	async readBlob(id) { const loc = await location(id); return (await loc.dir.getFileHandle(loc.name)).getFile(); },
	async updateFile(id, body, opts) {
		const save = async () => {
			const loc = await location(id); const handle = await loc.dir.getFileHandle(loc.name);
			const current = await version(id, await handle.getFile());
			if (!opts.force && opts.expectedGeneration !== current.generation) throw new VfsError('GENERATION_CONFLICT');
			const { bytes, contentType } = await serializeBody(body, opts.contentType ?? current.contentType);
			const writer = await handle.createWritable();
			await writer.write(new Blob([bytes as BlobPart])); await writer.close();
			const file = await handle.getFile();
			await put(`file:${id}`, { ...current, generation: current.generation + 1,
				updatedAt: file.lastModified, size: file.size, contentType,
				...(opts.meta !== undefined ? { meta: opts.meta } : {}) });
			sourceChanges.notify(); notifyTabChannel(SOURCE_FILES_CHANNEL); return (await nodeUnlocked(id))!;
		};
		return locked(id, save);
	},
	async list(opts) {
		if (!opts.parentId) return [];
		const loc = await location(opts.parentId);
		const dir = loc.path ? await loc.dir.getDirectoryHandle(loc.name) : loc.root;
		const out: VfsNode[] = [];
		for await (const [name, handle] of dir.entries()) {
			const id = diskFileId(loc.rootId, loc.path + name + (handle.kind === 'directory' ? '/' : ''));
			const child = await this.get(id); if (child) out.push(child);
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	},
	async writeFile(input) {
		return locked(input.parentId!, async () => {
			const loc = await location(input.parentId!);
			const dir = loc.path ? await loc.dir.getDirectoryHandle(loc.name) : loc.root;
			const base = sanitizeName(input.name);
			let name = base;
			for (let i = 1; ; i++) {
				let folder = false;
				try { await dir.getFileHandle(name); }
				catch (error) {
					if ((error as DOMException)?.name === 'NotFoundError') break;
					if ((error as DOMException)?.name !== 'TypeMismatchError') throw error;
					folder = true;
				}
				if (input.onConflict === 'error' || (folder && input.onConflict === 'overwrite')) throw new VfsError('NAME_CONFLICT');
				if (input.onConflict === 'overwrite') {
					return this.updateFile(diskFileId(loc.rootId, loc.path + name), input.body, { force: true, meta: input.meta, contentType: input.contentType });
				}
				name = withNumericSuffix(base, i);
			}
			await dir.getFileHandle(name, { create: true });
			const id = diskFileId(loc.rootId, loc.path + name);
			return this.updateFile(id, input.body, { force: true, meta: input.meta, contentType: input.contentType });
		});
	},
	async mkdir(parentId, name) {
		const loc = await location(parentId); const dir = loc.path ? await loc.dir.getDirectoryHandle(loc.name) : loc.root;
		const safe = sanitizeName(name); await dir.getDirectoryHandle(safe, { create: true });
		return (await this.get(diskFileId(loc.rootId, loc.path + safe + '/')))!;
	}
};
