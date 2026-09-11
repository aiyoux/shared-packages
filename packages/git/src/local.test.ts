import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { localSnapshot } from './local.js';

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('localSnapshot', () => {
	it('reports a repo with no commits as empty, not broken', async () => {
		const dir = tmpDir('sp-git-empty-');
		await git.init({ fs, dir, defaultBranch: 'main' });
		const snap = await localSnapshot(fs, dir);
		expect(snap.log).toEqual([]);
		expect(snap.status.branch).toBe('main');
	});

	it('throws when the git dir cannot be read, rather than reporting no commits', async () => {
		// A linked worktree's `.git` is a file pointing elsewhere — isomorphic-git
		// cannot follow it, and silently showing "No commits" hides a real repo.
		const dir = tmpDir('sp-git-worktree-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
		await expect(localSnapshot(fs, dir)).rejects.toThrow();
	});

	it('lists commits for a healthy repo', async () => {
		const dir = tmpDir('sp-git-ok-');
		await git.init({ fs, dir, defaultBranch: 'main' });
		fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
		await git.add({ fs, dir, filepath: 'README.md' });
		await git.commit({ fs, dir, message: 'init', author: { name: 'T', email: 't@t.test' } });
		const snap = await localSnapshot(fs, dir);
		expect(snap.log).toHaveLength(1);
		expect(snap.log[0]?.subject).toBe('init');
	});
});

describe('localSnapshot rename detection', () => {
	async function commitFile(dir: string, name: string, content: string) {
		fs.writeFileSync(path.join(dir, name), content);
		await git.add({ fs, dir, filepath: name });
		await git.commit({ fs, dir, message: name, author: { name: 'T', email: 't@t.test' } });
	}

	it('folds an exact-content move into one renamed entry', async () => {
		const dir = tmpDir('sp-git-rename-');
		await git.init({ fs, dir, defaultBranch: 'main' });
		await commitFile(dir, 'old.txt', 'hello\n');

		fs.renameSync(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));

		const snap = await localSnapshot(fs, dir);
		expect(snap.changes).toEqual([{ path: 'new.txt', status: 'renamed', renamedFrom: 'old.txt' }]);
	});

	it('leaves a moved-and-edited file as an ordinary add + delete pair', async () => {
		const dir = tmpDir('sp-git-rename-edit-');
		await git.init({ fs, dir, defaultBranch: 'main' });
		await commitFile(dir, 'old.txt', 'hello\n');

		fs.unlinkSync(path.join(dir, 'old.txt'));
		fs.writeFileSync(path.join(dir, 'new.txt'), 'hello, edited\n');

		const snap = await localSnapshot(fs, dir);
		expect(snap.changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual([
			'added:new.txt',
			'deleted:old.txt'
		]);
	});

	it('leaves an ambiguous duplicate-content move unpaired', async () => {
		const dir = tmpDir('sp-git-rename-ambiguous-');
		await git.init({ fs, dir, defaultBranch: 'main' });
		await commitFile(dir, 'a.txt', 'same\n');
		await commitFile(dir, 'b.txt', 'same\n');

		fs.unlinkSync(path.join(dir, 'a.txt'));
		fs.unlinkSync(path.join(dir, 'b.txt'));
		fs.writeFileSync(path.join(dir, 'c.txt'), 'same\n');

		const snap = await localSnapshot(fs, dir);
		// c.txt could be a.txt OR b.txt renamed — neither guess is safe, so
		// both deletions and the addition stay as their honest, separate selves.
		expect(snap.changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual([
			'added:c.txt',
			'deleted:a.txt',
			'deleted:b.txt'
		]);
	});
});
