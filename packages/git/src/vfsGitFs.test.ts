import { afterEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
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
});
