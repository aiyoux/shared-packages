// @vitest-environment node
import { describe, expect, it } from 'vitest';
import git from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
import { localCommit, localDiffFile, localDiscardAllFile, localWriteWorkingFile } from './local.js';
import { applySelection } from './diffLines.js';
import { createVfsGitFs } from './vfsGitFs.js';

const AUTHOR = { name: 'Tester', email: 't@t.test' };

async function repo() {
	const vfs: VfsService = createVfs({
		dbName: `discard-${crypto.randomUUID()}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'r');
	const fs = createVfsGitFs(vfs, { rootId: folder.id });
	await git.init({ fs, dir: '/' });
	return { vfs, fs };
}

describe('localDiscardAllFile', () => {
	it('restores a modified file to its HEAD bytes', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/m.txt', 'one\ntwo\n');
		await localCommit(fs, '/', { message: 'first', paths: ['m.txt'], author: AUTHOR });
		await fs.promises.writeFile('/m.txt', 'one\nTWO\nthree\n');

		await localDiscardAllFile(fs, '/', 'm.txt');

		const d = await localDiffFile(fs, '/', 'm.txt');
		expect(d.newText).toBe('one\ntwo\n');
		expect(d.diff).toEqual({ kind: 'unchanged' });
	});

	it('removes an added (never-committed) file entirely', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/new.txt', 'hello\n');

		await localDiscardAllFile(fs, '/', 'new.txt');

		const d = await localDiffFile(fs, '/', 'new.txt');
		expect(d.oldText).toBe('');
		expect(d.newText).toBe('');
		await expect(
			(fs as unknown as { promises: { lstat(p: string): Promise<unknown> } }).promises.lstat(
				'/new.txt'
			)
		).rejects.toThrow();
	});
});

describe('localWriteWorkingFile (per-hunk discard)', () => {
	it('reverts just the discarded lines, keeping the rest of the uncommitted edit', async () => {
		const { fs } = await repo();
		await fs.promises.writeFile('/m.txt', 'a\nb\nc\n');
		await localCommit(fs, '/', { message: 'first', paths: ['m.txt'], author: AUTHOR });
		await fs.promises.writeFile('/m.txt', 'a\nB\nc\nd\n');

		const before = await localDiffFile(fs, '/', 'm.txt');
		if (before.diff.kind !== 'text') throw new Error('expected text');
		const addD = before.diff.hunks.flatMap((h) => h.lines).find((l) => l.text === 'd')!;
		// Discard only the "d" addition — "B" stays uncommitted-changed.
		const kept = applySelection(before.oldText, before.newText, new Set([addD.opIndex]));
		expect(kept).toBe('a\nB\nc\n');

		await localWriteWorkingFile(fs, '/', 'm.txt', new TextEncoder().encode(kept));

		const after = await localDiffFile(fs, '/', 'm.txt');
		expect(after.newText).toBe('a\nB\nc\n');
	});
});
