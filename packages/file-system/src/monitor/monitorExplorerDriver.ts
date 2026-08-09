/**
 * Monitor local-fs browser driver (via hub proxy → monitor /v1/fs).
 * Read-only: list + download. Live list refresh via watch WebSocket.
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
import { startWatchSession, type WatchSession, type WatchSessionStatus } from './watchSession.js';

const MONITOR_CAPS: ExplorerCapabilities = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: false,
	supportsMove: false,
	supportsCopy: false,
	supportsMkdir: false,
	supportsUpload: false,
	supportsDownload: true,
	supportsSiblingOrder: false
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
	getWatchStatus(): WatchSessionStatus | 'off';
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

	const changeListeners = new Set<() => void>();
	let watch: WatchSession | null = null;
	let watchStatus: WatchSessionStatus | 'off' = enableWatch ? 'connecting' : 'off';

	const notifyListeners = () => {
		for (const l of changeListeners) {
			try {
				l();
			} catch {
				/* ignore listener errors */
			}
		}
	};

	function ensureWatch() {
		if (!enableWatch || watch) return;
		if (typeof WebSocket === 'undefined') {
			watchStatus = 'off';
			return;
		}
		watch = startWatchSession({
			baseUrl: transport.baseUrl,
			rootPath,
			ensureRoot: (path, recursive) => transport.watchAddRoot(path, recursive),
			onChange: notifyListeners,
			onStatus: (s) => {
				watchStatus = s;
			},
			debounceMs: 120
		});
	}

	const driver: MonitorExplorerDriver = {
		id: 'monitor',
		capabilities: MONITOR_CAPS,

		getWatchStatus() {
			return watch?.getStatus() ?? watchStatus;
		},

		async ready() {
			try {
				// Browse-only probe — do not start WS here (subscribeChanges starts watch).
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

		async download(id: ExplorerEntryId) {
			if (isFolderId(id)) {
				throw new ExplorerMonitorError('MONITOR_ERROR', 'Cannot download a folder');
			}
			try {
				const abs = toAbsolutePath(rootPath, id);
				const blob = await transport.download(abs);
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

		subscribeChanges(listener: () => void) {
			changeListeners.add(listener);
			ensureWatch();
			return () => {
				changeListeners.delete(listener);
			};
		},

		dispose() {
			changeListeners.clear();
			watch?.stop();
			watch = null;
			watchStatus = 'closed';
		}
	};

	return driver;
}
