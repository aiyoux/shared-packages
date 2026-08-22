/**
 * Drag-out file cache for OS drag-and-drop from `<FileExplorer>`.
 *
 * `dragstart` is synchronous — you can't `await` a blob read inside it.
 * So when a file row is selected, we pre-fetch its bytes into this cache.
 * By the time the user starts dragging, the `File` is ready to add to
 * `dataTransfer.items.add(file)`, which makes it available to the OS
 * (drop on desktop / file manager / other apps).
 *
 * Works for all driver types: memory (OPFS read), local (IndexedDB read),
 * and remote (B2/rclone/monitor download). Remote files are subject to
 * `EXPLORER_DOWNLOAD_MAX_BYTES` — larger files skip the cache and fall
 * back to internal-only drag (no OS drag-out).
 *
 * Entries expire after `TTL_MS` to avoid unbounded memory growth.
 *
 * @see docs/design/dnd-inmem-copy.md
 */
import { EXPLORER_DOWNLOAD_MAX_BYTES, type ExplorerDriver, type ExplorerEntry } from './explorerDriver.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

type CachedFile = {
	file: File;
	expiresAt: number;
};

const cache = new Map<string, CachedFile>();
/** In-flight fetches so concurrent callers share one download. */
const fetching = new Map<string, Promise<File | null>>();

function now(): number {
	return Date.now();
}

function evictExpired(): void {
	const t = now();
	for (const [id, entry] of cache) {
		if (entry.expiresAt <= t) cache.delete(id);
	}
}

/**
 * Pre-fetch a file's bytes so it's ready for OS drag-out at `dragstart`.
 * Resolves to `null` if the file is too large or the driver can't read it.
 * Concurrent calls for the same id share one fetch.
 */
export async function prefetchForDragOut(
	driver: ExplorerDriver,
	entry: ExplorerEntry
): Promise<File | null> {
	// Folders can't be dragged out as single files.
	if (entry.kind !== 'file') return null;
	// Size cap — skip large files to avoid buffering 100s of MiB in memory.
	if (entry.size != null && entry.size > EXPLORER_DOWNLOAD_MAX_BYTES) return null;

	// Already cached?
	const hit = cache.get(entry.id);
	if (hit && hit.expiresAt > now()) return hit.file;

	// Already fetching?
	const inflight = fetching.get(entry.id);
	if (inflight) return inflight;

	const promise = (async (): Promise<File | null> => {
		try {
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
			cache.set(entry.id, { file, expiresAt: now() + TTL_MS });
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

/**
 * Get a pre-fetched `File` for OS drag-out, or `null` if not cached.
 * Synchronous — safe to call inside `dragstart`.
 */
export function getDragOutFile(entryId: string): File | null {
	const hit = cache.get(entryId);
	if (hit && hit.expiresAt > now()) return hit.file;
	if (hit) cache.delete(entryId);
	return null;
}

/** Check whether a file is pre-fetched and ready for OS drag-out. */
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
