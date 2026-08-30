import { afterEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import {
	createMemoryOpfs,
	createVfs,
	packProject,
	type OpfsBlobStore,
	type VfsService
} from '@shared-packages/file-system';
import { createGitHost } from './host.js';
import { localSnapshot } from './local.js';
import { closeGitReposDbForTests } from './repos.js';
import { createVfsGitFs } from './vfsGitFs.js';

const AUTHOR = { name: 'Test', email: 't@t.test' };

async function makeProject(): Promise<{ vfs: VfsService; folderId: string; fs: ReturnType<typeof createVfsGitFs> }> {
	const vfs = createVfs({
		dbName: `git-fs-${crypto.randomUUID()}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'repo');
	const fs = createVfsGitFs(vfs, { rootId: folder.id });
	return { vfs, folderId: folder.id, fs };
}

async function commitReadme(
	fs: ReturnType<typeof createVfsGitFs>,
	message: string,
	body = 'hello\n'
): Promise<void> {
	await git.init({ fs, dir: '/' });
	await fs.promises.writeFile('/README.md', body);
	await git.add({ fs, dir: '/', filepath: 'README.md' });
	await git.commit({ fs, dir: '/', message, author: AUTHOR });
}

afterEach(async () => {
	await closeGitReposDbForTests();
});

describe('createVfsGitFs', () => {
	it('inits without renaming .git, then commits and logs', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		const kids = await vfs.list({ parentId: folderId });
		expect(kids.filter((n) => n.name.startsWith('.git')).map((n) => n.name)).toEqual(['.git']);
		const gitDir = kids.find((n) => n.name === '.git')!;
		expect(gitDir.kind).toBe('folder');
		const head = await fs.promises.readFile('/.git/HEAD', 'utf8');
		expect(String(head)).toMatch(/ref: refs\/heads\//);

		await fs.promises.writeFile('/README.md', 'hello\n');
		await git.add({ fs, dir: '/', filepath: 'README.md' });
		await git.commit({ fs, dir: '/', message: 'initial commit', author: AUTHOR });
		const snap = await localSnapshot(fs, '/');
		expect(snap.log[0]?.subject).toBe('initial commit');
		expect(snap.log[0]?.sha.length).toBeGreaterThan(7);
		expect(snap.status.dirty).toBe(false);
	});

	it('marks dirty after a worktree edit and clean after add+commit', async () => {
		const { fs } = await makeProject();
		await commitReadme(fs, 'initial commit');
		await fs.promises.writeFile('/README.md', 'hello world\n');
		const dirty = await localSnapshot(fs, '/');
		expect(dirty.status.dirty).toBe(true);
		await git.add({ fs, dir: '/', filepath: 'README.md' });
		await git.commit({ fs, dir: '/', message: 'second', author: AUTHOR });
		const clean = await localSnapshot(fs, '/');
		expect(clean.status.dirty).toBe(false);
		expect(clean.log[0]?.subject).toBe('second');
	});

	it('stores loose objects under nested hex dirs without extra extensions', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await commitReadme(fs, 'initial commit');
		const gitDir = (await vfs.list({ parentId: folderId })).find((n) => n.name === '.git')!;
		const objects = (await vfs.list({ parentId: gitDir.id })).find((n) => n.name === 'objects')!;
		const hexDirs = (await vfs.list({ parentId: objects.id })).filter(
			(n) => n.kind === 'folder' && /^[0-9a-f]{2}$/.test(n.name)
		);
		expect(hexDirs.length).toBeGreaterThan(0);
		const files = await vfs.list({ parentId: hexDirs[0]!.id });
		expect(files.some((f) => f.kind === 'file' && !f.name.includes('/') && !f.name.includes('.'))).toBe(
			true
		);
	});

	it('unlinks git temp files with permanentDelete, not trash', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		await fs.promises.writeFile('/.git/index.lock', 'x');
		await fs.promises.unlink('/.git/index.lock');
		const gitDir = (await vfs.list({ parentId: folderId })).find((n) => n.name === '.git')!;
		const active = await vfs.list({ parentId: gitDir.id });
		expect(active.some((n) => n.name === 'index.lock')).toBe(false);
		const including = await vfs.list({ parentId: gitDir.id, includeDeleted: true });
		expect(including.some((n) => n.name === 'index.lock' && n.deletedAt != null)).toBe(false);
		await fs.promises.writeFile('/.git/index.lock', 'y');
		const again = await vfs.list({ parentId: gitDir.id });
		expect(again.filter((n) => n.name === 'index.lock')).toHaveLength(1);
	});

	it('overwrites HEAD in place and does not JSON-encode strings', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		await fs.promises.writeFile('/.git/HEAD', 'ref: refs/heads/topic\n');
		const gitDir = (await vfs.list({ parentId: folderId })).find((n) => n.name === '.git')!;
		expect((await vfs.list({ parentId: gitDir.id })).filter((n) => n.name.startsWith('HEAD'))).toHaveLength(
			1
		);
		const raw = await fs.promises.readFile('/.git/HEAD', 'utf8');
		expect(raw).toBe('ref: refs/heads/topic\n');
		expect(raw).not.toMatch(/^"/);
	});

	it('two repos in one VFS do not leak objects', async () => {
		const vfs = createVfs({
			dbName: `git-fs-${crypto.randomUUID()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const a = await vfs.mkdir(null, 'repoA');
		const b = await vfs.mkdir(null, 'repoB');
		const fsA = createVfsGitFs(vfs, { rootId: a.id });
		const fsB = createVfsGitFs(vfs, { rootId: b.id });
		await commitReadme(fsA, 'from-a', 'A\n');
		await commitReadme(fsB, 'from-b', 'B\n');
		const logA = await git.log({ fs: fsA, dir: '/', depth: 5 });
		const logB = await git.log({ fs: fsB, dir: '/', depth: 5 });
		expect(logA[0]?.commit.message).toMatch(/^from-a/);
		expect(logB[0]?.commit.message).toMatch(/^from-b/);
		expect(logA.some((c) => c.commit.message.startsWith('from-b'))).toBe(false);
	});

	it('readFile missing is ENOENT; symlink is ENOSYS', async () => {
		const { fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		await expect(fs.promises.readFile('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(fs.promises.symlink('a', '/b')).rejects.toMatchObject({ code: 'ENOSYS' });
		const st = await fs.promises.stat('/.git');
		expect(st.isDirectory()).toBe(true);
		expect(st.isFile()).toBe(false);
		expect(st.isSymbolicLink()).toBe(false);
	});

	it('never compacts packs on delete — a checkout must not rewrite a pack per file', async () => {
		const { vfs, fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		await fs.promises.writeFile('/a.txt', 'a');
		await fs.promises.writeFile('/b.txt', 'b');
		await vfs.mkdir((await vfs.list({ parentId: null }))[0]!.id, 'sub').catch(() => {});

		const spy = vi.spyOn(vfs, 'permanentDelete');
		await fs.promises.unlink('/a.txt');
		await fs.promises.rename('/b.txt', '/a.txt'); // overwrite path deletes dest

		expect(spy).toHaveBeenCalled();
		// permanentDelete compacts by DEFAULT. git deletes in bulk, so every
		// call from this shim must opt out; one missed call is a whole pack
		// rewritten per deleted file.
		for (const call of spy.mock.calls) {
			expect(call[1]).toMatchObject({ compact: false });
		}
		spy.mockRestore();
	});

	it('readdir uses vfs.list (uncapped), not the explorer 2000 cap', async () => {
		const { vfs, folderId, fs } = await makeProject();
		const dump = await vfs.mkdir(folderId, 'dump');
		const n = 80;
		for (let i = 0; i < n; i++) {
			await vfs.writeFile({
				parentId: dump.id,
				name: `f${i}`,
				body: new Uint8Array([1]),
				fileType: 'unknown',
				onConflict: 'error'
			});
		}
		const list = vi.spyOn(vfs, 'list');
		const names = await fs.promises.readdir('/dump');
		expect(names).toHaveLength(n);
		expect(list).toHaveBeenCalled();
		list.mockRestore();
	});
});

describe('createVfsGitFs.promises.rename', () => {
	function matrixRows(matrix: Awaited<ReturnType<typeof git.statusMatrix>>) {
		return Object.fromEntries(matrix.map(([p, head, workdir, stage]) => [p, [head, workdir, stage]]));
	}

	async function namesAt(vfs: VfsService, parentId: string, includeDeleted = false) {
		return (await vfs.list({ parentId, includeDeleted })).map((n) => n.name);
	}

	it('preserves file id and ino', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await fs.promises.writeFile('/README.md', 'hello\n');
		const beforeNode = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'README.md')!;
		const before = await fs.promises.stat('/README.md');
		await fs.promises.rename('/README.md', '/MOVED.md');
		await expect(fs.promises.stat('/README.md')).rejects.toMatchObject({ code: 'ENOENT' });
		const after = await fs.promises.stat('/MOVED.md');
		expect(after.ino).toBe(before.ino);
		const afterNode = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'MOVED.md')!;
		expect(afterNode.id).toBe(beforeNode.id);
		expect(String(await fs.promises.readFile('/MOVED.md', 'utf8'))).toBe('hello\n');
	});

	it('renames a directory and preserves folder id/ino and children', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await fs.promises.mkdir('/page');
		await fs.promises.writeFile('/page/index.kb', 'body\n');
		const page = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'page')!;
		const before = await fs.promises.stat('/page');
		await fs.promises.rename('/page', '/other');
		await expect(fs.promises.stat('/page')).rejects.toMatchObject({ code: 'ENOENT' });
		const after = await fs.promises.stat('/other');
		expect(after.ino).toBe(before.ino);
		expect(after.isDirectory()).toBe(true);
		const moved = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'other')!;
		expect(moved.id).toBe(page.id);
		expect(await fs.promises.readdir('/other')).toEqual(['index.kb']);
		expect(String(await fs.promises.readFile('/other/index.kb', 'utf8'))).toBe('body\n');
	});

	it('overwrites a dest file without suffixing foo (1)', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await fs.promises.writeFile('/foo.txt', 'src\n');
		await fs.promises.writeFile('/bar.txt', 'dest\n');
		const src = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'foo.txt')!;
		const dest = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'bar.txt')!;
		await fs.promises.rename('/foo.txt', '/bar.txt');
		const active = await namesAt(vfs, folderId);
		expect(active).toContain('bar.txt');
		expect(active).not.toContain('foo.txt');
		expect(active.some((n) => n.includes('(1)'))).toBe(false);
		expect(active).not.toContain('bar (1).txt');
		expect(String(await fs.promises.readFile('/bar.txt', 'utf8'))).toBe('src\n');
		const kept = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'bar.txt')!;
		expect(kept.id).toBe(src.id);
		expect(kept.id).not.toBe(dest.id);
		const including = await vfs.list({ parentId: folderId, includeDeleted: true });
		expect(including.some((n) => n.id === dest.id)).toBe(false);
		expect(including.some((n) => n.name === 'bar (1).txt')).toBe(false);
	});

	it('overwrites a dest file in another directory without suffixing', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await fs.promises.mkdir('/a');
		await fs.promises.mkdir('/b');
		await fs.promises.writeFile('/a/old.txt', 'src\n');
		await fs.promises.writeFile('/b/new.txt', 'dest\n');
		const a = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'a')!;
		const b = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'b')!;
		const src = (await vfs.list({ parentId: a.id })).find((n) => n.name === 'old.txt')!;
		await fs.promises.rename('/a/old.txt', '/b/new.txt');
		const bNames = await namesAt(vfs, b.id);
		expect(bNames).toEqual(['new.txt']);
		expect(bNames).not.toContain('new (1).txt');
		expect(await namesAt(vfs, a.id)).toEqual([]);
		expect(String(await fs.promises.readFile('/b/new.txt', 'utf8'))).toBe('src\n');
		const kept = (await vfs.list({ parentId: b.id })).find((n) => n.name === 'new.txt')!;
		expect(kept.id).toBe(src.id);
	});

	it('throws EEXIST when dest is a directory', async () => {
		const { fs } = await makeProject();
		await fs.promises.mkdir('/dir');
		await fs.promises.writeFile('/file.txt', 'x\n');
		await expect(fs.promises.rename('/file.txt', '/dir')).rejects.toMatchObject({ code: 'EEXIST' });
		await fs.promises.mkdir('/other');
		await expect(fs.promises.rename('/dir', '/other')).rejects.toMatchObject({ code: 'EEXIST' });
		expect(await fs.promises.readdir('/')).toEqual(expect.arrayContaining(['dir', 'file.txt', 'other']));
		expect(String(await fs.promises.readFile('/file.txt', 'utf8'))).toBe('x\n');
	});

	it('throws EEXIST when moving a directory onto a dest file', async () => {
		const { fs } = await makeProject();
		await fs.promises.mkdir('/dir');
		await fs.promises.writeFile('/dir/child.txt', 'c\n');
		await fs.promises.writeFile('/file.txt', 'x\n');
		await expect(fs.promises.rename('/dir', '/file.txt')).rejects.toMatchObject({ code: 'EEXIST' });
		expect(String(await fs.promises.readFile('/file.txt', 'utf8'))).toBe('x\n');
		expect(await fs.promises.readdir('/dir')).toEqual(['child.txt']);
	});

	it('throws ENOENT when the old path is missing', async () => {
		const { fs } = await makeProject();
		await expect(fs.promises.rename('/nope', '/dest')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('throws ENOENT when the dest parent is missing', async () => {
		const { fs } = await makeProject();
		await fs.promises.writeFile('/foo.txt', 'x\n');
		await expect(fs.promises.rename('/foo.txt', '/missing/foo.txt')).rejects.toMatchObject({
			code: 'ENOENT'
		});
		expect(String(await fs.promises.readFile('/foo.txt', 'utf8'))).toBe('x\n');
	});

	it('throws EPERM when renaming the git root or onto the git root', async () => {
		const { fs } = await makeProject();
		await fs.promises.writeFile('/foo.txt', 'x\n');
		await expect(fs.promises.rename('/', '/other')).rejects.toMatchObject({ code: 'EPERM' });
		await expect(fs.promises.rename('/foo.txt', '/')).rejects.toMatchObject({ code: 'EPERM' });
	});

	it('is a no-op when old and new resolve to the same node', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await fs.promises.writeFile('/foo.txt', 'keep\n');
		const node = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'foo.txt')!;
		await fs.promises.rename('/foo.txt', '/foo.txt');
		await fs.promises.rename('/foo.txt', '/./foo.txt');
		const again = (await vfs.list({ parentId: folderId })).find((n) => n.name === 'foo.txt')!;
		expect(again.id).toBe(node.id);
		expect(String(await fs.promises.readFile('/foo.txt', 'utf8'))).toBe('keep\n');
		expect(await namesAt(vfs, folderId)).toEqual(['foo.txt']);
	});

	it('throws EINVAL when moving a directory into itself', async () => {
		const { fs } = await makeProject();
		await fs.promises.mkdir('/dir');
		await expect(fs.promises.rename('/dir', '/dir/nested')).rejects.toMatchObject({ code: 'EINVAL' });
		expect(await fs.promises.readdir('/')).toEqual(['dir']);
		expect((await fs.promises.stat('/dir')).isDirectory()).toBe(true);
	});

	it('statusMatrix after a tracked file rename is delete+untracked and dirty', async () => {
		const { fs } = await makeProject();
		await commitReadme(fs, 'initial commit');
		const clean = await git.statusMatrix({ fs, dir: '/' });
		expect(matrixRows(clean)['README.md']).toEqual([1, 1, 1]);
		await fs.promises.rename('/README.md', '/MOVED.md');
		const rows = matrixRows(await git.statusMatrix({ fs, dir: '/' }));
		expect(rows['README.md']).toEqual([1, 0, 1]);
		expect(rows['MOVED.md']).toEqual([0, 2, 0]);
		const snap = await localSnapshot(fs, '/');
		expect(snap.status.dirty).toBe(true);
	});

	it('statusMatrix after a tracked folder rename is still delete+untracked', async () => {
		const { fs } = await makeProject();
		await git.init({ fs, dir: '/' });
		await fs.promises.mkdir('/page');
		await fs.promises.writeFile('/page/index.kb', 'wiki\n');
		await git.add({ fs, dir: '/', filepath: 'page/index.kb' });
		await git.commit({ fs, dir: '/', message: 'page', author: AUTHOR });
		await fs.promises.rename('/page', '/other');
		const rows = matrixRows(await git.statusMatrix({ fs, dir: '/' }));
		expect(rows['page/index.kb']).toEqual([1, 0, 1]);
		expect(rows['other/index.kb']).toEqual([0, 2, 0]);
		expect((await localSnapshot(fs, '/')).status.dirty).toBe(true);
	});

	it('git.remove + git.add after rename stages delete+add; commit clears dirty', async () => {
		const { fs } = await makeProject();
		await commitReadme(fs, 'initial commit');
		await fs.promises.rename('/README.md', '/MOVED.md');
		await git.remove({ fs, dir: '/', filepath: 'README.md' });
		await git.add({ fs, dir: '/', filepath: 'MOVED.md' });
		const staged = matrixRows(await git.statusMatrix({ fs, dir: '/' }));
		expect(staged['README.md']).toEqual([1, 0, 0]);
		expect(staged['MOVED.md']).toEqual([0, 2, 2]);
		await git.commit({ fs, dir: '/', message: 'rename', author: AUTHOR });
		const after = matrixRows(await git.statusMatrix({ fs, dir: '/' }));
		expect(after['README.md']).toBeUndefined();
		expect(after['MOVED.md']).toEqual([1, 1, 1]);
		expect((await localSnapshot(fs, '/')).status.dirty).toBe(false);
	});
});

function packedRangeStore(): OpfsBlobStore {
	const base = createMemoryOpfs();
	return {
		...base,
		async readRange(path, offset, length, contentType) {
			const all = await base.read(path);
			if (offset + length > all.byteLength) {
				throw new Error(`short pack ${path}`);
			}
			const view = all.slice(offset, offset + length);
			const copy = Uint8Array.from(view);
			return {
				size: copy.byteLength,
				type: contentType ?? 'application/octet-stream',
				arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
			} as Blob;
		}
	};
}

describe('git on packed working-tree files', () => {
	it('status, commit, and read survive packProject without packing .git', async () => {
		const vfs = createVfs({
			dbName: `git-pack-${crypto.randomUUID()}`,
			opfs: packedRangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'repo');
		const fs = createVfsGitFs(vfs, { rootId: folder.id });
		await git.init({ fs, dir: '/' });
		const files = await vfs.writeFiles(
			Array.from({ length: 12 }, (_, i) => ({
				parentId: folder.id,
				name: `n-${i}.txt`,
				body: new TextEncoder().encode(`note-${i}\n`)
			}))
		);
		await packProject(vfs, folder.id);
		const packedRef = await vfs.db.blobRefs.get(files[0]!.blobId!);
		expect(packedRef?.packOffset).toBeTypeOf('number');

		const gitDir = (await vfs.list({ parentId: folder.id })).find((n) => n.name === '.git')!;
		const gitKids = await vfs.list({ parentId: gitDir.id });
		const objects = gitKids.find((n) => n.name === 'objects');
		if (objects) {
			const hex = (await vfs.list({ parentId: objects.id })).filter((n) => n.kind === 'folder');
			for (const h of hex) {
				const objs = await vfs.list({ parentId: h.id });
				for (const o of objs) {
					if (!o.blobId) continue;
					const ref = await vfs.db.blobRefs.get(o.blobId);
					expect(ref?.packOffset, `${o.name} under .git must stay standalone`).toBeUndefined();
				}
			}
		}

		expect(await fs.promises.readdir('/')).toEqual(
			expect.arrayContaining(['.git', 'n-0.txt', 'n-3.txt'])
		);
		expect(String(await fs.promises.readFile('/n-3.txt', 'utf8'))).toBe('note-3\n');
		for (let i = 0; i < 12; i++) await git.add({ fs, dir: '/', filepath: `n-${i}.txt` });
		await git.commit({ fs, dir: '/', message: 'packed notes', author: AUTHOR });
		const snap = await localSnapshot(fs, '/');
		expect(snap.log[0]?.subject).toBe('packed notes');

		await fs.promises.writeFile('/n-3.txt', 'edited\n');
		expect((await localSnapshot(fs, '/')).status.dirty).toBe(true);
		await fs.withBuffer(() => git.checkout({ fs, dir: '/', ref: 'HEAD', force: true }));
		expect(String(await fs.promises.readFile('/n-3.txt', 'utf8'))).toBe('note-3\n');
		await fs.promises.rename('/n-1.txt', '/moved.txt');
		expect(String(await fs.promises.readFile('/moved.txt', 'utf8'))).toBe('note-1\n');
		await fs.promises.unlink('/n-2.txt');
		await expect(fs.promises.readFile('/n-2.txt')).rejects.toMatchObject({ code: 'ENOENT' });
		await vfs.db.delete();
	});

	it('pending packed member is EBUSY on write and hidden from stat', async () => {
		const vfs = createVfs({
			dbName: `git-busy-${crypto.randomUUID()}`,
			opfs: packedRangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'repo');
		const fs = createVfsGitFs(vfs, { rootId: folder.id });
		await git.init({ fs, dir: '/' });
		const files = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'n-0.txt', body: new TextEncoder().encode('note-0\n') },
				{ parentId: folder.id, name: 'n-1.txt', body: new TextEncoder().encode('note-1\n') }
			],
			{ pack: true }
		);
		const ref = await vfs.db.blobRefs.get(files[0]!.blobId!);
		await vfs.db.blobRefs.put({ ...ref!, pending: true });
		expect(await vfs.childByName(folder.id, 'n-0.txt')).toBeUndefined();
		await expect(fs.promises.stat('/n-0.txt')).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(fs.promises.writeFile('/n-0.txt', 'x\n')).rejects.toMatchObject({ code: 'EBUSY' });
		await vfs.db.delete();
	});

	it('localSnapshot rethrows a short packed read of a tracked file', async () => {
		const vfs = createVfs({
			dbName: `git-short-${crypto.randomUUID()}`,
			opfs: packedRangeStore(),
			requestPersist: false
		});
		await vfs.ready();
		const folder = await vfs.mkdir(null, 'repo');
		const fs = createVfsGitFs(vfs, { rootId: folder.id });
		await git.init({ fs, dir: '/' });
		const files = await vfs.writeFiles(
			[
				{ parentId: folder.id, name: 'n-0.txt', body: new TextEncoder().encode('note-0\n') },
				{ parentId: folder.id, name: 'n-1.txt', body: new TextEncoder().encode('note-1\n') }
			],
			{ pack: true }
		);
		expect((await fs.promises.readdir('/')).sort()).toEqual(
			expect.arrayContaining(['.git', 'n-0.txt', 'n-1.txt'])
		);
		await git.add({ fs, dir: '/', filepath: 'n-0.txt' });
		await git.add({ fs, dir: '/', filepath: 'n-1.txt' });
		await git.commit({ fs, dir: '/', message: 'packed', author: AUTHOR });
		const ref = await vfs.db.blobRefs.get(files[0]!.blobId!);
		const pack = await vfs.opfs.read(ref!.opfsPath);
		await vfs.opfs.writeFinal(ref!.opfsPath, pack.subarray(0, 1));
		await expect(fs.promises.readFile('/n-0.txt')).rejects.toBeTruthy();
		const node = await vfs.get(files[0]!.id);
		await vfs.db.nodes.put({ ...node!, size: 1, generation: (node!.generation ?? 1) + 1 });
		await expect(localSnapshot(fs, '/')).rejects.toBeTruthy();
		await vfs.db.delete();
	});
});

describe('createGitHost fsForLocal', () => {
	it('snapshots and subscribeLocal via vfs.subscribe without polling', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await commitReadme(fs, 'initial commit');
		const host = createGitHost({
			fsForLocal: (id) => createVfsGitFs(vfs, { rootId: id }),
			subscribeLocal: (_dir, onChange) => vfs.subscribe(onChange)
		});
		const repo = await host.addRepo({ label: 'v', backend: 'local', path: folderId });
		const snap = await host.snapshot(repo.id);
		expect(snap.log[0]?.subject).toBe('initial commit');
		expect(snap.status.dirty).toBe(false);

		const interval = vi.spyOn(globalThis, 'setInterval');
		const snaps: { dirty: boolean }[] = [];
		const unsub = host.subscribe(repo.id, (s) => snaps.push({ dirty: s.status.dirty }));
		await vi.waitFor(() => expect(snaps.length).toBeGreaterThan(0));
		await fs.promises.writeFile('/README.md', 'changed\n');
		await vi.waitFor(() => expect(snaps.some((s) => s.dirty)).toBe(true));
		expect(interval).not.toHaveBeenCalled();
		unsub();
		interval.mockRestore();
	});

	it('readBlobAt returns committed bytes after a dirty worktree edit', async () => {
		const { vfs, folderId, fs } = await makeProject();
		await commitReadme(fs, 'initial commit', 'hello\n');
		const host = createGitHost({
			fsForLocal: (id) => createVfsGitFs(vfs, { rootId: id })
		});
		const repo = await host.addRepo({ label: 'v', backend: 'local', path: folderId });
		const sha = (await host.snapshot(repo.id)).log[0]?.sha;
		expect(sha).toBeTruthy();
		await fs.promises.writeFile('/README.md', 'changed\n');
		const blob = await host.readBlobAt(repo, sha!, 'README.md');
		expect(new TextDecoder().decode(blob)).toBe('hello\n');
		expect(String(await fs.promises.readFile('/README.md', 'utf8'))).toBe('changed\n');
	});
});
