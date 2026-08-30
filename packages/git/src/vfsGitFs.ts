/**
 * isomorphic-git FsClient over SharedVFS, chrooted at a project folder.
 * POSIX `dir` for git is always `'/'`. GitRepoRef.path is the VFS folder id.
 */
import './ensureBuffer.js';
import type { VfsNode, VfsService } from '@shared-packages/file-system';
import type { GitFs } from './local.js';

type PromiseFs = Extract<GitFs, { promises: object }>;

type VfsGitFs = {
	promises: PromiseFs['promises'] & {
		rename(oldPath: string, newPath: string): Promise<void>;
		symlink(target: string, path: string): Promise<never>;
		readlink(path: string): Promise<never>;
	};
};

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
		// `ino` carries the node's write counter, not just its identity.
		//
		// isomorphic-git skips re-hashing a file when its cached stats look
		// unchanged, and compareStats() checks mtimeSECONDS (never the
		// nanoseconds field) plus size, mode, uid, gid and ino. So an edit that
		// keeps the same length and lands in the same second is invisible:
		// writing 'one' then 'two' reproduces it every time, and status reports
		// the file as clean. Real git handles this "racily clean" case by
		// re-hashing; isomorphic-git does not.
		//
		// There are no inodes here — inoOf is already a hash of the id — so
		// folding in `generation` (which the VFS bumps on every write) costs
		// nothing and makes a changed file always look stale. It can only ever
		// cause an unnecessary re-hash, never a missed change, and an unchanged
		// file keeps its value so the cache still works.
		ino: inoOf(`${node.id}:${(node as VfsNode & { generation?: number }).generation ?? 0}`),
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

/** The chroot folder, or ENOENT if it is gone. */
async function requireRoot(vfs: VfsService, rootId: string): Promise<VfsNode> {
	const root = await vfs.get(rootId);
	if (!root || root.kind !== 'folder' || root.deletedAt != null) {
		throw nodeErr('ENOENT', `git root missing: ${rootId}`);
	}
	return root;
}

async function walk(
	vfs: VfsService,
	rootId: string,
	p: string
): Promise<Found | Missing | { node: VfsNode; parentId: null; root: true }> {
	// The root node itself is only NEEDED to answer a request for '/'. Fetching
	// it up front cost one get per path resolution — measured at 17.5 per file
	// committed, and every `get` the shim made was this same node. Deep paths
	// get their error from the first segment lookup instead, and the explicit
	// "root is gone" check is paid only when that lookup misses (rare, and
	// already the slow path).
	const segs = normalizeSegments(p);
	if (segs.length === 0) {
		return { node: await requireRoot(vfs, rootId), parentId: null, root: true };
	}

	let parentId = rootId;
	for (let i = 0; i < segs.length; i++) {
		const name = segs[i]!;
		// One indexed lookup per segment. Listing the folder and scanning for
		// the name made every path resolution cost the folder's size, and git
		// resolves a path for each stat/read/write — measured at 41,123
		// directory entries scanned to commit 60 files, growing linearly per
		// file (427/file at N=30, 1182/file at N=120), i.e. O(N^2) overall.
		const hit = await vfs.childByName(parentId, name);
		const last = i === segs.length - 1;
		if (!hit) {
			// A miss directly under the root is ambiguous: the child may be
			// absent, or the whole repo folder may have been deleted. Only here
			// is it worth a round trip to tell those apart.
			if (i === 0) await requireRoot(vfs, rootId);
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

function mapVfsError(e: unknown, path: string): never {
	const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : '';
	if (code === 'NOT_FOUND') throw nodeErr('ENOENT', path);
	if (code === 'NAME_CONFLICT') throw nodeErr('EEXIST', path);
	if (code === 'CYCLE' || code === 'INVALID_NAME') throw nodeErr('EINVAL', path);
	throw e;
}

export function createVfsGitFs(vfs: VfsService, opts: CreateVfsGitFsOptions): VfsGitFs {
	const rootId = opts.rootId;

	// Every delete here passes `compact: false`. permanentDelete compacts by
	// default, which is right for a user deleting one file and catastrophic
	// for git: a single checkout unlinks hundreds of paths, and each one would
	// rewrite a whole pack. Dead space is reclaimed by the load sweep and by
	// emptying the trash, both of which do it once instead of N times.

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
				await vfs.permanentDelete(w.node.id, { compact: false });
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
			await vfs.permanentDelete(w.node.id, { compact: false });
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
		},

		async rename(oldPath: string, newPath: string) {
			const src = await walk(vfs, rootId, oldPath);
			if (!src.node) throw nodeErr('ENOENT', oldPath);
			if ('root' in src && src.root) throw nodeErr('EPERM', oldPath);

			const dest = await walk(vfs, rootId, newPath);
			if ('root' in dest && dest.root) throw nodeErr('EPERM', newPath);
			if (dest.node?.id === src.node.id) return;
			if (dest.node?.kind === 'folder') throw nodeErr('EEXIST', newPath);
			if (dest.node?.kind === 'file' && src.node.kind === 'folder') {
				throw nodeErr('EEXIST', newPath);
			}

			const destName = dest.node ? dest.node.name : dest.name;
			const destParentId = dest.parentId;
			try {
				// VFS rename/move suffixes on collision; POSIX overwrite must delete dest first.
				if (dest.node?.kind === 'file') {
					await vfs.permanentDelete(dest.node.id, { compact: false });
				}
				if (src.parentId === destParentId) {
					await vfs.rename(src.node.id, destName);
				} else {
					await vfs.move(src.node.id, destParentId, { name: destName });
				}
			} catch (e) {
				mapVfsError(e, newPath);
			}
		}
	};

	return { promises } as VfsGitFs;
}
