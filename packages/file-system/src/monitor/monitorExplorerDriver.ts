/**
 * Monitor local-fs browser driver (browser → profile baseUrl /v1/fs).
 * List + download + upload + same-host copy. Live list refresh via SSE.
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
	childId,
	isFolderId,
	parentIdOf,
	relativeIdFromAbsolute,
	sanitizeSegment,
	toAbsolutePath
} from './pathIds.js';
import type { MonitorTransport } from './client.js';
import { normalizeMonitorRootPath, type MonitorConnectionProfileV1 } from './types.js';
import {
	createMonitorWatchStream,
	type MonitorWatchStream,
	type WatchStreamStatus
} from './watchStream.js';

function monitorCaps(rename: boolean, mkdir: boolean): ExplorerCapabilities {
	return {
		supportsTrash: false,
		supportsSoftDelete: false,
		supportsRename: rename,
		supportsMove: rename,
		supportsCopy: true,
		supportsMkdir: mkdir,
		supportsUpload: true,
		supportsDownload: true,
		supportsSiblingOrder: false,
		/** Native drag so DualPane / CM send-zone can copy or download-then-send. */
		supportsDragOut: true
	};
}

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
	readonly monitorClient: MonitorTransport;
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
	let cachedMeta: Awaited<ReturnType<MonitorTransport['meta']>> | null = null;

	async function loadMeta() {
		if (cachedMeta) return cachedMeta;
		if (!transport.meta) {
			cachedMeta = { capabilities: { fs: { ino: false, rename: false, archive: false }, git: { blob: false } } };
			return cachedMeta;
		}
		try {
			cachedMeta = await transport.meta();
		} catch {
			cachedMeta = { capabilities: { fs: { ino: false, rename: false, archive: false }, git: { blob: false } } };
		}
		return cachedMeta;
	}

	const meta = await loadMeta();
	const canRename = meta.capabilities?.fs?.rename === true;
	const canArchive = meta.capabilities?.fs?.archive === true;
	const canMkdir = meta.capabilities?.fs?.mkdir === true;

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

	function withSuffix(name: string, n: number): string {
		const i = name.lastIndexOf('.');
		if (i <= 0) return `${name} (${n})`;
		return `${name.slice(0, i)} (${n})${name.slice(i)}`;
	}

	async function uniqueName(
		parentId: ExplorerEntryId | null,
		base: string,
		excludeId?: ExplorerEntryId
	): Promise<string> {
		let used = new Set<string>();
		try {
			const result = await transport.list(toAbsolutePath(rootPath, parentId));
			used = new Set(result.entries.map((e) => e.name));
		} catch {
			return base;
		}
		// Rename / same-folder move must not treat the source itself as a collision.
		if (excludeId != null && parentIdOf(excludeId) === parentId) {
			used.delete(baseName(excludeId));
		}
		if (!used.has(base)) return base;
		for (let i = 1; i < 200; i++) {
			const next = withSuffix(base, i);
			if (!used.has(next)) return next;
		}
		return `${Date.now()}-${base}`;
	}

	function endpointKeyFromUrl(baseUrl: string): string {
		try {
			const u = new URL(baseUrl);
			u.hash = '';
			u.search = '';
			return `monitor:${u.href.replace(/\/+$/, '').toLowerCase()}`;
		} catch {
			return `monitor:${baseUrl.replace(/\/+$/, '').toLowerCase()}`;
		}
	}

	const driver: MonitorExplorerDriver = {
		id: 'monitor',
		connectionId: `monitor:${profile.id}`,
		endpointKey: endpointKeyFromUrl(transport.baseUrl || profile.baseUrl),
		monitorClient: transport,
		capabilities: monitorCaps(canRename, canMkdir),

		absolutePath(id: ExplorerEntryId) {
			return toAbsolutePath(rootPath, id);
		},

		async uniqueName(parentId, base) {
			return uniqueName(parentId, base);
		},

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
					const metaFields: Record<string, unknown> = {};
					if (item.ino != null) metaFields.ino = item.ino;
					if (item.dev != null) metaFields.dev = item.dev;
					entries.push({
						id,
						parentId,
						name: item.name || baseName(id),
						kind: isDir ? 'folder' : 'file',
						size: item.size,
						updatedAt: item.mtime_ms,
						fileType: isDir ? undefined : inferFileTypeFromName(item.name),
						meta: Object.keys(metaFields).length ? metaFields : undefined
					});
				}
				const truncated =
					result.truncated || entries.length >= EXPLORER_LIST_MAX_ENTRIES;
				return { entries: sortFoldersFirst(entries), truncated };
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async delete(id: ExplorerEntryId) {
			try {
				const abs = toAbsolutePath(rootPath, id);
				if (abs === rootPath) {
					throw new ExplorerMonitorError('MONITOR_FORBIDDEN', 'Cannot delete the connection root');
				}
				await transport.unlink(abs);
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async upload(parentId, file, opts) {
			try {
				const destName = await uniqueName(parentId, file.name);
				const destRel = childId(parentId, destName, false);
				const abs = toAbsolutePath(rootPath, destRel);
				const st = await transport.write(abs, file, {
					signal: opts?.signal,
					onProgress: (n, total) => {
						const t = total ?? file.size ?? 1;
						opts?.onProgress?.(n / Math.max(t, 1));
					}
				});
				return {
					id: destRel,
					parentId,
					name: destName,
					kind: 'file' as const,
					size: st.size ?? file.size,
					updatedAt: st.mtime_ms,
					contentType: file.type || undefined,
					fileType: inferFileTypeFromName(destName)
				};
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async copy(id, newParentId, opts) {
			if (isFolderId(id)) {
				throw new ExplorerMonitorError('MONITOR_ERROR', 'Folder copy is not supported');
			}
			try {
				const destName = await uniqueName(newParentId, baseName(id));
				const destRel = childId(newParentId, destName, false);
				const from = toAbsolutePath(rootPath, id);
				const to = toAbsolutePath(rootPath, destRel);
				await transport.copy(from, to, {
					signal: opts?.signal,
					onProgress: opts?.onProgress
				});
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async copyFromAbsolute(fromAbs, destParentId, sourceName, opts) {
			try {
				const destName = await uniqueName(destParentId, sourceName);
				const destRel = childId(destParentId, destName, false);
				const to = toAbsolutePath(rootPath, destRel);
				await transport.copy(fromAbs, to, {
					signal: opts?.signal,
					onProgress: opts?.onProgress
				});
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async pullFromUrl(url, destParentId, sourceName, opts) {
			try {
				const destName = await uniqueName(destParentId, sourceName);
				const destRel = childId(destParentId, destName, false);
				const to = toAbsolutePath(rootPath, destRel);
				await transport.pull(url, to, {
					signal: opts?.signal,
					onProgress: opts?.onProgress
				});
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async pushToUpload(id, upload, opts) {
			try {
				const from = toAbsolutePath(rootPath, id);
				await transport.push(
					{
						from,
						uploadUrl: upload.uploadUrl,
						token: upload.authorizationToken,
						fileName: upload.destFileName,
						contentType: upload.contentType
					},
					{
						signal: opts?.signal,
						onProgress: opts?.onProgress,
						onEvent: opts?.onEvent
					}
				);
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async writeExactName(parentId, file, exactName, opts) {
			try {
				const destRel = childId(parentId, exactName, false);
				const abs = toAbsolutePath(rootPath, destRel);
				const st = await transport.write(abs, file, {
					signal: opts?.signal,
					onProgress: opts?.onProgress
				});
				return {
					id: destRel,
					parentId,
					name: exactName,
					kind: 'file' as const,
					size: st.size ?? file.size,
					updatedAt: st.mtime_ms,
					contentType: file.type || undefined,
					fileType: inferFileTypeFromName(exactName)
				};
			} catch (e) {
				throw mapMonitorError(e);
			}
		},

		async download(id: ExplorerEntryId, dlOpts) {
			if (isFolderId(id)) {
				throw new ExplorerMonitorError('MONITOR_ERROR', 'Cannot download a folder');
			}
			try {
				const abs = toAbsolutePath(rootPath, id);
				const blob = await transport.download(abs, {
					onProgress: dlOpts?.onProgress,
					onChunk: dlOpts?.onChunk,
					assemble: dlOpts?.assemble,
					signal: dlOpts?.signal
				});
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

		async downloadUrl(id: ExplorerEntryId) {
			const abs = toAbsolutePath(rootPath, id);
			if (isFolderId(id)) {
				if (!transport.zipUrl) return null;
				const filename = `${baseName(id)}.zip`;
				return { url: transport.zipUrl(abs, filename), filename };
			}
			const url = new URL(transport.readUrl(abs));
			url.searchParams.set('download', baseName(id));
			return { url: url.toString(), filename: baseName(id) };
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

	if (canRename && transport.rename) {
		const renameFn = transport.rename.bind(transport);
		driver.rename = async (id, name) => {
			try {
				const destName = sanitizeSegment(name);
				const parent = parentIdOf(id);
				const unique = await uniqueName(parent, destName, id);
				const destRel = childId(parent, unique, isFolderId(id));
				if (destRel !== id) {
					await renameFn(toAbsolutePath(rootPath, id), toAbsolutePath(rootPath, destRel));
				}
				return {
					id: destRel,
					parentId: parent,
					name: unique,
					kind: (isFolderId(id) ? 'folder' : 'file') as 'folder' | 'file',
					fileType: isFolderId(id) ? undefined : inferFileTypeFromName(unique)
				};
			} catch (e) {
				if (e instanceof ExplorerMonitorError) throw e;
				if (e instanceof Error && (e.message === 'INVALID_NAME' || e.message === 'INVALID_PATH')) {
					throw new ExplorerMonitorError('INVALID_NAME', 'Invalid name');
				}
				throw mapMonitorError(e);
			}
		};
		driver.move = async (id, newParentId) => {
			try {
				const destName = await uniqueName(newParentId, baseName(id), id);
				const destRel = childId(newParentId, destName, isFolderId(id));
				if (destRel === id) return;
				await renameFn(toAbsolutePath(rootPath, id), toAbsolutePath(rootPath, destRel));
			} catch (e) {
				if (e instanceof ExplorerMonitorError) throw e;
				if (e instanceof Error && (e.message === 'INVALID_NAME' || e.message === 'INVALID_PATH')) {
					throw new ExplorerMonitorError('INVALID_NAME', 'Invalid name');
				}
				throw mapMonitorError(e);
			}
		};
	}

	if (canMkdir && transport.mkdir) {
		const mkdirFn = transport.mkdir.bind(transport);
		driver.mkdir = async (parentId, name) => {
			try {
				const seg = sanitizeSegment(name);
				const destRel = childId(parentId, seg, true);
				const st = await mkdirFn(toAbsolutePath(rootPath, destRel));
				return {
					id: destRel,
					parentId,
					name: seg,
					kind: 'folder' as const,
					updatedAt: st.mtime_ms
				};
			} catch (e) {
				if (e instanceof Error && (e.message === 'INVALID_NAME' || e.message === 'INVALID_PATH')) {
					throw new ExplorerMonitorError('INVALID_NAME', 'Invalid folder name');
				}
				throw mapMonitorError(e);
			}
		};
	}

	if (canArchive && transport.archive) {
		const archiveFn = transport.archive.bind(transport);
		driver.archive = async (req, opts) => {
			try {
				return await archiveFn(req, opts);
			} catch (e) {
				throw mapMonitorError(e);
			}
		};
	}

	return driver;
}
