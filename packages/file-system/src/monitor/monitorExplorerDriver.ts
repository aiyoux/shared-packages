/**
 * Monitor local-fs browser driver (browser → profile baseUrl /v1/fs).
 * Read-only: list + download. Live list refresh via fetch-based SSE.
 * Open-with off (remote-class).
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
import { ExplorerMonitorError, mapMonitorError } from './errors.js';
import {
	baseName,
	breadcrumbChain,
	isFolderId,
	parentIdOf,
	relativeIdFromAbsolute,
	toAbsolutePath
} from './pathIds.js';
import type { MonitorTransport } from './client.js';
import { normalizeMonitorRootPath, type MonitorConnectionProfileV1 } from './types.js';
import {
	createMonitorWatchStream,
	type MonitorWatchStream,
	type WatchStreamStatus
} from './watchStream.js';

const MONITOR_CAPS: ExplorerCapabilities = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: false,
	supportsMove: false,
	supportsCopy: false,
	supportsMkdir: false,
	supportsUpload: false,
	supportsDownload: true,
	supportsSiblingOrder: false,
	/** Native drag so DualPane / CM send-zone can copy or download-then-send. */
	supportsDragOut: true
};

function sortFoldersFirst(entries: ExplorerEntry[]): ExplorerEntry[] {
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	});
}

export type MonitorExplorerDriverOptions = {
	profile: MonitorConnectionProfileV1;
	transport: MonitorTransport;
	/** Disable live watch (tests). Default true. */
	enableWatch?: boolean;
};

export type MonitorExplorerDriver = ExplorerDriver & {
	/** Live watch status for UI / e2e (`data-monitor-watch-status`) */
	getWatchStatus(): WatchStreamStatus | 'off';
};

export async function createMonitorExplorerDriver(
	opts: MonitorExplorerDriverOptions
): Promise<MonitorExplorerDriver> {
	const profile = opts.profile;
	const transport = opts.transport;
	const enableWatch = opts.enableWatch !== false;
	let rootPath: string;
	try {
		rootPath = normalizeMonitorRootPath(profile.rootPath);
	} catch {
		throw new ExplorerMonitorError('MONITOR_ERROR', 'Invalid rootPath');
	}

	let watch: MonitorWatchStream | null = null;
	let watchStatus: WatchStreamStatus | 'off' = enableWatch ? 'connecting' : 'off';

	function ensureWatch(): MonitorWatchStream | null {
		if (!enableWatch) return null;
		if (typeof fetch === 'undefined') {
			watchStatus = 'off';
			return null;
		}
		if (!watch) {
			watch = createMonitorWatchStream({
				transport,
				onStatus: (s) => {
					watchStatus = s;
				},
				debounceMs: 120
			});
		}
		return watch;
	}

	const driver: MonitorExplorerDriver = {
		id: 'monitor',
		capabilities: MONITOR_CAPS,

		getWatchStatus() {
			return watch?.getStatus() ?? watchStatus;
		},

		async ready() {
			try {
				// Browse-only probe — do not start SSE here (subscribeChanges starts watch).
				await transport.health();
				await transport.stat(rootPath);
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]> {
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
				const abs = toAbsolutePath(rootPath, opts.parentId);
				const result = await transport.list(abs);
				const entries: ExplorerEntry[] = [];
				for (const item of result.entries) {
					if (entries.length >= EXPLORER_LIST_MAX_ENTRIES) break;
					const isDir = item.kind === 'folder' || item.kind === 'dir';
					let rel: string;
					try {
						rel = relativeIdFromAbsolute(rootPath, item.path, isDir);
					} catch {
						continue;
					}
					if (!rel && isDir) continue;
					const id = isDir ? (rel.endsWith('/') ? rel : `${rel}/`) : rel;
					const parentId = parentIdOf(id);
					entries.push({
						id,
						parentId,
						name: item.name || baseName(id),
						kind: isDir ? 'folder' : 'file',
						size: item.size,
						updatedAt: item.mtime_ms,
						fileType: isDir ? undefined : inferFileTypeFromName(item.name)
					});
				}
				const truncated =
					result.truncated || entries.length >= EXPLORER_LIST_MAX_ENTRIES;
				return { entries: sortFoldersFirst(entries), truncated };
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async delete() {
			throw new ExplorerMonitorError(
				'MONITOR_READONLY',
				'Monitor connection is read-only'
			);
		},

		async download(id: ExplorerEntryId, dlOpts) {
			if (isFolderId(id)) {
				throw new ExplorerMonitorError('MONITOR_ERROR', 'Cannot download a folder');
			}
			try {
				const abs = toAbsolutePath(rootPath, id);
				const blob = await transport.download(abs, { onProgress: dlOpts?.onProgress });
				if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
					throw new ExplorerMonitorError(
						'MONITOR_TOO_LARGE',
						`File exceeds ${EXPLORER_DOWNLOAD_MAX_BYTES} bytes`
					);
				}
				return blob;
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		subscribeChanges(listener: () => void, scope?: { parentId: ExplorerEntryId | null }) {
			const stream = ensureWatch();
			if (!stream) return () => {};
			// Watch the folder on screen, not the profile root: a recursive root
			// watch costs inotify descriptors for the whole subtree and reports
			// changes nobody is looking at. Panes and tree rows each subscribe their
			// own folder; the stream shares one connection across all of them.
			return stream.watchFolder(toAbsolutePath(rootPath, scope?.parentId ?? null), listener);
		},

		dispose() {
			watch?.stop();
			watch = null;
			watchStatus = 'closed';
		}
	};

	return driver;
}
