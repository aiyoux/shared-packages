/**
 * isomorphic-git FsClient over SharedVFS, chrooted at a project folder.
 * POSIX `dir` for git is always `'/'`. GitRepoRef.path is the VFS folder id.
 */
import './ensureBuffer.js';
import type { VfsNode, VfsService } from '@shared-packages/file-system';
import type { GitFs } from './local.js';

export type CreateVfsGitFsOptions = {
	/** VFS folder id of the working tree. */
	rootId: string;
};

type NodeErr = Error & { code: string };

function nodeErr(code: string, message?: string): NodeErr {
	const e = new Error(message ?? code) as NodeErr;
	e.code = code;
	return e;
}

function toBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (typeof data === 'string') return new TextEncoder().encode(data);
	if (data instanceof Blob) {
		throw nodeErr('EINVAL', 'Blob write must be awaited by caller');
	}
	return new TextEncoder().encode(String(data ?? ''));
}

function normalizeSegments(p: string): string[] {
	const raw = p.replace(/\\/g, '/');
	const out: string[] = [];
	for (const part of raw.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (out.length === 0) throw nodeErr('ENOENT', 'path escapes git root');
			out.pop();
			continue;
		}
		out.push(part);
	}
	return out;
}

function inoOf(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
	return (h >>> 0) || 1;
}

function statsFor(node: VfsNode | { id: string; kind: 'folder'; size?: number; updatedAt: number; createdAt: number }) {
	const isDir = node.kind === 'folder';
	const mode = isDir ? 0o040000 : 0o100644;
	const mtimeMs = node.updatedAt ?? Date.now();
	const ctimeMs = node.createdAt ?? mtimeMs;
	return {
		type: isDir ? 'dir' : 'file',
		mode,
		size: node.size ?? 0,
		ino: inoOf(node.id),
		dev: 1,
		uid: 0,
		gid: 0,
		mtimeMs,
		ctimeMs,
		mtime: new Date(mtimeMs),
		ctime: new Date(ctimeMs),
		isFile: () => !isDir,
		isDirectory: () => isDir,
		isSymbolicLink: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false
	};
}

type Found = { node: VfsNode; parentId: string };
type Missing = { node: null; parentId: string; name: string };

async function walk(
	vfs: VfsService,
	rootId: string,
	p: string
): Promise<Found | Missing | { node: VfsNode; parentId: null; root: true }> {
	const root = await vfs.get(rootId);
	if (!root || root.kind !== 'folder' || root.deletedAt != null) {
		throw nodeErr('ENOENT', `git root missing: ${rootId}`);
	}
	const segs = normalizeSegments(p);
	if (segs.length === 0) return { node: root, parentId: null, root: true };

	let parentId = rootId;
	for (let i = 0; i < segs.length; i++) {
		const name = segs[i]!;
		const kids = await vfs.list({ parentId });
		const hit = kids.find((n) => n.name === name);
		const last = i === segs.length - 1;
		if (!hit) {
			if (last) return { node: null, parentId, name };
			throw nodeErr('ENOENT', p);
		}
		if (last) return { node: hit, parentId };
		if (hit.kind !== 'folder') throw nodeErr('ENOTDIR', p);
		parentId = hit.id;
	}
	throw nodeErr('ENOENT', p);
}

function encodingOf(opts?: unknown): string | undefined {
	if (typeof opts === 'string') return opts;
	if (opts && typeof opts === 'object' && 'encoding' in opts) {
		const enc = (opts as { encoding?: string }).encoding;
		return enc;
	}
	return undefined;
}

export function createVfsGitFs(vfs: VfsService, opts: CreateVfsGitFsOptions): GitFs {
	const rootId = opts.rootId;

	const promises = {
		async readFile(path: string, options?: unknown) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			if (w.node.kind !== 'file') throw nodeErr('EISDIR', path);
			const bytes = await vfs.readBytes(w.node.id);
			const enc = encodingOf(options);
			if (enc === 'utf8' || enc === 'utf-8') return new TextDecoder().decode(bytes);
			return bytes;
		},

		async writeFile(path: string, data: unknown, _options?: unknown) {
			const bytes = toBytes(data);
			const w = await walk(vfs, rootId, path);
			if ('root' in w && w.root) throw nodeErr('EPERM', path);
			if (w.node) {
				if (w.node.kind !== 'file') throw nodeErr('EISDIR', path);
				await vfs.updateFile(w.node.id, bytes, { force: true });
				return;
			}
			await vfs.writeFile({
				parentId: w.parentId,
				name: w.name,
				body: bytes,
				fileType: 'unknown',
				contentType: 'application/octet-stream',
				onConflict: 'error'
			});
		},

		async mkdir(path: string, _mode?: unknown) {
			const w = await walk(vfs, rootId, path);
			if ('root' in w && w.root) throw nodeErr('EEXIST', path);
			if (w.node) {
				if (w.node.kind === 'folder') throw nodeErr('EEXIST', path);
				throw nodeErr('EEXIST', path);
			}
			await vfs.mkdir(w.parentId, w.name, { onConflict: 'error' });
		},

		async rmdir(path: string) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			if ('root' in w && w.root) throw nodeErr('EPERM', path);
			if (w.node.kind !== 'folder') throw nodeErr('ENOTDIR', path);
			try {
				await vfs.permanentDelete(w.node.id);
			} catch (e) {
				const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : '';
				if (code === 'HAS_CHILDREN') throw nodeErr('ENOTEMPTY', path);
				throw e;
			}
		},

		async unlink(path: string) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			if ('root' in w && w.root) throw nodeErr('EPERM', path);
			if (w.node.kind !== 'file') throw nodeErr('EISDIR', path);
			await vfs.permanentDelete(w.node.id);
		},

		async readdir(path: string) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			if (w.node.kind !== 'folder') throw nodeErr('ENOTDIR', path);
			const kids = await vfs.list({ parentId: w.node.id });
			return kids.map((n) => n.name);
		},

		async stat(path: string) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			return statsFor(w.node);
		},

		async lstat(path: string) {
			return promises.stat(path);
		},

		async symlink(_target: string, _path: string) {
			throw nodeErr('ENOSYS', 'symlinks are not supported in VFS git');
		},

		async readlink(path: string) {
			const w = await walk(vfs, rootId, path);
			if (!w.node) throw nodeErr('ENOENT', path);
			throw nodeErr('EINVAL', 'not a symlink');
		}
	};

	return { promises };
}
