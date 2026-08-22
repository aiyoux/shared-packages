/**
 * rclone RC simple file browser driver for hub File Explorer.
 * Completely separate from SharedVFS / Dexie. Injectable transport for tests.
 */
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	EXPLORER_LIST_MAX_ENTRIES,
	type ExplorerCapabilities,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerEntryId,
	type ExplorerListOptions,
	type ExplorerListResult
} from '../ui/explorerDriver.js';
import { inferFileTypeFromName } from '../index.js';
import { ExplorerRcloneError, mapRcloneError } from './errors.js';
import {
	baseName,
	breadcrumbChain,
	childId,
	isFolderId,
	parentIdOf,
	sanitizeSegment,
	toRemoteParam
} from './pathIds.js';
import type { RcloneTransport } from './rcloneSimulator.js';
import { normalizeRootPath, type RcloneConnectionProfileV1 } from './types.js';

const RCLONE_CAPS: ExplorerCapabilities = {
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

function sortFoldersFirst(entries: ExplorerEntry[]): ExplorerEntry[] {
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	});
}

function withSuffix(name: string, n: number): string {
	const i = name.lastIndexOf('.');
	if (i <= 0) return `${name} (${n})`;
	return `${name.slice(0, i)} (${n})${name.slice(i)}`;
}

export type RcloneExplorerDriverOptions = {
	profile: RcloneConnectionProfileV1;
	/**
	 * Injectable RC transport (simulator in tests; production uses proxy client in PR2).
	 * Required until production client is wired.
	 */
	transport: RcloneTransport;
};

type ListItem = {
	Path?: string;
	Name?: string;
	IsDir?: boolean;
	Size?: number;
	MimeType?: string;
	ModTime?: string;
};

export async function createRcloneExplorerDriver(
	opts: RcloneExplorerDriverOptions
): Promise<ExplorerDriver> {
	const profile = opts.profile;
	const transport = opts.transport;
	let rootPath: string;
	try {
		rootPath = normalizeRootPath(profile.rootPath);
	} catch {
		throw new ExplorerRcloneError('RCLONE_ERROR', 'Invalid rootPath');
	}
	const fs = profile.fs.trim();

	async function rc(method: string, params: Record<string, unknown> = {}) {
		try {
			return await transport.call(method, { fs, ...params });
		} catch (e) {
			throw mapRcloneError(e);
		}
	}

	async function uniqueName(parentId: ExplorerEntryId | null, baseNameStr: string): Promise<string> {
		let candidate = baseNameStr;
		let i = 0;
		for (;;) {
			const id = childId(parentId, candidate, false);
			const remote = toRemoteParam(rootPath, id);
			try {
				await rc('operations/stat', { remote });
				// exists
				i += 1;
				candidate = withSuffix(baseNameStr, i);
			} catch (e) {
				if (e instanceof ExplorerRcloneError && e.code === 'RCLONE_NOT_FOUND') {
					return candidate;
				}
				// other errors: still try candidate (stat optional)
				if (e instanceof ExplorerRcloneError && e.code !== 'RCLONE_NOT_FOUND') {
					// if network etc, return candidate and let upload fail
					return candidate;
				}
				return candidate;
			}
		}
	}

	const driver: ExplorerDriver = {
		id: 'rclone',
		connectionId: `rclone:${profile.id}`,
		endpointKey: `rclone:${profile.fs}::${rootPath}`,
		capabilities: RCLONE_CAPS,

		async ready() {
			try {
				await transport.call('rc/noopauth', {});
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]> {
			// clamp: id is relative to root already
			const chain = breadcrumbChain(id);
			return chain.map((c) => ({
				id: c.id,
				parentId: c.parentId,
				name: c.name,
				kind: 'folder' as const
			}));
		},

		async list(opts: ExplorerListOptions): Promise<ExplorerListResult> {
			try {
				const remote = toRemoteParam(rootPath, opts.parentId);
				const result = await rc('operations/list', {
					remote,
					// non-recursive (simulator ignores; real RC uses recurse:false)
					recurse: false
				});
				const raw = (result.list as ListItem[] | undefined) ?? [];
				const entries: ExplorerEntry[] = [];

				for (const item of raw) {
					const isDir = Boolean(item.IsDir);
					const name =
						item.Name ||
						(item.Path ? item.Path.replace(/\/+$/, '').split('/').pop() : '') ||
						'';
					if (!name || name === '.' || name === '..') continue;
					const id = childId(opts.parentId, name, isDir);
					if (isDir) {
						entries.push({
							id,
							parentId: opts.parentId,
							name,
							kind: 'folder'
						});
					} else {
						const size = typeof item.Size === 'number' && item.Size >= 0 ? item.Size : undefined;
						const updatedAt = item.ModTime ? Date.parse(item.ModTime) : undefined;
						entries.push({
							id,
							parentId: opts.parentId,
							name,
							kind: 'file',
							size,
							updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
							contentType: item.MimeType,
							fileType: inferFileTypeFromName(name)
						});
					}
				}

				let truncated = false;
				if (entries.length > EXPLORER_LIST_MAX_ENTRIES) {
					truncated = true;
					entries.length = EXPLORER_LIST_MAX_ENTRIES;
				}

				return {
					entries: sortFoldersFirst(entries),
					truncated
				};
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async mkdir(parentId, name) {
			try {
				const seg = sanitizeSegment(name);
				const id = childId(parentId, seg, true);
				const remote = toRemoteParam(rootPath, id);
				await rc('operations/mkdir', { remote });
				return {
					id,
					parentId,
					name: seg,
					kind: 'folder' as const
				};
			} catch (e) {
				if (e instanceof Error && e.message === 'INVALID_NAME') {
					throw new ExplorerRcloneError('INVALID_NAME', 'Invalid folder name');
				}
				throw mapRcloneError(e);
			}
		},

		async delete(id) {
			try {
				const remote = toRemoteParam(rootPath, id);
				if (isFolderId(id)) {
					// try rmdir first; if not empty, purge (design R18 recommended)
					try {
						await rc('operations/rmdir', { remote });
					} catch {
						await rc('operations/purge', { remote });
					}
				} else {
					await rc('operations/deletefile', { remote });
				}
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async rename(id, name) {
			if (isFolderId(id)) {
				throw new ExplorerRcloneError(
					'RCLONE_FOLDER_OP_UNSUPPORTED',
					'Folder rename not supported'
				);
			}
			try {
				const seg = sanitizeSegment(name);
				const parent = parentIdOf(id);
				const destName = await uniqueName(parent, seg);
				const destId = childId(parent, destName, false);
				const srcRemote = toRemoteParam(rootPath, id);
				const dstRemote = toRemoteParam(rootPath, destId);
				await rc('operations/movefile', {
					srcFs: fs,
					srcRemote,
					dstFs: fs,
					dstRemote
				});
				return {
					id: destId,
					parentId: parent,
					name: destName,
					kind: 'file' as const,
					fileType: inferFileTypeFromName(destName)
				};
			} catch (e) {
				if (e instanceof ExplorerRcloneError) throw e;
				if (e instanceof Error && e.message === 'INVALID_NAME') {
					throw new ExplorerRcloneError('INVALID_NAME', 'Invalid name');
				}
				throw mapRcloneError(e);
			}
		},

		async move(id, newParentId) {
			if (isFolderId(id)) {
				throw new ExplorerRcloneError(
					'RCLONE_FOLDER_OP_UNSUPPORTED',
					'Folder move not supported'
				);
			}
			try {
				const name = baseName(id);
				const destName = await uniqueName(newParentId, name);
				const destId = childId(newParentId, destName, false);
				const srcRemote = toRemoteParam(rootPath, id);
				const dstRemote = toRemoteParam(rootPath, destId);
				await rc('operations/movefile', {
					srcFs: fs,
					srcRemote,
					dstFs: fs,
					dstRemote
				});
			} catch (e) {
				if (e instanceof ExplorerRcloneError) throw e;
				throw mapRcloneError(e);
			}
		},

		async copy(id, newParentId) {
			if (isFolderId(id)) {
				throw new ExplorerRcloneError(
					'RCLONE_FOLDER_OP_UNSUPPORTED',
					'Folder copy not supported'
				);
			}
			try {
				const name = baseName(id);
				const destName = await uniqueName(newParentId, name);
				const destId = childId(newParentId, destName, false);
				const srcRemote = toRemoteParam(rootPath, id);
				const dstRemote = toRemoteParam(rootPath, destId);
				await rc('operations/copyfile', {
					srcFs: fs,
					srcRemote,
					dstFs: fs,
					dstRemote
				});
			} catch (e) {
				if (e instanceof ExplorerRcloneError) throw e;
				throw mapRcloneError(e);
			}
		},

		async upload(parentId, file, uploadOpts) {
			try {
				const destName = await uniqueName(parentId, file.name);
				const destId = childId(parentId, destName, false);
				const remote = toRemoteParam(rootPath, destId);
				await transport.upload({
					fs,
					remote,
					body: file,
					contentType: file.type || 'application/octet-stream',
					signal: uploadOpts?.signal,
					onProgress: uploadOpts?.onProgress
				});
				return {
					id: destId,
					parentId,
					name: destName,
					kind: 'file' as const,
					size: file.size,
					updatedAt: Date.now(),
					contentType: file.type || undefined,
					fileType: inferFileTypeFromName(destName)
				};
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async download(id) {
			try {
				if (isFolderId(id)) {
					throw new ExplorerRcloneError('RCLONE_ERROR', 'Cannot download a folder');
				}
				const remote = toRemoteParam(rootPath, id);
				// preflight size
				const st = await rc('operations/stat', { remote });
				const item = st.item as ListItem | undefined;
				const size = typeof item?.Size === 'number' ? item.Size : 0;
				if (size > EXPLORER_DOWNLOAD_MAX_BYTES) {
					throw new ExplorerRcloneError(
						'RCLONE_TOO_LARGE',
						`File exceeds ${EXPLORER_DOWNLOAD_MAX_BYTES} byte download limit`
					);
				}
				const blob = await transport.download({ fs, remote });
				if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
					throw new ExplorerRcloneError('RCLONE_TOO_LARGE', 'Download exceeded size cap');
				}
				return blob;
			} catch (e) {
				if (e instanceof ExplorerRcloneError) throw e;
				throw mapRcloneError(e);
			}
		}
	};

	return driver;
}
