/**
 * ExplorerDriver over a native directory the user granted via
 * `showDirectoryPicker` (File System Access API).
 */
import { inferFileTypeFromName } from '../index.js';
import { withNumericSuffix } from '../names.js';
import { emitBlobChunks } from '../readProgress.js';
import {
	applyListCap,
	EXPLORER_DOWNLOAD_MAX_BYTES,
	type ExplorerCapabilities,
	type ExplorerDiskRoot,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerEntryId,
	type ExplorerListOptions,
	type ExplorerListResult
} from '../ui/explorerDriver.js';
import type { DiskDirHandle, DiskFileHandle } from './handles.js';
import { baseName, isFolderId, joinId, parentIdOf, pathSegments } from './pathIds.js';

export const DISK_CAPS: ExplorerCapabilities = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: true,
	supportsMove: true,
	supportsCopy: true,
	supportsMkdir: true,
	supportsUpload: true,
	supportsDownload: true,
	supportsSiblingOrder: false,
	supportsDragOut: true
};

async function walkDir(root: DiskDirHandle, id: string | null): Promise<DiskDirHandle> {
	let dir = root;
	for (const seg of pathSegments(id)) {
		dir = await dir.getDirectoryHandle(seg);
	}
	return dir;
}

function toEntry(
	id: string,
	kind: 'folder' | 'file',
	extra?: Partial<ExplorerEntry>
): ExplorerEntry {
	return {
		id,
		parentId: parentIdOf(id),
		name: baseName(id),
		kind,
		...extra
	};
}

/** True when dest is the source, or a folder dest that lives under source. */
export function isDiskCycle(srcId: string, destId: string): boolean {
	if (srcId === destId) return true;
	if (isFolderId(srcId) && destId.startsWith(srcId)) return true;
	return false;
}

function assertDiskCopySafe(srcId: string, destId: string): void {
	if (isDiskCycle(srcId, destId)) {
		throw new Error('CYCLE');
	}
}

async function nameTaken(dir: DiskDirHandle, name: string): Promise<boolean> {
	try {
		await dir.getFileHandle(name);
		return true;
	} catch (e) {
		// Only a genuine miss frees the name. Anything else (TypeMismatchError when
		// a folder holds it, a permission failure) counts as taken — guessing wrong
		// in that direction costs a suffix, guessing wrong the other way overwrites
		// the user's file.
		return (e as DOMException | undefined)?.name !== 'NotFoundError';
	}
}

/**
 * Free name for a new file in `dir`, renaming on conflict the way
 * `VfsService.ensureUniqueName` does. There is no sibling index on disk, so
 * each candidate is probed individually.
 */
export async function uniqueDiskName(dir: DiskDirHandle, name: string): Promise<string> {
	if (!(await nameTaken(dir, name))) return name;
	for (let i = 1; i <= 1000; i++) {
		const candidate = withNumericSuffix(name, i);
		if (!(await nameTaken(dir, candidate))) return candidate;
	}
	throw new Error('NAME_CONFLICT');
}

async function listAll(root: DiskDirHandle, parentId: string | null): Promise<ExplorerEntry[]> {
	const dir = await walkDir(root, parentId);
	const entries: ExplorerEntry[] = [];
	for await (const [name, handle] of dir.entries()) {
		const kind = handle.kind === 'directory' ? 'folder' : 'file';
		const id = joinId(parentId, name, kind === 'folder');
		const extra: Partial<ExplorerEntry> = {};
		if (kind === 'file') {
			try {
				const file = await (handle as DiskFileHandle).getFile();
				extra.size = file.size;
				extra.updatedAt = file.lastModified;
				extra.contentType = file.type || undefined;
				extra.fileType = inferFileTypeFromName(name);
			} catch {
				extra.fileType = inferFileTypeFromName(name);
			}
		}
		entries.push(toEntry(id, kind, extra));
	}
	entries.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	});
	return entries;
}

type FolderWatchers = Map<ExplorerEntryId | null, Set<() => void>>;

/**
 * A picked folder has no OS watch, so a write through a driver is the only
 * change signal. Two panes on one folder hold two drivers sharing a
 * `connectionId` (see DualPaneExplorer's `rememberDiskRoot`), so watchers are
 * keyed by that — or by the handle before one is assigned — and then by the
 * folder each explorer shows.
 */
const watchersByRoot = new Map<unknown, FolderWatchers>();

export function createDiskExplorerDriver(root: DiskDirHandle): ExplorerDriver {
	const rootKey = (): unknown => driver.connectionId ?? root;
	// Folders whose listing changed, and folders that no longer exist, since the
	// outermost operation began. A folder move is hundreds of leaf writes; the
	// panes hear about it once, when it ends — or fails part way.
	const changed = new Set<ExplorerEntryId | null>();
	const removed = new Set<ExplorerEntryId>();
	let depth = 0;

	function notify() {
		const watchers = watchersByRoot.get(rootKey());
		const hit = [...changed];
		const gone = [...removed];
		changed.clear();
		removed.clear();
		if (!watchers) return;
		for (const [folder, listeners] of [...watchers]) {
			const stale = hit.includes(folder) ||
				(folder !== null && gone.some((id) => folder.startsWith(id)));
			if (!stale) continue;
			for (const fn of [...listeners]) {
				try {
					fn();
				} catch {
					/* a stale explorer must not break writers */
				}
			}
		}
	}

	async function mutation<T>(run: () => Promise<T>): Promise<T> {
		depth += 1;
		try {
			return await run();
		} finally {
			depth -= 1;
			if (depth === 0) notify();
		}
	}

	const driver: ExplorerDriver = {
		id: 'disk',
		diskRoot: root as ExplorerDiskRoot,
		capabilities: DISK_CAPS,

		async ready() {
			if (root.queryPermission) {
				let perm = await root.queryPermission({ mode: 'readwrite' });
				if (perm !== 'granted' && root.requestPermission) {
					perm = await root.requestPermission({ mode: 'readwrite' });
				}
				if (perm !== 'granted') throw new Error('DISK_PERMISSION_DENIED');
			}
		},

		async getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]> {
			const segs = pathSegments(id);
			const out: ExplorerEntry[] = [];
			let acc: string | null = null;
			for (const seg of segs) {
				const isLast = seg === segs[segs.length - 1];
				const asDir = !isLast || isFolderId(id);
				acc = joinId(acc, seg, asDir);
				out.push(toEntry(acc, asDir ? 'folder' : 'file'));
			}
			return out;
		},

		async list(opts: ExplorerListOptions): Promise<ExplorerListResult> {
			return applyListCap(await listAll(root, opts.parentId));
		},

		subscribeChanges(listener, scope) {
			const key = rootKey();
			const folder = scope?.parentId ?? null;
			let watchers = watchersByRoot.get(key);
			if (!watchers) watchersByRoot.set(key, (watchers = new Map()));
			let listeners = watchers.get(folder);
			if (!listeners) watchers.set(folder, (listeners = new Set()));
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size) return;
				watchers.delete(folder);
				if (!watchers.size) watchersByRoot.delete(key);
			};
		},

		mkdir(parentId, name) {
			return mutation(async () => {
				const dir = await walkDir(root, parentId);
				await dir.getDirectoryHandle(name, { create: true });
				changed.add(parentId);
				return toEntry(joinId(parentId, name, true), 'folder');
			});
		},

		rename(id, name) {
			return mutation(async () => {
				if (baseName(id) === name) {
					return toEntry(id, isFolderId(id) ? 'folder' : 'file');
				}
				const parent = parentIdOf(id);
				const destId = joinId(parent, name, isFolderId(id));
				assertDiskCopySafe(id, destId);
				if (isFolderId(id)) {
					const created = await driver.mkdir!(parent, name);
					const children = await listAll(root, id);
					for (const child of children) await driver.copy!(child.id, created.id);
					await driver.delete(id);
					return created;
				}
				const blob = await driver.readBlob!(id);
				const written = await driver.writeFile!(
					parent,
					new File([blob], name, { type: blob.type })
				);
				if (written.id !== id) await driver.delete(id);
				return written;
			});
		},

		move(id, newParentId) {
			return mutation(async () => {
				const destId = joinId(newParentId, baseName(id), isFolderId(id));
				if (destId === id) return;
				assertDiskCopySafe(id, destId);
				await driver.copy!(id, newParentId);
				await driver.delete(id);
			});
		},

		copy(id, newParentId) {
			return mutation(async () => {
				const name = baseName(id);
				const destId = joinId(newParentId, name, isFolderId(id));
				assertDiskCopySafe(id, destId);
				if (isFolderId(id)) {
					const created = await driver.mkdir!(newParentId, name);
					const children = await listAll(root, id);
					for (const child of children) {
						await driver.copy!(child.id, created.id);
					}
					return;
				}
				const blob = await driver.readBlob!(id);
				const file = new File([blob], name, { type: blob.type });
				await driver.writeFile!(newParentId, file);
			});
		},

		delete(id) {
			return mutation(async () => {
				const parent = parentIdOf(id);
				const dir = await walkDir(root, parent);
				await dir.removeEntry(baseName(id), { recursive: isFolderId(id) });
				changed.add(parent);
				if (isFolderId(id)) removed.add(id);
			});
		},

		async upload(parentId, file) {
			return driver.writeFile!(parentId, file);
		},

		writeFile(parentId, file) {
			return mutation(async () => {
				const dir = await walkDir(root, parentId);
				// `getFileHandle(name, { create: true })` opens an existing entry rather
				// than failing, and `createWritable()` truncates it — so without this
				// probe a same-name file on the user's real disk is silently destroyed,
				// with no trash to recover it from. Rename instead, as every other
				// driver here does.
				const name = await uniqueDiskName(dir, file.name);
				const fh = await dir.getFileHandle(name, { create: true });
				const w = await fh.createWritable();
				await w.write(file);
				await w.close();
				changed.add(parentId);
				return toEntry(joinId(parentId, name, false), 'file', {
					size: file.size,
					contentType: file.type || undefined,
					fileType: inferFileTypeFromName(name)
				});
			});
		},

		async readBlob(id) {
			if (isFolderId(id)) throw new Error('NOT_A_FILE');
			const parent = parentIdOf(id);
			const dir = await walkDir(root, parent);
			const fh = await dir.getFileHandle(baseName(id));
			const file = await fh.getFile();
			if (file.size > EXPLORER_DOWNLOAD_MAX_BYTES) throw new Error('EXPLORER_TOO_LARGE');
			return file;
		},

		async download(id, opts) {
			const blob = await this.readBlob!(id);
			if (opts?.onChunk) {
				await emitBlobChunks(blob, { onChunk: opts.onChunk, onProgress: opts.onProgress });
			}
			return opts?.assemble === false ? new Blob([], { type: blob.type }) : blob;
		}
	};
	return driver;
}
