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
