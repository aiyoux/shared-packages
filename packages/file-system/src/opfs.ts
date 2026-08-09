import { VfsError } from './types.js';

export interface OpfsBlobStore {
	/** Accept Uint8Array explicitly — TS 5.7+ ArrayBufferLike generics break bare BufferSource. */
	writePartial(
		writeId: string,
		data: BufferSource | Blob | Uint8Array
	): Promise<{ tmpPath: string; byteLength: number }>;
	promote(tmpPath: string, finalOpfsPath: string): Promise<void>;
	writeAtomic(opfsPath: string, data: BufferSource | Blob): Promise<{ byteLength: number }>;
	read(opfsPath: string): Promise<Uint8Array>;
	readBlob(opfsPath: string, contentType?: string): Promise<Blob>;
	remove(opfsPath: string): Promise<void>;
	exists(opfsPath: string): Promise<boolean>;
	listOrphans(prefix: string): Promise<string[]>;
	listTmp(): Promise<Array<{ path: string; mtimeMs?: number }>>;
	/** Test/debug: wipe entire store */
	clearAll?(): Promise<void>;
}

async function toUint8Array(data: BufferSource | Blob): Promise<Uint8Array> {
	if (data instanceof Blob) {
		const ab = await data.arrayBuffer();
		return new Uint8Array(ab);
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data as ArrayBuffer);
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

async function writeFileHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
	// Prefer createWritable when available
	const anyHandle = handle as FileSystemFileHandle & {
		createWritable?: () => Promise<FileSystemWritableFileStream>;
	};
	if (typeof anyHandle.createWritable === 'function') {
		const writable = await anyHandle.createWritable();
		await writable.write(bytes);
		await writable.close();
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

	async function resolveDir(dirPath: string): Promise<FileSystemDirectoryHandle> {
		let cur = await root();
		if (!dirPath) return cur;
		for (const part of dirPath.split('/').filter(Boolean)) {
			cur = await ensureDir(cur, part);
		}
		return cur;
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
			const bytes = await this.read(opfsPath);
			return new Blob([bytes as BlobPart], { type: contentType });
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
				// @ts-expect-error async iterator
				for await (const [name, handle] of target.entries()) {
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
			const paths = await this.listOrphans('tmp');
			return paths.map((path) => ({ path, mtimeMs: Date.now() }));
		},
		async clearAll() {
			try {
				const r = await root();
				// @ts-expect-error async iterator
				for await (const [name] of r.entries()) {
					await r.removeEntry(name, { recursive: true });
				}
			} catch {
				// ignore
			}
		}
	};
}
