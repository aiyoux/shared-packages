// @vitest-environment node
import { describe, expect, it } from 'vitest';
import git from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
import { localCommit, localDiffFile, localSnapshot } from './local.js';
import { applySelection } from './diffLines.js';
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

	it('diffs a modified file: HEAD text vs the working file', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/m.txt', 'one\ntwo\nthree\n');
		await localCommit(fs, '/', { message: 'first', paths: ['m.txt'], author: AUTHOR });
		await fs.promises.writeFile('/m.txt', 'one\nTWO\nthree\nfour\n');

		const d = await localDiffFile(fs, '/', 'm.txt');
		expect(d.oldText).toBe('one\ntwo\nthree\n');
		expect(d.newText).toBe('one\nTWO\nthree\nfour\n');
		expect(d.diff.kind).toBe('text');
	});

	it('diffs an added file against empty HEAD text', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/a.txt', 'hello\n');
		const d = await localDiffFile(fs, '/', 'a.txt');
		expect(d.oldText).toBe('');
		expect(d.newText).toBe('hello\n');
	});

	it('commits a partial-stage override in place of the working file, leaving the rest pending', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/m.txt', 'keep1\ngone\nkeep2\n');
		await localCommit(fs, '/', { message: 'first', paths: ['m.txt'], author: AUTHOR });
		await fs.promises.writeFile('/m.txt', 'keep1\nkeep2\nadded\n');

		const d = await localDiffFile(fs, '/', 'm.txt');
		if (d.diff.kind !== 'text') throw new Error('expected text');
		const addedLine = d.diff.hunks
			.flatMap((h) => h.lines)
			.find((l) => l.kind === 'add' && l.text === 'added')!;
		// Stage only the deletion of "gone" — leave "added" out of this commit.
		const partialContent = applySelection(d.oldText, d.newText, new Set([addedLine.opIndex]));
		expect(partialContent).toBe('keep1\nkeep2\n');

		const sha = await localCommit(fs, '/', {
			message: 'drop gone only',
			paths: ['m.txt'],
			author: AUTHOR,
			partial: { 'm.txt': new TextEncoder().encode(partialContent) }
		});
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		// The committed blob is the partial content...
		const head = await localDiffFile(fs, '/', 'm.txt');
		expect(head.oldText).toBe('keep1\nkeep2\n');
		// ...but the working file still has "added" — a partial commit is not a
		// silent full commit, and the file correctly still shows as changed.
		expect(head.newText).toBe('keep1\nkeep2\nadded\n');
		const after = await localSnapshot(fs, '/');
		expect(after.changes).toEqual([{ path: 'm.txt', status: 'modified' }]);
	});

	it('diffs a deleted file against empty working text', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/gone.txt', 'one\ntwo\n');
		await localCommit(fs, '/', { message: 'first', paths: ['gone.txt'], author: AUTHOR });
		await fs.promises.unlink('/gone.txt');

		const d = await localDiffFile(fs, '/', 'gone.txt');
		expect(d.oldText).toBe('one\ntwo\n');
		expect(d.newText).toBe('');
	});

	it('partially stages a deletion: keeping a deselected line commits a modify, not a remove', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/gone.txt', 'keep\ndrop\n');
		await localCommit(fs, '/', { message: 'first', paths: ['gone.txt'], author: AUTHOR });
		await fs.promises.unlink('/gone.txt');

		const d = await localDiffFile(fs, '/', 'gone.txt');
		if (d.diff.kind !== 'text') throw new Error('expected text');
		const keepLine = d.diff.hunks.flatMap((h) => h.lines).find((l) => l.text === 'keep')!;
		// Deselect "keep"'s removal — the file should end up with just "keep".
		const partialContent = applySelection(d.oldText, d.newText, new Set([keepLine.opIndex]));
		expect(partialContent).toBe('keep\n');

		await localCommit(fs, '/', {
			message: 'drop only "drop"',
			paths: ['gone.txt'],
			author: AUTHOR,
			partial: { 'gone.txt': new TextEncoder().encode(partialContent) }
		});

		// The path is still tracked (a modify, via updateIndex), not removed —
		// git.remove was never called for this path.
		const head = await localDiffFile(fs, '/', 'gone.txt');
		expect(head.oldText).toBe('keep\n');
		// The working file is still absent from disk (never touched)...
		const clean = await localSnapshot(fs, '/');
		// ...so it shows as deleted relative to the newly-committed "keep\n" too.
		expect(clean.changes).toEqual([{ path: 'gone.txt', status: 'deleted' }]);
	});
});
