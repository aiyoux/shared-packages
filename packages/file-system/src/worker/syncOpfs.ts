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
 * `flush()` is ~72% of the cost. Same-session reads see the bytes after
 * `close()`, but WHATWG FileSystemSyncAccessHandle.close() only releases the
 * exclusive lock and does not guarantee the device has the data — that is
 * `flush()`. Pack publish (`writeAtomic`) always flushes. Standalone extract
 * writes (`writeFinal({ flush: false })`) match the POSIX SAH bench and the
 * main-thread `createWritable` path: close without an explicit flush.
 * `truncate()` is only needed when overwriting a longer file.
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

/**
 * A sync access handle writes from a buffer view, so a Blob has to be read
 * first.
 *
 * Packing hands this store one multi-part Blob per pack — that is the whole
 * zero-copy trick on the main thread, where the browser concatenates the parts
 * during the write and JS never holds them. There is no sync equivalent, so
 * refusing Blobs here made packing and the worker mutually exclusive: ticking
 * "pack" simply failed the worker job. Reading it costs one copy of the pack,
 * bounded by the pack budget (a quarter of free space, at most 64MB), which is
 * the price of having both.
 */
async function toBytes(data: BufferSource | Blob | Uint8Array): Promise<Uint8Array> {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (typeof Blob !== 'undefined' && data instanceof Blob) {
		return new Uint8Array(await data.arrayBuffer());
	}
	throw new VfsError('API_MISUSE', `Unsupported body for the sync store: ${typeof data}`);
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
		// Tab-kill / Worker.terminate() can leave the exclusive SAH lock held
		// for seconds (sometimes until the browser restarts). 40ms was only
		// enough for a same-process straggler close.
		const waits = [200, 500, 1000, 2000, 5000];
		for (let attempt = 0; attempt < waits.length; attempt++) {
			let handle: SyncAccessHandle | null = null;
			try {
				handle = await open(opfsPath, create);
				return fn(handle);
			} catch (e) {
				lastErr = e;
				const name = (e as Error)?.name ?? '';
				if (name !== 'NoModificationAllowedError' && name !== 'InvalidStateError') throw e;
				if (attempt === waits.length - 1) break;
				await new Promise((r) => setTimeout(r, waits[attempt]));
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
		data: BufferSource | Blob | Uint8Array,
		opts?: { flush?: boolean }
	): Promise<{ byteLength: number }> {
		const bytes = await toBytes(data);
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
			if (opts?.flush !== false) h.flush();
			return { byteLength: bytes.byteLength };
		});
	}

	async function moveFile(fromPath: string, toPath: string): Promise<void> {
		const { dir, base } = splitPath(toPath);
		const tmpHandle = (await fileHandle(fromPath, false)) as FileSystemFileHandle & {
			move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
		};
		if (typeof tmpHandle.move === 'function') {
			await tmpHandle.move(await resolveDir(dir), base);
			return;
		}
		const bytes = await store.read(fromPath);
		await writeBytes(toPath, bytes);
		await store.remove(fromPath);
	}

	const store: OpfsBlobStore = {
		writeFinal: (opfsPath, data, opts) => writeBytes(opfsPath, data, opts),
		async writeAtomic(opfsPath, data) {
			const writeId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const tmpPath = `tmp/${writeId}.partial`;
			const { byteLength } = await writeBytes(tmpPath, data);
			try {
				if (await store.exists(opfsPath)) {
					await store.remove(opfsPath);
				}
				await moveFile(tmpPath, opfsPath);
			} catch {
				await writeBytes(opfsPath, data);
				try {
					await store.remove(tmpPath);
				} catch {
					/* gc sweeps tmp/ */
				}
			}
			return { byteLength };
		},
		async writePartial(writeId, data) {
			const tmpPath = `tmp/${writeId}.partial`;
			const { byteLength } = await writeBytes(tmpPath, data);
			return { tmpPath, byteLength };
		},
		async promote(tmpPath, finalOpfsPath) {
			try {
				if (await store.exists(finalOpfsPath)) {
					await store.remove(finalOpfsPath);
				}
				await moveFile(tmpPath, finalOpfsPath);
			} catch {
				const bytes = await store.read(tmpPath);
				await writeBytes(finalOpfsPath, bytes);
				await store.remove(tmpPath);
			}
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
				const size = h.getSize();
				if (offset < 0 || length < 0 || offset + length > size) {
					throw new VfsError(
						'OPFS_IO',
						`Short pack read from ${opfsPath}: ${offset}+${length} past ${size}`
					);
				}
				const buf = new Uint8Array(length);
				const got = h.read(buf, { at: offset });
				// Same rule as write() and full-file read(): a short transfer
				// zero-fills the tail, and for a pack that tail is a neighbour.
				if (got !== length) {
					throw new VfsError(
						'OPFS_IO',
						`Short pack read from ${opfsPath}: got ${got} of ${length} bytes at ${offset}`
					);
				}
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
