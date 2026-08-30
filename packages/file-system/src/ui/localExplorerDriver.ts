/**
 * Local durable SharedVFS adapter for FileExplorer.
 * For the flat in-memory VFS use `createMemoryExplorerDriver` instead.
 */
import type { VfsNode } from '../types.js';
import type { VfsService } from '../vfs.js';
import { emitBlobChunks } from '../readProgress.js';
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
	supportsUpload: true,
	supportsDownload: true,
	supportsSiblingOrder: true,
	supportsDragOut: true
};

function mapNodes(nodes: VfsNode[]): ExplorerEntry[] {
	return nodes.map((n) => nodeToEntry(n));
}

/** Shared surface used by the durable VfsService. The flat MemoryVfsService is
 * not shape-compatible (no folders/trash/reorder) — use `createMemoryExplorerDriver`.
 */
export type LocalVfsLike = Pick<
	VfsService,
	| 'ready'
	| 'list'
	| 'getPath'
	| 'mkdir'
	| 'ensureFolders'
	| 'batch'
	| 'rename'
	| 'move'
	| 'copy'
	| 'reorder'
	| 'trash'
	| 'restore'
	| 'permanentDelete'
	| 'emptyTrash'
	| 'readBlob'
	| 'subscribe'
> &
	Partial<Pick<VfsService, 'liveList' | 'writeFiles'>>;

export type LocalExplorerDriverOptions = {
	/** Driver id: `local` (default) or `memory`. */
	id?: string;
	/** Patch capabilities (e.g. memory download true). */
	capabilitiesPatch?: Partial<ExplorerCapabilities>;
};

export function createLocalExplorerDriver(
	vfs: LocalVfsLike,
	opts?: LocalExplorerDriverOptions
): ExplorerDriver {
	const caps: ExplorerCapabilities = {
		...LOCAL_CAPS,
		...opts?.capabilitiesPatch
	};
	const id = opts?.id ?? 'local';

	return {
		id,
		capabilities: caps,

		async ready() {
			await vfs.ready();
		},

		async list(listOpts: ExplorerListOptions): Promise<ExplorerListResult> {
			const nodes = await vfs.list({
				parentId: listOpts.parentId,
				trashOnly: listOpts.trashOnly,
				sort: caps.supportsSiblingOrder ? 'order' : 'name'
			});
			return applyListCap(mapNodes(nodes));
		},

		async getPath(entryId: ExplorerEntryId): Promise<ExplorerEntry[]> {
			const path = await vfs.getPath(entryId);
			return mapNodes(path);
		},

		async mkdir(parentId, name) {
			const n = await vfs.mkdir(parentId, name);
			return nodeToEntry(n);
		},

		batch: typeof vfs.batch === 'function' ? (fn) => vfs.batch!(fn) : undefined,

		async ensureFolders(parentId, paths) {
			if (typeof vfs.ensureFolders !== 'function') {
				const out = new Map<string, string | null>([['', parentId]]);
				return out;
			}
			return vfs.ensureFolders(parentId, paths);
		},

		async rename(entryId, name) {
			const n = await vfs.rename(entryId, name);
			return nodeToEntry(n);
		},

		async move(entryId, newParentId) {
			await vfs.move(entryId, newParentId);
		},

		async copy(entryId, newParentId) {
			await vfs.copy(entryId, newParentId);
		},

		async reorder(entryId, reorderOpts) {
			await vfs.reorder(entryId, reorderOpts);
		},

		async delete(entryId) {
			await vfs.trash(entryId);
		},

		async restore(entryId) {
			await vfs.restore(entryId);
		},

		async permanentDelete(entryId) {
			await vfs.permanentDelete(entryId, { recursive: true });
		},

		async emptyTrash(opts) {
			await vfs.emptyTrash(opts);
		},

		async readBlob(entryId) {
			return vfs.readBlob(entryId);
		},

		async download(entryId, opts) {
			const blob = await vfs.readBlob(entryId);
			if (opts?.onChunk) {
				await emitBlobChunks(blob, { onChunk: opts.onChunk, onProgress: opts.onProgress });
			}
			return opts?.assemble === false ? new Blob([], { type: blob.type }) : blob;
		},

		async writeFile(parentId, file) {
			// Pass the File through: serializeBody snapshots it once, and the
			// old arrayBuffer() rewrap added a full extra copy per written file.
			const n = await (vfs as unknown as { writeFile: (i: {
				parentId: string | null;
				name: string;
				body: unknown;
				contentType?: string;
			}) => Promise<import('../types.js').VfsNode> }).writeFile({
				parentId,
				name: file.name,
				body: file,
				contentType: file.type || undefined
			});
			return nodeToEntry(n);
		},

		async writeFiles(parentId, files, opts) {
			if (!vfs.writeFiles) {
				// Older VfsService without the bulk path. Correct but far
				// slower (one write per file instead of a batched chunk), so it
				// is announced rather than left to look like an unexplained
				// slowdown.
				console.warn(
					'[vfs] bulk write unavailable on this VfsService; writing ' +
						`${files.length} files one at a time.`
				);
				const out: ExplorerEntry[] = [];
				for (const file of files) {
					if (opts?.signal?.aborted) break;
					out.push(await this.writeFile!(parentId, file));
				}
				return out;
			}
			const nodes = await vfs.writeFiles(
				files.map((file) => ({
					parentId,
					name: file.name,
					body: file,
					contentType: file.type || undefined
				})),
				{
					signal: opts?.signal,
					pack: opts?.pack,
					onProgress: opts?.onProgress
						? (written) => opts.onProgress!(written.map(nodeToEntry))
						: undefined
				}
			);
			return nodes.map(nodeToEntry);
		},

		async writeFilesAcross(files, opts) {
			if (!vfs.writeFiles) {
				const out: ExplorerEntry[] = [];
				for (const { parentId, file } of files) {
					if (opts?.signal?.aborted) break;
					out.push(await this.writeFile!(parentId, file));
				}
				return out;
			}
			// One call, mixed parents: the store chunks it, and a pack spans the
			// whole chunk rather than one per folder.
			const nodes = await vfs.writeFiles(
				files.map(({ parentId, file }) => ({
					parentId,
					name: file.name,
					body: file,
					contentType: file.type || undefined
				})),
				{
					signal: opts?.signal,
					pack: opts?.pack,
					onProgress: opts?.onProgress
						? (written) => opts.onProgress!(written.map(nodeToEntry))
						: undefined
				}
			);
			return nodes.map(nodeToEntry);
		},

		subscribeChanges(listener, scope) {
			const unsubs: Array<() => void> = [];
			if (vfs.subscribe) unsubs.push(vfs.subscribe(listener));
			if (vfs.liveList) {
				const sub = vfs
					.liveList({
						parentId: scope?.parentId ?? null,
						trashOnly: false,
						sort: caps.supportsSiblingOrder ? 'order' : 'name'
					})
					.subscribe(() => {
						try {
							listener();
						} catch {
							/* a stale explorer must not break writers */
						}
					});
				unsubs.push(() => {
					try {
						sub.unsubscribe();
					} catch {
						/* ignore */
					}
				});
			}
			return () => {
				for (const u of unsubs) u();
			};
		}
	};
}
