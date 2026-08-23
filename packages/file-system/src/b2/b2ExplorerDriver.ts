/**
 * B2 simple file browser driver for hub File Explorer.
 * Completely separate from SharedVFS / Dexie.
 */
import {
	B2Client,
	BlobSource,
	BucketType,
	FileAction,
	type Bucket,
	type DeleteTarget,
	type FileVersion,
	type HttpTransport
} from '@backblaze-labs/b2-sdk';
import { createNativeDownloadAuthorizationUrl } from '@backblaze-labs/b2-sdk/s3';
// Import driver contract only — never `@shared-packages/file-system/ui` (pulls Svelte).
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
import { blobFromResponse } from '../readProgress.js';
import { ExplorerB2Error, mapB2Error } from './errors.js';
import {
	baseNameFromKey,
	baseNameFromPrefix,
	directChildFolderFromMarker,
	isFolderMarkerKey,
	markerKeyForFolderPrefix,
	sanitizeSegment
} from './folderMarkers.js';
import { createHybridB2Transport } from './hybridTransport.js';
import { ensureExplorerCors } from './b2Cors.js';
import { normalizeNamePrefix, type B2ConnectionProfileV1 } from './types.js';

/** Download-auth token lifetime for direct browser GETs (seconds). */
const DOWNLOAD_AUTH_TTL_SEC = 3600;

const B2_CAPS: ExplorerCapabilities = {
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

export type B2ExplorerDriverOptions = {
	profile: B2ConnectionProfileV1;
	/**
	 * Inject HTTP transport (e.g. `B2Simulator.transport()`) for unit tests.
	 * Production omits this and uses {@link createHybridB2Transport}: control-plane
	 * via same-origin proxy, upload/download bytes direct to B2.
	 */
	transport?: HttpTransport;
	/**
	 * Control-plane proxy path when using the default hybrid transport.
	 * Defaults to `/api/b2/proxy`. Ignored when `transport` is provided.
	 */
	proxyPath?: string;
	/**
	 * When true and the named bucket is missing, create an allPrivate bucket
	 * (simulator / tests only). Production omits this.
	 */
	createBucketIfMissing?: boolean;
	/**
	 * When true (default for production hybrid path), download via
	 * `b2_get_download_authorization` + direct GET to the download host (query
	 * `Authorization` — required for private-bucket browser CORS).
	 * Simulator tests set `transport` and keep SDK stream download.
	 */
	directBrowserDownload?: boolean;
};

export async function createB2ExplorerDriver(
	opts: B2ExplorerDriverOptions
): Promise<ExplorerDriver> {
	const rootPrefix = normalizeNamePrefix(opts.profile.namePrefix);
	/** Injected transport (tests) vs hybrid production transport. */
	const usingCustomTransport = Boolean(opts.transport);
	const transport =
		opts.transport ?? createHybridB2Transport({ proxyPath: opts.proxyPath });
	const directBrowserDownload = opts.directBrowserDownload ?? !usingCustomTransport;

	const client = new B2Client({
		applicationKeyId: opts.profile.applicationKeyId,
		applicationKey: opts.profile.applicationKey,
		transport
	});
	await client.authorize();
	let bucket = await client.getBucket(opts.profile.bucketName);
	if (!bucket && opts.createBucketIfMissing) {
		bucket = await client.createBucket({
			bucketName: opts.profile.bucketName,
			bucketType: BucketType.AllPrivate
		});
	}
	if (!bucket) {
		throw new ExplorerB2Error('B2_NOT_FOUND', `Bucket not found: ${opts.profile.bucketName}`);
	}

	// Best-effort: add this page origin to bucket CORS so direct uploads work.
	// Limited keys without writeBuckets skip silently; the data-plane relay
	// still carries the bytes through the hub.
	if (typeof window !== 'undefined' && !usingCustomTransport) {
		// b2Cors keeps a portable rule shape (allowedOperations: string[]) so it
		// stays free of SDK types, while the SDK narrows that same field to a
		// CorsOperation literal union. The two are mutually unassignable — the
		// read side needs ours wider, the update side needs it narrower — so the
		// mismatch is absorbed here, at the single boundary, rather than by
		// leaking SDK types back into b2Cors.
		await ensureExplorerCors(
			bucket as unknown as Parameters<typeof ensureExplorerCors>[0],
			window.location.origin
		);
	}

	function absPrefix(parentId: ExplorerEntryId | null): string {
		return parentId ?? rootPrefix;
	}

	function parentPrefixOf(abs: string): string {
		const trimmed = abs.endsWith('/') ? abs.slice(0, -1) : abs;
		const slash = trimmed.lastIndexOf('/');
		return slash >= 0 ? trimmed.slice(0, slash + 1) : rootPrefix;
	}

	async function uniqueName(
		parentPrefix: string,
		baseName: string,
		excludeKey?: string
	): Promise<string> {
		let candidate = baseName;
		let i = 0;
		for (;;) {
			const key = `${parentPrefix}${candidate}`;
			if (key !== excludeKey) {
				const existing = await bucket!.getFileInfoByName(key);
				if (existing) {
					i += 1;
					candidate = withSuffix(baseName, i);
					continue;
				}
			}
			return candidate;
		}
	}

	async function prefixHasFiles(prefix: string): Promise<boolean> {
		for await (const _ of bucket!.paginateFileNames({ prefix })) {
			return true;
		}
		return false;
	}

	async function uniqueFolderName(
		parentPrefix: string,
		baseName: string,
		excludePrefix?: string
	): Promise<string> {
		let candidate = baseName;
		let i = 0;
		for (;;) {
			const prefix = `${parentPrefix}${candidate}/`;
			if (prefix !== excludePrefix && (await prefixHasFiles(prefix))) {
				i += 1;
				candidate = withSuffix(baseName, i);
				continue;
			}
			return candidate;
		}
	}

	async function listKeysUnderPrefix(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		for await (const f of bucket!.paginateFileNames({ prefix })) {
			keys.push(f.fileName);
		}
		return keys;
	}

	function toFolderEntry(folderPrefix: string): ExplorerEntry {
		const parent = parentPrefixOf(folderPrefix);
		return {
			id: folderPrefix,
			parentId: parent === rootPrefix ? null : parent,
			name: baseNameFromPrefix(folderPrefix),
			kind: 'folder'
		};
	}

	async function copyKeysToPrefix(
		srcPrefix: string,
		destPrefix: string,
		keys: string[]
	): Promise<void> {
		const copied: string[] = [];
		try {
			for (const srcKey of keys) {
				const destKey = destPrefix + srcKey.slice(srcPrefix.length);
				const src = await requireFileVersion(srcKey);
				await bucket!.copyFile({ sourceFileId: src.fileId, fileName: destKey });
				copied.push(destKey);
			}
		} catch (e) {
			for (const destKey of copied) {
				try {
					await deleteFileAllVersions(destKey);
				} catch {
					/* rollback is best-effort */
				}
			}
			throw e;
		}
	}

	async function renameFolder(id: string, name: string): Promise<ExplorerEntry> {
		const srcPrefix = id.endsWith('/') ? id : `${id}/`;
		const parent = parentPrefixOf(srcPrefix);
		const destName = await uniqueFolderName(parent, name, srcPrefix);
		const destPrefix = `${parent}${destName}/`;
		if (destPrefix === srcPrefix) return toFolderEntry(srcPrefix);

		const keys = await listKeysUnderPrefix(srcPrefix);
		if (keys.length === 0) {
			await bucket!.upload({
				fileName: markerKeyForFolderPrefix(destPrefix),
				source: new BlobSource(new Blob([])),
				contentType: 'application/x-bz-empty-folder'
			});
			return toFolderEntry(destPrefix);
		}

		await copyKeysToPrefix(srcPrefix, destPrefix, keys);
		try {
			for (const srcKey of keys) {
				await deleteFileAllVersions(srcKey);
			}
		} catch {
			throw new ExplorerB2Error(
				'B2_RENAME_PARTIAL',
				`Copied to ${destPrefix} but failed to remove ${srcPrefix}`
			);
		}
		return toFolderEntry(destPrefix);
	}

	async function deleteFileAllVersions(fileName: string): Promise<void> {
		const targets: DeleteTarget[] = [];
		for await (const v of bucket!.paginateFileVersions({ prefix: fileName })) {
			if (v.fileName !== fileName) continue;
			targets.push({ fileName: v.fileName, fileId: v.fileId });
		}
		if (!targets.length) return;
		const result = await bucket!.deleteMany(targets, { concurrency: 8 });
		if (result.errors.length) {
			throw new ExplorerB2Error(
				'B2_ERROR',
				`Failed to delete ${result.errors.length} version(s) of ${fileName}`
			);
		}
	}

	async function deleteFolderEmpty(folderPrefix: string): Promise<void> {
		const prefix = folderPrefix.endsWith('/') ? folderPrefix : `${folderPrefix}/`;
		const keys = new Set<string>();
		let count = 0;
		for await (const v of bucket!.paginateFileVersions({ prefix })) {
			keys.add(v.fileName);
			count += 1;
			if (count > 500) {
				throw new ExplorerB2Error('B2_FOLDER_NOT_EMPTY', prefix);
			}
		}
		const marker = markerKeyForFolderPrefix(prefix);
		for (const k of keys) {
			if (k !== marker) {
				throw new ExplorerB2Error('B2_FOLDER_NOT_EMPTY', prefix);
			}
		}
		if (keys.has(marker)) {
			await deleteFileAllVersions(marker);
		}
	}

	async function requireFileVersion(id: ExplorerEntryId): Promise<FileVersion> {
		const info = await bucket!.getFileInfoByName(id);
		if (!info) throw new ExplorerB2Error('B2_NOT_FOUND', id);
		return info;
	}

	const driver: ExplorerDriver = {
		id: 'b2',
		connectionId: `b2:${opts.profile.id}`,
		endpointKey: `b2:${opts.profile.applicationKeyId}::${opts.profile.bucketName}`,
		capabilities: B2_CAPS,

		async ready() {
			/* authorized at create */
		},

		async getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]> {
			let abs = id;
			if (!abs.startsWith(rootPrefix) && rootPrefix !== '') {
				return [];
			}
			let rel = abs.slice(rootPrefix.length);
			if (rel && !rel.endsWith('/')) {
				const slash = rel.lastIndexOf('/');
				rel = slash >= 0 ? rel.slice(0, slash + 1) : '';
			}
			if (!rel) return [];

			const segments = rel.replace(/\/$/, '').split('/').filter(Boolean);
			const chain: ExplorerEntry[] = [];
			let acc = rootPrefix;
			for (let i = 0; i < segments.length; i++) {
				acc = acc + segments[i] + '/';
				const parentId =
					i === 0 ? null : rootPrefix + segments.slice(0, i).join('/') + '/';
				chain.push({
					id: acc,
					parentId,
					name: segments[i]!,
					kind: 'folder'
				});
			}
			return chain;
		},

		async list(opts: ExplorerListOptions): Promise<ExplorerListResult> {
			try {
				const prefix = absPrefix(opts.parentId);
				const entries: ExplorerEntry[] = [];
				let startFileName: string | undefined;
				let truncated = false;

				do {
					const listing = await bucket!.listFileNames({
						prefix,
						delimiter: '/',
						pageSize: 1000,
						startFileName
					});

					const seenFolders = new Set(
						entries.filter((e) => e.kind === 'folder').map((e) => e.id)
					);

					for (const f of listing.files) {
						if (f.action === FileAction.Folder) {
							const folderPrefix = f.fileName;
							if (isFolderMarkerKey(folderPrefix)) continue;
							if (rootPrefix && !folderPrefix.startsWith(rootPrefix)) continue;
							if (!seenFolders.has(folderPrefix)) {
								seenFolders.add(folderPrefix);
								entries.push({
									id: folderPrefix,
									parentId: opts.parentId,
									name: baseNameFromPrefix(folderPrefix),
									kind: 'folder'
								});
							}
							continue;
						}
						if (f.action === FileAction.Hide || f.action === FileAction.Start) continue;

						// Simulator may list `.bzEmpty` markers as files without
						// emitting delimiter folder rows — synthesize folders.
						if (isFolderMarkerKey(f.fileName)) {
							const folderPrefix = directChildFolderFromMarker(prefix, f.fileName);
							if (folderPrefix && !seenFolders.has(folderPrefix)) {
								seenFolders.add(folderPrefix);
								entries.push({
									id: folderPrefix,
									parentId: opts.parentId,
									name: baseNameFromPrefix(folderPrefix),
									kind: 'folder'
								});
							}
							continue;
						}

						if (rootPrefix && !f.fileName.startsWith(rootPrefix)) continue;

						entries.push({
							id: f.fileName,
							parentId: opts.parentId,
							name: baseNameFromKey(f.fileName),
							kind: 'file',
							size: f.contentLength,
							updatedAt: f.uploadTimestamp,
							contentType: f.contentType,
							fileType: inferFileTypeFromName(f.fileName),
							meta: { fileId: f.fileId }
						});
					}

					startFileName = listing.nextFileName ?? undefined;
					if (entries.length >= EXPLORER_LIST_MAX_ENTRIES && startFileName) {
						truncated = true;
						break;
					}
				} while (startFileName);

				if (entries.length > EXPLORER_LIST_MAX_ENTRIES) {
					truncated = true;
					entries.length = EXPLORER_LIST_MAX_ENTRIES;
				}
				if (startFileName) truncated = true;

				return {
					entries: sortFoldersFirst(entries),
					truncated
				};
			} catch (e) {
				throw mapB2Error(e);
			}
		},

		async mkdir(parentId, name) {
			try {
				const seg = sanitizeSegment(name);
				const parent = absPrefix(parentId);
				const folderPrefix = `${parent}${seg}/`;
				const marker = markerKeyForFolderPrefix(folderPrefix);
				await bucket!.upload({
					fileName: marker,
					source: new BlobSource(new Blob([])),
					contentType: 'application/x-bz-empty-folder'
				});
				return {
					id: folderPrefix,
					parentId,
					name: seg,
					kind: 'folder' as const
				};
			} catch (e) {
				if (e instanceof Error && e.message === 'INVALID_NAME') {
					throw new ExplorerB2Error('INVALID_NAME', 'Invalid folder name');
				}
				throw mapB2Error(e);
			}
		},

		async delete(id) {
			try {
				if (id.endsWith('/')) {
					await deleteFolderEmpty(id);
				} else {
					await deleteFileAllVersions(id);
				}
			} catch (e) {
				throw mapB2Error(e);
			}
		},

		async rename(id, name) {
			try {
				const seg = sanitizeSegment(name);
				if (id.endsWith('/')) {
					return await renameFolder(id, seg);
				}
				const src = await requireFileVersion(id);
				const parent = parentPrefixOf(id);
				const destName = await uniqueName(parent, seg, id);
				const destKey = `${parent}${destName}`;
				if (destKey === id) {
					return {
						id,
						parentId: parent === rootPrefix ? null : parent,
						name: destName,
						kind: 'file' as const,
						fileType: inferFileTypeFromName(id)
					};
				}
				await bucket!.copyFile({ sourceFileId: src.fileId, fileName: destKey });
				try {
					await deleteFileAllVersions(id);
				} catch {
					throw new ExplorerB2Error(
						'B2_RENAME_PARTIAL',
						`Copied to ${destKey} but failed to remove ${id}`
					);
				}
				return {
					id: destKey,
					parentId: parent === rootPrefix ? null : parent,
					name: destName,
					kind: 'file' as const,
					fileType: inferFileTypeFromName(destKey)
				};
			} catch (e) {
				if (e instanceof Error && e.message === 'INVALID_NAME') {
					throw new ExplorerB2Error('INVALID_NAME', 'Invalid name');
				}
				if (e instanceof ExplorerB2Error) throw e;
				throw mapB2Error(e);
			}
		},

		async move(id, newParentId) {
			if (id.endsWith('/')) {
				throw new ExplorerB2Error('B2_FOLDER_OP_UNSUPPORTED', 'Folder move not supported');
			}
			try {
				const src = await requireFileVersion(id);
				const base = baseNameFromKey(id);
				const parent = absPrefix(newParentId);
				const destName = await uniqueName(parent, base);
				const destKey = `${parent}${destName}`;
				await bucket!.copyFile({ sourceFileId: src.fileId, fileName: destKey });
				try {
					await deleteFileAllVersions(id);
				} catch {
					throw new ExplorerB2Error(
						'B2_RENAME_PARTIAL',
						`Moved copy at ${destKey} but failed to remove ${id}`
					);
				}
			} catch (e) {
				if (e instanceof ExplorerB2Error) throw e;
				throw mapB2Error(e);
			}
		},

		async copy(id, newParentId) {
			if (id.endsWith('/')) {
				throw new ExplorerB2Error('B2_FOLDER_OP_UNSUPPORTED', 'Folder copy not supported');
			}
			try {
				const src = await requireFileVersion(id);
				const base = baseNameFromKey(id);
				const parent = absPrefix(newParentId);
				const destName = await uniqueName(parent, base);
				const destKey = `${parent}${destName}`;
				await bucket!.copyFile({ sourceFileId: src.fileId, fileName: destKey });
			} catch (e) {
				if (e instanceof ExplorerB2Error) throw e;
				throw mapB2Error(e);
			}
		},

		async upload(parentId, file, opts) {
			try {
				const parent = absPrefix(parentId);
				const destName = await uniqueName(parent, file.name);
				const fileName = `${parent}${destName}`;
				const uploaded = await bucket!.upload({
					fileName,
					source: new BlobSource(file),
					contentType: file.type || 'b2/x-auto',
					onProgress: opts?.onProgress
						? (ev) => {
								const total = ev.totalBytes ?? file.size ?? 1;
								opts.onProgress?.(ev.bytesTransferred / Math.max(total, 1));
							}
						: undefined,
					signal: opts?.signal
				});
				return {
					id: uploaded.fileName,
					parentId,
					name: destName,
					kind: 'file' as const,
					size: uploaded.contentLength,
					updatedAt: uploaded.uploadTimestamp,
					contentType: uploaded.contentType,
					fileType: inferFileTypeFromName(uploaded.fileName),
					meta: { fileId: uploaded.fileId }
				};
			} catch (e) {
				throw mapB2Error(e);
			}
		},

		async download(id, dlOpts) {
			try {
				// Size check via control plane (proxied) — avoid download-host HEAD
				// with account auth token (private-bucket CORS denies that).
				const info = await bucket!.getFileInfoByName(id);
				if (!info) {
					throw new ExplorerB2Error('B2_NOT_FOUND', id);
				}
				const len = info.contentLength ?? 0;
				if (len > EXPLORER_DOWNLOAD_MAX_BYTES) {
					throw new ExplorerB2Error(
						'B2_TOO_LARGE',
						`File exceeds ${EXPLORER_DOWNLOAD_MAX_BYTES} byte download limit`
					);
				}

				if (directBrowserDownload) {
					// Restricted download token (control plane) + direct GET to f*.backblazeb2.com
					// with ?Authorization=… (no Authorization header → CORS-friendly).
					const auth = await bucket!.getDownloadAuthorization(id, DOWNLOAD_AUTH_TTL_SEC);
					const downloadBase = client.accountInfo.getDownloadUrl();
					const url = createNativeDownloadAuthorizationUrl(
						downloadBase,
						opts.profile.bucketName,
						id,
						auth.authorizationToken,
						DOWNLOAD_AUTH_TTL_SEC
					);
					const res = await fetch(url, { method: 'GET', redirect: 'follow' });
					if (!res.ok) {
						throw new ExplorerB2Error(
							'B2_ERROR',
							`Download failed (${res.status})`
						);
					}
					try {
						return await blobFromResponse(res, {
							onProgress: dlOpts?.onProgress,
							onChunk: dlOpts?.onChunk,
							assemble: dlOpts?.assemble,
							maxBytes: EXPLORER_DOWNLOAD_MAX_BYTES,
							contentType:
								res.headers.get('content-type') ||
								info.contentType ||
								'application/octet-stream'
						});
					} catch (e) {
						if (e instanceof Error && e.message === 'EXPLORER_TOO_LARGE') {
							throw new ExplorerB2Error('B2_TOO_LARGE', 'Download exceeded size cap');
						}
						throw e;
					}
				}

				// Simulator / injected transport: SDK stream download
				const result = await bucket!.download(id);
				const reader = result.body.getReader();
				const assemble = dlOpts?.assemble !== false;
				const chunks: Uint8Array[] = [];
				let total = 0;
				let lastEmit = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) {
						total += value.byteLength;
						if (total > EXPLORER_DOWNLOAD_MAX_BYTES) {
							await reader.cancel();
							throw new ExplorerB2Error('B2_TOO_LARGE', 'Download exceeded size cap');
						}
						if (assemble) chunks.push(value);
						await dlOpts?.onChunk?.(value);
						const now = Date.now();
						if (!lastEmit || now - lastEmit >= 80) {
							lastEmit = now;
							dlOpts?.onProgress?.(total, len || undefined);
						}
					}
				}
				dlOpts?.onProgress?.(total, len || total);
				const type = result.headers.contentType || 'application/octet-stream';
				return assemble ? new Blob(chunks as BlobPart[], { type }) : new Blob([], { type });
			} catch (e) {
				if (e instanceof ExplorerB2Error) throw e;
				throw mapB2Error(e);
			}
		}
	};

	return driver;
}

// silence unused import if Bucket type only used in comments
void (0 as unknown as Bucket);
