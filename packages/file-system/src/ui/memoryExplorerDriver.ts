/**
 * Flat-list FileExplorer driver for the central in-memory VFS.
 * No folders, no trash, no sibling ordering — just a rootless list of files.
 * Distinct from `createLocalExplorerDriver` (which adapts the folder-capable
 * durable `VfsService`).
 */
import { MemoryVfsService } from '../memoryVfs.js';
import {
	applyListCap,
	type ExplorerCapabilities,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerListResult
} from './explorerDriver.js';

export const MEMORY_CAPS: ExplorerCapabilities = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: true,
	supportsMove: false,
	supportsCopy: false,
	supportsMkdir: false,
	supportsUpload: false,
	supportsDownload: true,
	supportsSiblingOrder: false,
	supportsDragOut: true
};

function toEntry(n: {
	id: string;
	name: string;
	fileType?: import('../types.js').FileTypeId;
	size: number;
	updatedAt: number;
	contentType?: string;
}): ExplorerEntry {
	return {
		id: n.id,
		parentId: null,
		name: n.name,
		kind: 'file',
		fileType: n.fileType,
		size: n.size,
		updatedAt: n.updatedAt,
		contentType: n.contentType
	};
}

export type MemoryExplorerDriverOptions = {
	capabilitiesPatch?: Partial<ExplorerCapabilities>;
};

export function createMemoryExplorerDriver(
	vfs: MemoryVfsService,
	opts?: MemoryExplorerDriverOptions
): ExplorerDriver {
	const caps: ExplorerCapabilities = { ...MEMORY_CAPS, ...opts?.capabilitiesPatch };

	return {
		id: 'memory',
		capabilities: caps,

		async ready() {
			await vfs.ready();
		},

		async list(): Promise<ExplorerListResult> {
			const nodes = await vfs.list({ sort: 'name' });
			return applyListCap(nodes.map(toEntry));
		},

		async getPath(id) {
			const n = await vfs.get(id);
			return n ? [toEntry(n)] : [];
		},

		async rename(id, name) {
			return toEntry(await vfs.rename(id, name));
		},

		async delete(id) {
			await vfs.delete(id);
		},

		async readBlob(id) {
			return vfs.readBlob(id);
		},

		async download(id) {
			return vfs.readBlob(id);
		},

		async writeFile(_parentId, file) {
			const body = new Uint8Array(await file.arrayBuffer());
			const n = await vfs.writeFile({
				parentId: null,
				name: file.name,
				body,
				contentType: file.type || undefined
			});
			return toEntry(n);
		},

		subscribeChanges(listener) {
			return vfs.subscribe(listener);
		}
	};
}