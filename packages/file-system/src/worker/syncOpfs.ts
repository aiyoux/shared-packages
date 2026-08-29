/**
 * OpfsBlobStore backed by `createSyncAccessHandle` — dedicated workers only.
 *
 * Why this exists: OPFS charges per operation, and a sync access handle is
 * the cheapest write the platform offers once you are off the main thread.
 * Measured per 4KB file inside a worker:
 *
 *   write + truncate + flush + close   9.61 ms
 *   drop flush()                       2.69 ms
 *   drop flush() and truncate()        2.05 ms
 *
 * `flush()` was ~72% of the cost and is NOT needed: `close()` persists (a file
 * written without flush reads back at full size). `truncate()` is only needed
 * when overwriting a longer file, so it is applied conditionally rather than
 * unconditionally.
 *
 * Availability is narrow and worth stating: `createSyncAccessHandle` exists in
 * DEDICATED workers only — it is undefined on the main thread and in a
 * SharedWorker, and a SharedWorker cannot spawn a nested Worker to reach it.
 * That is why the VFS worker is dedicated.
 */
import type { OpfsBlobStore } from '../opfs.js';
import { VfsError } from '../types.js';

/** Not in lib.dom for this tsconfig; the shape we actually use. */
type SyncAccessHandle = {
	read(buffer: ArrayBufferView, options?: { at?: number }): number;
	write(buffer: ArrayBufferView, options?: { at?: number }): number;
	getSize(): number;
	truncate(size: number): void;
	flush(): void;
	close(): void;
};
type SyncCapableFileHandle = FileSystemFileHandle & {
	createSyncAccessHandle?: () => SyncAccessHandle | Promise<SyncAccessHandle>;
};
type IterableDirHandle = FileSystemDirectoryHandle & {
	entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** True when this context can actually serve the sync-handle store. */
export function canUseSyncAccessHandles(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		!!navigator.storage?.getDirectory &&
		typeof FileSystemFileHandle !== 'undefined' &&
		typeof (FileSystemFileHandle.prototype as SyncCapableFileHandle).createSyncAccessHandle ===
			'function'
	);
}

function splitPath(opfsPath: string): { dir: string; base: string } {
	const normalized = opfsPath.replace(/^\/+/, '');
	const i = normalized.lastIndexOf('/');
	if (i < 0) return { dir: '', base: normalized };
	return { dir: normalized.slice(0, i), base: normalized.slice(i + 1) };
}

function toBytes(data: BufferSource | Blob | Uint8Array): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new VfsError('API_MISUSE', 'Blob bodies must be read to bytes before the sync store');
}

export function createSyncOpfsStore(rootDirName = 'shared-vfs'): OpfsBlobStore {
	let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;
	// Directory handles are stable for the life of the store and each resolve
	// is its own round trip, so they are cached exactly as the async store does.
	const dirCache = new Map<string, Promise<FileSystemDirectoryHandle>>();

	const root = (): Promise<FileSystemDirectoryHandle> => {
		if (!rootPromise) {
			rootPromise = navigator.storage
				.getDirectory()
				.then((r) => r.getDirectoryHandle(rootDirName, { create: true }));
		}
		return rootPromise;
	};

	function resolveDir(dirPath: string): Promise<FileSystemDirectoryHandle> {
		const cached = dirCache.get(dirPath);
		if (cached) return cached;
		const pending = (async () => {
			let cur = await root();
			for (const part of dirPath.split('/').filter(Boolean)) {
				cur = await cur.getDirectoryHandle(part, { create: true });
			}
			return cur;
		})();
		void pending.catch(() => dirCache.delete(dirPath));
		dirCache.set(dirPath, pending);
		return pending;
	}

	async function fileHandle(opfsPath: string, create: boolean): Promise<FileSystemFileHandle> {
		const { dir, base } = splitPath(opfsPath);
		const d = await resolveDir(dir);
		return d.getFileHandle(base, { create });
	}

	async function open(opfsPath: string, create: boolean): Promise<SyncAccessHandle> {
		const handle = (await fileHandle(opfsPath, create)) as SyncCapableFileHandle;
		const make = handle.createSyncAccessHandle;
		if (!make) {
			throw new VfsError('OPFS_UNAVAILABLE', 'createSyncAccessHandle is not available here');
		}
		// Spec says sync; Chrome resolves a promise. Awaiting handles both.
		return await make.call(handle);
	}

	/**
	 * A sync handle holds an EXCLUSIVE lock on its file, so it is opened and
	 * closed around each operation rather than held. A second opener throws
	 * NoModificationAllowedError; a short retry absorbs a straggler (another
	 * tab's worker closing, a handle being released) instead of failing a job.
	 */
	async function withHandle<T>(
		opfsPath: string,
		create: boolean,
		fn: (h: SyncAccessHandle) => T
	): Promise<T> {
		let lastErr: unknown;
		for (let attempt = 0; attempt < 4; attempt++) {
			let handle: SyncAccessHandle | null = null;
			try {
				handle = await open(opfsPath, create);
				return fn(handle);
			} catch (e) {
				lastErr = e;
				const name = (e as Error)?.name ?? '';
				if (name !== 'NoModificationAllowedError' && name !== 'InvalidStateError') throw e;
				await new Promise((r) => setTimeout(r, 4 * (attempt + 1)));
			} finally {
				try {
					handle?.close();
				} catch {
					/* already closed or gone */
				}
			}
		}
		throw lastErr;
	}

	async function writeBytes(
		opfsPath: string,
		data: BufferSource | Blob | Uint8Array
	): Promise<{ byteLength: number }> {
		const bytes = toBytes(data);
		return withHandle(opfsPath, true, (h) => {
			// write() returns the count it ACTUALLY wrote, and a short write is
			// a legal outcome (the spec defines the return value precisely so
			// callers can detect one). Ignoring it is silent corruption here:
			// we would report the full length, the blobRef would record it, and
			// for a pack every member past the cut would read another member's
			// bytes or run off the end. Fail loudly instead — a failed write is
			// recoverable, a wrong length is not.
			const written = h.write(bytes, { at: 0 });
			if (written !== bytes.byteLength) {
				throw new VfsError(
					'OPFS_IO',
					`Short write to ${opfsPath}: wrote ${written} of ${bytes.byteLength} bytes`
				);
			}
			// Only shrink when there is something to shrink: an unconditional
			// truncate cost measurable time on fresh files.
			if (h.getSize() > bytes.byteLength) h.truncate(bytes.byteLength);
			// No flush(): close() persists, and flush measured ~6.9ms/file.
			return { byteLength: bytes.byteLength };
		});
	}

	const store: OpfsBlobStore = {
		writeFinal: (opfsPath, data) => writeBytes(opfsPath, data),
		writeAtomic: (opfsPath, data) => writeBytes(opfsPath, data),
		async writePartial(writeId, data) {
			const tmpPath = `tmp/${writeId}.partial`;
			const { byteLength } = await writeBytes(tmpPath, data);
			return { tmpPath, byteLength };
		},
		async promote(tmpPath, finalOpfsPath) {
			const bytes = await store.read(tmpPath);
			await writeBytes(finalOpfsPath, bytes);
			await store.remove(tmpPath);
		},
		read(opfsPath) {
			return withHandle(opfsPath, false, (h) => {
				const size = h.getSize();
				const buf = new Uint8Array(size);
				// Same reasoning as write: a short read would hand back a
				// zero-filled tail that looks like real data.
				const got = h.read(buf, { at: 0 });
				if (got !== size) {
					throw new VfsError(
						'OPFS_IO',
						`Short read from ${opfsPath}: got ${got} of ${size} bytes`
					);
				}
				return buf;
			});
		},
		async readBlob(opfsPath, contentType = 'application/octet-stream') {
			const bytes = await store.read(opfsPath);
			return new Blob([bytes as BlobPart], { type: contentType });
		},
		async readRange(opfsPath, offset, length, contentType) {
			const bytes = await withHandle(opfsPath, false, (h) => {
				const buf = new Uint8Array(length);
				h.read(buf, { at: offset });
				return buf;
			});
			return new Blob([bytes as BlobPart], {
				type: contentType ?? 'application/octet-stream'
			});
		},
		async remove(opfsPath) {
			const { dir, base } = splitPath(opfsPath);
			const d = await resolveDir(dir);
			try {
				await d.removeEntry(base);
			} catch {
				/* already gone */
			}
		},
		async exists(opfsPath) {
			try {
				await fileHandle(opfsPath, false);
				return true;
			} catch {
				return false;
			}
		},
		async listOrphans(prefix) {
			const base = prefix.replace(/\/+$/, '');
			const out: string[] = [];
			try {
				const d = (await resolveDir(base)) as IterableDirHandle;
				if (!d.entries) return out;
				for await (const [name, handle] of d.entries()) {
					if (handle.kind === 'file') out.push(`${base}/${name}`);
				}
			} catch {
				/* directory does not exist yet */
			}
			return out;
		},
		async listTmp() {
			const out: Array<{ path: string; mtimeMs?: number }> = [];
			try {
				const d = (await resolveDir('tmp')) as IterableDirHandle;
				if (!d.entries) return out;
				for await (const [name, handle] of d.entries()) {
					if (handle.kind !== 'file') continue;
					const path = `tmp/${name}`;
					try {
						const fh = await (handle as FileSystemFileHandle).getFile();
						out.push({ path, mtimeMs: fh.lastModified });
					} catch {
						out.push({ path });
					}
				}
			} catch {
				/* no tmp yet */
			}
			return out;
		},
		async clearAll() {
			const r = await root();
			const iterable = r as IterableDirHandle;
			if (!iterable.entries) return;
			dirCache.clear();
			for await (const [name, handle] of iterable.entries()) {
				if (handle.kind !== 'directory') continue;
				try {
					await r.removeEntry(name, { recursive: true });
				} catch {
					/* best effort */
				}
			}
		}
	};

	return store;
}
