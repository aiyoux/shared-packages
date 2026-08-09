/**
 * Local SharedVFS adapter for FileExplorer.
 */
import type { VfsService } from '../vfs.js';
import type { VfsNode } from '../types.js';
import {
	applyListCap,
	nodeToEntry,
	type ExplorerCapabilities,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerEntryId,
	type ExplorerListOptions,
	type ExplorerListResult
} from './explorerDriver.js';

const LOCAL_CAPS: ExplorerCapabilities = {
	supportsTrash: true,
	supportsSoftDelete: true,
	supportsRename: true,
	supportsMove: true,
	supportsCopy: true,
	supportsMkdir: true,
	supportsUpload: false,
	supportsDownload: false
};

function mapNodes(nodes: VfsNode[]): ExplorerEntry[] {
	return nodes.map((n) => nodeToEntry(n));
}

export function createLocalExplorerDriver(vfs: VfsService): ExplorerDriver {
	return {
		id: 'local',
		capabilities: LOCAL_CAPS,

		async ready() {
			await vfs.ready();
		},

		async list(opts: ExplorerListOptions): Promise<ExplorerListResult> {
			const nodes = await vfs.list({
				parentId: opts.parentId,
				trashOnly: opts.trashOnly
			});
			return applyListCap(mapNodes(nodes));
		},

		async getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]> {
			const path = await vfs.getPath(id);
			return mapNodes(path);
		},

		async mkdir(parentId, name) {
			const n = await vfs.mkdir(parentId, name);
			return nodeToEntry(n);
		},

		async rename(id, name) {
			const n = await vfs.rename(id, name);
			return nodeToEntry(n);
		},

		async move(id, newParentId) {
			await vfs.move(id, newParentId);
		},

		async copy(id, newParentId) {
			await vfs.copy(id, newParentId);
		},

		async delete(id) {
			await vfs.trash(id);
		},

		async restore(id) {
			await vfs.restore(id);
		},

		async permanentDelete(id) {
			await vfs.permanentDelete(id, { recursive: true });
		},

		async emptyTrash() {
			await vfs.emptyTrash();
		}
	};
}
