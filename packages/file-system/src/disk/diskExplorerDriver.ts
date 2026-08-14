/**
 * ExplorerDriver over a native directory the user granted via
 * `showDirectoryPicker` (File System Access API).
 */
import { inferFileTypeFromName } from '../index.js';
import {
	applyListCap,
	EXPLORER_DOWNLOAD_MAX_BYTES,
	type ExplorerCapabilities,
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

export function createDiskExplorerDriver(root: DiskDirHandle): ExplorerDriver {
	return {
		id: 'disk',
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

		async mkdir(parentId, name) {
			const dir = await walkDir(root, parentId);
			await dir.getDirectoryHandle(name, { create: true });
			return toEntry(joinId(parentId, name, true), 'folder');
		},

		async rename(id, name) {
			if (baseName(id) === name) {
				return toEntry(id, isFolderId(id) ? 'folder' : 'file');
			}
			const parent = parentIdOf(id);
			const destId = joinId(parent, name, isFolderId(id));
			assertDiskCopySafe(id, destId);
			if (isFolderId(id)) {
				const created = await this.mkdir!(parent, name);
				const children = await listAll(root, id);
				for (const child of children) await this.copy!(child.id, created.id);
				await this.delete(id);
				return created;
			}
			const blob = await this.readBlob!(id);
			const written = await this.writeFile!(
				parent,
				new File([blob], name, { type: blob.type })
			);
			if (written.id !== id) await this.delete(id);
			return written;
		},

		async move(id, newParentId) {
			const destId = joinId(newParentId, baseName(id), isFolderId(id));
			if (destId === id) return;
			assertDiskCopySafe(id, destId);
			await this.copy!(id, newParentId);
			await this.delete(id);
		},

		async copy(id, newParentId) {
			const name = baseName(id);
			const destId = joinId(newParentId, name, isFolderId(id));
			assertDiskCopySafe(id, destId);
			if (isFolderId(id)) {
				const created = await this.mkdir!(newParentId, name);
				const children = await listAll(root, id);
				for (const child of children) {
					await this.copy!(child.id, created.id);
				}
				return;
			}
			const blob = await this.readBlob!(id);
			const file = new File([blob], name, { type: blob.type });
			await this.writeFile!(newParentId, file);
		},

		async delete(id) {
			const parent = parentIdOf(id);
			const dir = await walkDir(root, parent);
			await dir.removeEntry(baseName(id), { recursive: isFolderId(id) });
		},

		async upload(parentId, file) {
			return this.writeFile!(parentId, file);
		},

		async writeFile(parentId, file) {
			const dir = await walkDir(root, parentId);
			const fh = await dir.getFileHandle(file.name, { create: true });
			const w = await fh.createWritable();
			await w.write(file);
			await w.close();
			return toEntry(joinId(parentId, file.name, false), 'file', {
				size: file.size,
				contentType: file.type || undefined,
				fileType: inferFileTypeFromName(file.name)
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

		async download(id) {
			return this.readBlob!(id);
		}
	};
}
