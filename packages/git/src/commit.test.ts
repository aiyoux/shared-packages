// @vitest-environment node
import { describe, expect, it } from 'vitest';
import git from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
import { localCommit, localSnapshot } from './local.js';
import { createVfsGitFs } from './vfsGitFs.js';

const AUTHOR = { name: 'Tester', email: 't@t.test' };

async function repo() {
	const vfs: VfsService = createVfs({
		dbName: `commit-${crypto.randomUUID()}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'r');
	const fs = createVfsGitFs(vfs, { rootId: folder.id });
	await git.init({ fs, dir: '/' });
	return { vfs, fs };
}

describe('localCommit', () => {
	it('coalesces VFS notifies across a localCommit', async () => {
		const { vfs, fs } = await repo();
		await fs.promises.writeFile('/a.txt', 'A');
		let n = 0;
		const unsub = vfs.subscribe(() => {
			n += 1;
		});
		await localCommit(fs, '/', { message: 'a', paths: ['a.txt'], author: AUTHOR });
		unsub();
		expect(n).toBe(1);
		expect((await localSnapshot(fs, '/')).log[0]?.subject).toBe('a');
	});

	it('reports added files as changes, then commits only what is selected', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/a.txt', 'A');
		await fs.promises.writeFile('/b.txt', 'B');

		const before = await localSnapshot(fs, '/');
		expect(before.status.dirty).toBe(true);
		expect(before.changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual([
			'added:a.txt',
			'added:b.txt'
		]);

		const sha = await localCommit(fs, '/', { message: 'just a', paths: ['a.txt'], author: AUTHOR });
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		const after = await localSnapshot(fs, '/');
		expect(after.log[0]?.subject).toBe('just a');
		// b.txt was not selected, so it must still be pending — a commit that
		// quietly swept up unticked files would be the worst kind of bug here.
		expect(after.changes.map((c) => c.path)).toEqual(['b.txt']);
	});

	it('commits a deletion via git.remove, not git.add', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/gone.txt', 'x');
		await localCommit(fs, '/', { message: 'add', paths: ['gone.txt'], author: AUTHOR });

		await fs.promises.unlink('/gone.txt');
		const dirty = await localSnapshot(fs, '/');
		expect(dirty.changes).toEqual([{ path: 'gone.txt', status: 'deleted' }]);

		// git.add on a missing path throws; without the remove branch the whole
		// commit fails with ENOENT.
		await localCommit(fs, '/', { message: 'rm', paths: ['gone.txt'], author: AUTHOR });
		const clean = await localSnapshot(fs, '/');
		expect(clean.changes).toEqual([]);
		expect(clean.status.dirty).toBe(false);
		expect(clean.log[0]?.subject).toBe('rm');
	});

	it('reports a modification and refuses an empty message or empty selection', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/m.txt', 'one');
		await localCommit(fs, '/', { message: 'first', paths: ['m.txt'], author: AUTHOR });
		await fs.promises.writeFile('/m.txt', 'two');

		const snap = await localSnapshot(fs, '/');
		expect(snap.changes).toEqual([{ path: 'm.txt', status: 'modified' }]);

		await expect(
			localCommit(fs, '/', { message: '   ', paths: ['m.txt'], author: AUTHOR })
		).rejects.toThrow(/message/i);
		await expect(
			localCommit(fs, '/', { message: 'ok', paths: [], author: AUTHOR })
		).rejects.toThrow(/at least one/i);
	});
});
