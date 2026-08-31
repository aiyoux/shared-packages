import { VfsError } from './types.js';

export interface OpfsBlobStore {
	/** Accept Uint8Array explicitly — TS 5.7+ ArrayBufferLike generics break bare BufferSource. */
	writePartial(
		writeId: string,
		data: BufferSource | Blob | Uint8Array
	): Promise<{ tmpPath: string; byteLength: number }>;
	promote(tmpPath: string, finalOpfsPath: string): Promise<void>;
	writeAtomic(opfsPath: string, data: BufferSource | Blob): Promise<{ byteLength: number }>;
	/**
	 * Direct write of final bytes — no tmp, no promote. Bulk extract uses this:
	 * the writePartial→promote cycle writes every byte twice (partial, then
	 * promote's read-back re-write), which dominated large extract jobs.
	 */
	writeFinal(
		opfsPath: string,
		data: BufferSource | Blob | Uint8Array,
		opts?: { flush?: boolean }
	): Promise<{ byteLength: number }>;
	read(opfsPath: string): Promise<Uint8Array>;
	readBlob(opfsPath: string, contentType?: string): Promise<Blob>;
	/**
	 * Byte range of a stored file, as a lazy Blob where the backend supports it.
	 *
	 * Presence of this method is the capability gate for packed blobs: a store
	 * that cannot serve a range cheaply must not be given packs. The real OPFS
	 * store slices a File (no bytes read until consumed); the in-memory store
	 * copies, which is why packing is never enabled against it.
	 */
	readRange?(
		opfsPath: string,
		offset: number,
		length: number,
		contentType?: string
	): Promise<Blob>;
	remove(opfsPath: string): Promise<void>;
	exists(opfsPath: string): Promise<boolean>;
	listOrphans(prefix: string): Promise<string[]>;
	listTmp(): Promise<Array<{ path: string; mtimeMs?: number }>>;
	/** Test/debug: wipe entire store */
	clearAll?(): Promise<void>;
}

/**
 * `FileSystemDirectoryHandle.entries()` is present in every browser we target
 * but is only in some TS DOM libs — the hub (TS 6) has it, this package's own
 * config does not. A `@ts-expect-error` is therefore *unused* in one config
 * and *required* in the other, so neither suppression can satisfy both. One
 * narrow cast satisfies both and keeps the iteration itself typed.
 */
function dirEntries(
	h: FileSystemDirectoryHandle
): AsyncIterableIterator<[string, FileSystemHandle]> {
	return (
		h as unknown as {
			entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
		}
	).entries();
}

async function toUint8Array(data: BufferSource | Blob | Uint8Array): Promise<Uint8Array> {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	const blobish = data as {
		arrayBuffer?: () => Promise<ArrayBuffer>;
		bytes?: () => Promise<Uint8Array>;
	};
	if (typeof blobish.arrayBuffer === 'function') {
		return new Uint8Array(await blobish.arrayBuffer());
	}
	if (typeof blobish.bytes === 'function') {
		return await blobish.bytes();
	}
	if (typeof Response !== 'undefined') {
		const ab = await new Response(data as Blob).arrayBuffer();
		return new Uint8Array(ab);
	}
	throw new VfsError('OPFS_IO', 'Cannot coerce value to bytes');
}

/** In-memory OPFS stand-in for unit tests and non-browser. */
export function createMemoryOpfs(): OpfsBlobStore {
	const files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();

	return {
		async writePartial(writeId, data) {
			const bytes = await toUint8Array(data);
			const tmpPath = `tmp/${writeId}.partial`;
			files.set(tmpPath, { bytes: new Uint8Array(bytes), mtimeMs: Date.now() });
			return { tmpPath, byteLength: bytes.byteLength };
		},
		async promote(tmpPath, finalOpfsPath) {
			const entry = files.get(tmpPath);
			if (!entry) throw new VfsError('OPFS_IO', `Missing tmp ${tmpPath}`);
			files.set(finalOpfsPath, { bytes: new Uint8Array(entry.bytes), mtimeMs: Date.now() });
			files.delete(tmpPath);
		},
		async writeAtomic(opfsPath, data) {
			const writeId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const { tmpPath, byteLength } = await this.writePartial(writeId, data);
			await this.promote(tmpPath, opfsPath);
			return { byteLength };
		},
		async writeFinal(opfsPath, data) {
			const bytes = await toUint8Array(data);
			files.set(opfsPath, { bytes: new Uint8Array(bytes), mtimeMs: Date.now() });
			return { byteLength: bytes.byteLength };
		},
		async read(opfsPath) {
			const entry = files.get(opfsPath);
			if (!entry) throw new VfsError('OPFS_IO', `Missing ${opfsPath}`);
			return new Uint8Array(entry.bytes);
		},
		async readBlob(opfsPath, contentType = 'application/octet-stream') {
			const bytes = await this.read(opfsPath);
			return new Blob([bytes as BlobPart], { type: contentType });
		},
		async remove(opfsPath) {
			files.delete(opfsPath);
		},
		async exists(opfsPath) {
			return files.has(opfsPath);
		},
		async listOrphans(prefix) {
			const out: string[] = [];
			for (const key of files.keys()) {
				if (key.startsWith(prefix) || key.startsWith(prefix.replace(/\/$/, '') + '/')) {
					out.push(key);
				}
			}
			// also match without trailing slash issues
			return out.filter((p) => p.startsWith(prefix) || (prefix.endsWith('/') && p.startsWith(prefix)));
		},
		async listTmp() {
			const out: Array<{ path: string; mtimeMs?: number }> = [];
			for (const [path, v] of files) {
				if (path.startsWith('tmp/')) out.push({ path, mtimeMs: v.mtimeMs });
			}
			return out;
		},
		async clearAll() {
			files.clear();
		}
	};
}

async function getRoot(rootDirName: string): Promise<FileSystemDirectoryHandle> {
	if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
		throw new VfsError('OPFS_UNAVAILABLE', 'Origin private file system is not available');
	}
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(rootDirName, { create: true });
}

async function ensureDir(
	parent: FileSystemDirectoryHandle,
	name: string
): Promise<FileSystemDirectoryHandle> {
	return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Storage exhaustion is the one OPFS failure the UI has specific wording for
 * ("Browser storage is full."), but nothing used to raise the code that selects
 * it, so a full disk surfaced as a generic I/O error. Quota shows up as a
 * DOMException named QuotaExceededError.
 */
function asWriteError(e: unknown, what: string): VfsError {
	if (e instanceof VfsError) return e;
	const name = (e as { name?: string } | null)?.name;
	if (name === 'QuotaExceededError') {
		return new VfsError('QUOTA_EXCEEDED', 'Browser storage is full.', { cause: String(e) });
	}
	return new VfsError('OPFS_IO', `Failed to ${what}`, { cause: String(e) });
}

async function writeFileHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
	// Prefer createWritable when available
	const anyHandle = handle as FileSystemFileHandle & {
		createWritable?: () => Promise<FileSystemWritableFileStream>;
	};
	if (typeof anyHandle.createWritable === 'function') {
		const writable = await anyHandle.createWritable();
		try {
			await writable.write(bytes as BufferSource);
			await writable.close();
		} catch (e) {
			// Abandoning a failed stream leaks it. Chrome backs createWritable
			// with a .crswap file and holds a lock on the target until the stream
			// is closed or aborted, so an unclosed one leaves BOTH files on disk
			// and makes them unremovable — gc sees the orphans, its remove() is
			// refused, and the debris survives every later sweep. Aborting drops
			// the swap file and releases the lock, so the next sweep can reclaim.
			try {
				await writable.abort();
			} catch {
				/* already faulted — nothing further to release */
			}
			throw asWriteError(e, 'write');
		}
		return;
	}
	throw new VfsError('OPFS_IO', 'createWritable not supported');
}

async function readFileHandle(handle: FileSystemFileHandle): Promise<Uint8Array> {
	const file = await handle.getFile();
	const ab = await file.arrayBuffer();
	return new Uint8Array(ab);
}

function splitPath(opfsPath: string): { dir: string; base: string } {
	const normalized = opfsPath.replace(/^\/+/, '');
	const i = normalized.lastIndexOf('/');
	if (i < 0) return { dir: '', base: normalized };
	return { dir: normalized.slice(0, i), base: normalized.slice(i + 1) };
}

export function createOpfsBlobStore(rootDirName = 'shared-vfs'): OpfsBlobStore {
	let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

	const root = () => {
		if (!rootPromise) rootPromise = getRoot(rootDirName);
		return rootPromise;
	};

	// Directory handles are memoized per path. Every getFileHandle in this store
	// resolves `blobs/` (or `tmp/`) first, and each resolve is its own IPC round
	// trip to the browser process — measured at 1.82ms, roughly one of the ~5
	// hops a single file write costs. The set of directories is tiny and fixed
	// for the life of the store, so caching the promise is safe and removes the
	// hop entirely after the first call.
	const dirCache = new Map<string, Promise<FileSystemDirectoryHandle>>();

	function resolveDir(dirPath: string): Promise<FileSystemDirectoryHandle> {
		const cached = dirCache.get(dirPath);
		if (cached) return cached;
		const pending = (async () => {
			let cur = await root();
			if (!dirPath) return cur;
			for (const part of dirPath.split('/').filter(Boolean)) {
				cur = await ensureDir(cur, part);
			}
			return cur;
		})();
		// Drop a rejected lookup so a transient failure is retried rather than
		// cached forever.
		void pending.catch(() => dirCache.delete(dirPath));
		dirCache.set(dirPath, pending);
		return pending;
	}

	async function getFile(opfsPath: string, create: boolean): Promise<FileSystemFileHandle> {
		const { dir, base } = splitPath(opfsPath);
		const d = await resolveDir(dir);
		return d.getFileHandle(base, { create });
	}

	return {
		async writePartial(writeId, data) {
			const bytes = await toUint8Array(data);
			const tmpPath = `tmp/${writeId}.partial`;
			const handle = await getFile(tmpPath, true);
			await writeFileHandle(handle, bytes);
			return { tmpPath, byteLength: bytes.byteLength };
		},
		async promote(tmpPath, finalOpfsPath) {
			// Prefer a rename. The copy path below reads the whole tmp file
			// back and writes every byte a second time, which made a single
			// file write ~10 OPFS round trips: measured at 19.4ms per
			// vfs.writeFile against ~2.3ms for one OPFS operation, and writes
			// are 59% of the cost of a git commit.
			//
			// `move` is not universally available, and a rename across a
			// directory can still fail, so any failure falls back to the copy
			// rather than leaving the write half-done.
			const { dir, base } = splitPath(finalOpfsPath);
			try {
				const tmpHandle = await getFile(tmpPath, false);
				const movable = tmpHandle as FileSystemFileHandle & {
					move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
				};
				if (typeof movable.move === 'function') {
					await movable.move(await resolveDir(dir), base);
					return;
				}
			} catch {
				// fall through to copy
			}
			const bytes = await this.read(tmpPath);
			const finalHandle = await getFile(finalOpfsPath, true);
			await writeFileHandle(finalHandle, bytes);
			await this.remove(tmpPath);
		},
		async writeAtomic(opfsPath, data) {
			const writeId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const { tmpPath, byteLength } = await this.writePartial(writeId, data);
			await this.promote(tmpPath, opfsPath);
			return { byteLength };
		},
		async writeFinal(opfsPath, data) {
			const handle = await getFile(opfsPath, true);
			const anyHandle = handle as FileSystemFileHandle & {
				createWritable?: () => Promise<FileSystemWritableFileStream>;
			};
			// Packs are assembled as a multi-part Blob on purpose: createWritable
			// can take the Blob without flattening it next to the still-held
			// member arrays. Sync-handle stores still have to copy.
			if (data instanceof Blob && typeof anyHandle.createWritable === 'function') {
				const writable = await anyHandle.createWritable();
				try {
					await writable.write(data);
					await writable.close();
				} catch (e) {
					try {
						await writable.abort();
					} catch {
						/* already faulted */
					}
					throw asWriteError(e, 'write');
				}
				return { byteLength: data.size };
			}
			const bytes = await toUint8Array(data);
			await writeFileHandle(handle, bytes);
			return { byteLength: bytes.byteLength };
		},
		async read(opfsPath) {
			try {
				const handle = await getFile(opfsPath, false);
				return await readFileHandle(handle);
			} catch (e) {
				if (e instanceof VfsError) throw e;
				throw new VfsError('OPFS_IO', `Failed to read ${opfsPath}`, { cause: String(e) });
			}
		},
		async readBlob(opfsPath, contentType = 'application/octet-stream') {
			// Return the File itself (a Blob) rather than reading it out and
			// re-wrapping: a File is already file-backed and lazy, so nothing is
			// read until a consumer actually touches the bytes. Measured on 64MB:
			// 135.6ms eager vs 0.77ms here. Every thumbnail, preview and download
			// path benefits.
			try {
				const handle = await getFile(opfsPath, false);
				const file = await handle.getFile();
				return contentType ? file.slice(0, file.size, contentType) : file;
			} catch (e) {
				if (e instanceof VfsError) throw e;
				throw new VfsError('OPFS_IO', `Failed to read ${opfsPath}`, { cause: String(e) });
			}
		},
		async readRange(opfsPath, offset, length, contentType) {
			try {
				const handle = await getFile(opfsPath, false);
				const file = await handle.getFile();
				// File.slice is lazy: this reads nothing until the caller consumes
				// it, so pulling one member out of a large pack costs a slice, not
				// a full read. Past-EOF slices are SHORTER than `length` — the
				// caller must treat that as a short pack, not as zeroes.
				const slice = file.slice(offset, offset + length, contentType);
				if (slice.size !== length) {
					throw new VfsError(
						'OPFS_IO',
						`Short pack read from ${opfsPath}: got ${slice.size} of ${length} bytes at ${offset}`
					);
				}
				return slice;
			} catch (e) {
				if (e instanceof VfsError) throw e;
				throw new VfsError('OPFS_IO', `Failed to read ${opfsPath}`, { cause: String(e) });
			}
		},
		async remove(opfsPath) {
			try {
				const { dir, base } = splitPath(opfsPath);
				const d = await resolveDir(dir);
				await d.removeEntry(base);
			} catch {
				// ignore missing
			}
		},
		async exists(opfsPath) {
			try {
				await getFile(opfsPath, false);
				return true;
			} catch {
				return false;
			}
		},
		async listOrphans(prefix) {
			const out: string[] = [];
			const { dir } = splitPath(prefix.endsWith('/') ? prefix + 'x' : prefix + '/x');
			const baseDir = prefix.replace(/\/$/, '');
			try {
				const d = await resolveDir(baseDir.includes('/') ? baseDir.split('/')[0]! : baseDir);
				// list top-level under blobs/ or tmp/
				const target = await resolveDir(prefix.replace(/\/$/, ''));
				for await (const [name, handle] of dirEntries(target)) {
					if (handle.kind === 'file') {
						out.push(`${prefix.replace(/\/$/, '')}/${name}`);
					}
				}
			} catch {
				// empty
			}
			void dir;
			return out;
		},
		async listTmp() {
			const out: Array<{ path: string; mtimeMs?: number }> = [];
			try {
				const tmpDir = await resolveDir('tmp');
				for await (const [name, handle] of dirEntries(tmpDir)) {
					if (handle.kind === 'file') {
						const file = await (handle as FileSystemFileHandle).getFile();
						out.push({ path: `tmp/${name}`, mtimeMs: file.lastModified });
					}
				}
			} catch {
				/* tmp dir may not exist yet */
			}
			return out;
		},
		async clearAll() {
			try {
				const r = await root();
				for await (const [name] of dirEntries(r)) {
					await r.removeEntry(name, { recursive: true });
				}
			} catch {
				// ignore
			}
			// resolveDir caches handles on the premise that these directories
			// live as long as the store does — which is true of everything
			// EXCEPT this method, which just deleted them. A cached handle to a
			// removed directory throws NotFoundError on every later write, so
			// the session would be unable to write anything until a reload.
			dirCache.clear();
		}
	};
}
