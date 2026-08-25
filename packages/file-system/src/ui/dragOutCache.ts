/**
 * Drag-out cache for OS drag-and-drop from `<FileExplorer>`.
 *
 * Prefer a header-free HTTP URL (Chromium `DownloadURL`). Chrome GETs it
 * only on drop — this tab never buffers the file. Fall back to an in-memory
 * `File` only when there is no such URL (local VFS).
 *
 * @see docs/design/dnd-inmem-copy.md
 */
import { packFiles } from '@shared-packages/compress';
import { EXPLORER_DOWNLOAD_MAX_BYTES, type ExplorerDriver, type ExplorerEntry } from './explorerDriver.js';
import { collectPackEntries, toArchiveEntries } from './archiveOps.js';
import { httpDownloadIsSafe } from './saveToDisk.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export type DragOutUrl = {
	url: string;
	filename: string;
	mime: string;
};

type Cached =
	| { kind: 'url'; payload: DragOutUrl; expiresAt: number }
	| { kind: 'file'; file: File; expiresAt: number };

const cache = new Map<string, Cached>();
/** In-flight fetches so concurrent callers share one download. */
const fetching = new Map<string, Promise<File | DragOutUrl | null>>();

function now(): number {
	return Date.now();
}

function evictExpired(): void {
	const t = now();
	for (const [id, entry] of cache) {
		if (entry.expiresAt <= t) cache.delete(id);
	}
}

/** Chromium DownloadURL payload: `mimeType:filename:url`. */
export function formatDownloadURL(payload: DragOutUrl): string {
	const filename = payload.filename.replace(/[:\r\n]/g, '_');
	const mime = payload.mime.replace(/[:\r\n]/g, '_') || 'application/octet-stream';
	return `${mime}:${filename}:${payload.url}`;
}

/** Folder name without a trailing slash, used as the zip basename. */
export function folderZipName(entry: ExplorerEntry): string {
	const base = entry.name.replace(/\/+$/, '') || 'folder';
	return `${base}.zip`;
}

/**
 * Folders can leave this tab as a zip. Monitor: URL that zips on GET (drop).
 * Local VFS: zip in this tab. B2/rclone folders have no zip URL — skip.
 */
export function canZipFolderForDragOut(driver: ExplorerDriver): boolean {
	if (driver.id === 'disk' || driver.id === 'b2' || driver.id === 'rclone') return false;
	if (driver.id === 'monitor') return typeof driver.downloadUrl === 'function';
	return Boolean(driver.readBlob || driver.download);
}

/**
 * Resolve a header-free download URL (preferred) or an in-memory File.
 * Concurrent calls for the same id share one fetch.
 */
export async function prefetchForDragOut(
	driver: ExplorerDriver,
	entry: ExplorerEntry
): Promise<File | DragOutUrl | null> {
	if (entry.kind === 'folder') {
		if (!canZipFolderForDragOut(driver) && typeof driver.downloadUrl !== 'function') return null;
	} else if (entry.kind !== 'file') {
		return null;
	}

	const hit = cache.get(entry.id);
	if (hit && hit.expiresAt > now()) {
		return hit.kind === 'url' ? hit.payload : hit.file;
	}

	const inflight = fetching.get(entry.id);
	if (inflight) return inflight;

	const promise = (async (): Promise<File | DragOutUrl | null> => {
		try {
			if (driver.downloadUrl && (entry.kind === 'file' || entry.kind === 'folder')) {
				try {
					const loc = await driver.downloadUrl(entry.id);
					if (loc?.url && httpDownloadIsSafe(loc.url)) {
						const payload: DragOutUrl = {
							url: loc.url,
							filename:
								entry.kind === 'folder' ? folderZipName(entry) : loc.filename || entry.name,
							mime:
								entry.kind === 'folder'
									? 'application/zip'
									: entry.contentType || 'application/octet-stream'
						};
						cache.set(entry.id, { kind: 'url', payload, expiresAt: now() + TTL_MS });
						return payload;
					}
				} catch {
					/* old daemon / unsigned B2 — fall through */
				}
			}
			if (entry.kind === 'folder') {
				if (driver.id === 'b2' || driver.id === 'rclone' || driver.id === 'disk') return null;
				const file = await zipFolderForDragOut(driver, entry);
				if (!file) return null;
				cache.set(entry.id, { kind: 'file', file, expiresAt: now() + TTL_MS });
				return file;
			}
			if (entry.size != null && entry.size > EXPLORER_DOWNLOAD_MAX_BYTES) return null;
			let blob: Blob;
			if (driver.download) {
				blob = await driver.download(entry.id);
			} else if (driver.readBlob) {
				blob = await driver.readBlob(entry.id);
			} else {
				return null;
			}
			if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) return null;
			const file = new File([blob], entry.name, {
				type: entry.contentType || blob.type || 'application/octet-stream'
			});
			cache.set(entry.id, { kind: 'file', file, expiresAt: now() + TTL_MS });
			return file;
		} catch {
			return null;
		} finally {
			fetching.delete(entry.id);
		}
	})();

	fetching.set(entry.id, promise);
	return promise;
}

async function zipFolderForDragOut(
	driver: ExplorerDriver,
	entry: ExplorerEntry
): Promise<File | null> {
	const zipName = folderZipName(entry);
	const packed = await collectPackEntries(driver, [entry]);
	const total = packed.reduce((n, p) => n + p.data.byteLength, 0);
	if (total > EXPLORER_DOWNLOAD_MAX_BYTES) return null;
	const [out] = await packFiles('fflate', toArchiveEntries(packed), 'zip');
	if (!out || out.data.byteLength > EXPLORER_DOWNLOAD_MAX_BYTES) return null;
	return new File([new Uint8Array(out.data)], zipName, { type: 'application/zip' });
}

/**
 * In-memory `File` for OS drag-out, or `null`. Synchronous — `dragstart`.
 */
export function getDragOutFile(entryId: string): File | null {
	const hit = cache.get(entryId);
	if (!hit) return null;
	if (hit.expiresAt <= now()) {
		cache.delete(entryId);
		return null;
	}
	return hit.kind === 'file' ? hit.file : null;
}

/**
 * Header-free HTTP URL for Chromium `DownloadURL`. Chrome GETs this on drop.
 */
export function getDragOutUrl(entryId: string): DragOutUrl | null {
	const hit = cache.get(entryId);
	if (!hit) return null;
	if (hit.expiresAt <= now()) {
		cache.delete(entryId);
		return null;
	}
	return hit.kind === 'url' ? hit.payload : null;
}

/** True when a File or URL is ready for OS drag-out. */
export function hasDragOutFile(entryId: string): boolean {
	const hit = cache.get(entryId);
	if (!hit) return false;
	if (hit.expiresAt <= now()) {
		cache.delete(entryId);
		return false;
	}
	return true;
}

/** Remove a specific entry from the cache. */
export function evictDragOutFile(entryId: string): void {
	cache.delete(entryId);
}

/** Clear all cached files and in-flight fetches. Called on component unmount. */
export function clearDragOutCache(): void {
	cache.clear();
	fetching.clear();
}

/** Remove entries whose driver matches `driverId` (e.g. on connection change). */
export function evictDriver(driverId: string): void {
	// We don't store the driver id per entry, but on connection change the
	// whole cache should be flushed — stale files from a disconnected remote
	// are useless. Caller should use clearDragOutCache() instead.
	void driverId;
	clearDragOutCache();
}
