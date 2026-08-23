import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { createGitHost } from './host.js';
import { closeGitReposDbForTests } from './repos.js';
import { consumeOpenProject, OPEN_PROJECT_KEY, OPEN_PROJECT_TTL_MS } from './openProject.js';

async function makeRepo(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-git-'));
	await git.init({ fs, dir });
	await fs.promises.writeFile(path.join(dir, 'README.md'), 'hello\n');
	await git.add({ fs, dir, filepath: 'README.md' });
	await git.commit({
		fs,
		dir,
		message: 'initial commit',
		author: { name: 'Test', email: 't@t.test' }
	});
	return dir;
}

afterEach(async () => {
	await closeGitReposDbForTests();
});

describe('createGitHost local backend', () => {
	it('snapshots branch, log, and dirty against a tiny repo', async () => {
		const dir = await makeRepo();
		const host = createGitHost({ fs });
		const repo = await host.addRepo({ label: 'tiny', backend: 'local', path: dir });
		const listed = await host.listRepos();
		expect(listed.some((r) => r.id === repo.id)).toBe(true);

		const snap = await host.snapshot(repo.id);
		expect(typeof snap.status.branch === 'string' || snap.status.branch === null).toBe(true);
		expect(snap.status.dirty).toBe(false);
		expect(snap.log[0]?.subject).toBe('initial commit');
		expect(snap.log[0]?.sha.length).toBeGreaterThan(7);
		expect(snap.log[0]?.author).toBe('Test');

		await fs.promises.writeFile(path.join(dir, 'README.md'), 'hello world\n');
		const dirty = await host.snapshot(repo.id);
		expect(dirty.status.dirty).toBe(true);
	});
});

describe('consumeOpenProject', () => {
	it('reads once and respects TTL', () => {
		const store = new Map<string, string>();
		const storage = {
			getItem: (k: string) => store.get(k) ?? null,
			removeItem: (k: string) => {
				store.delete(k);
			},
			setItem: (k: string, v: string) => {
				store.set(k, v);
			}
		};
		storage.setItem(
			OPEN_PROJECT_KEY,
			JSON.stringify({ backend: 'monitor', path: '/tmp/p', ts: 1_000 })
		);
		expect(consumeOpenProject(storage, 1_000 + OPEN_PROJECT_TTL_MS + 1)).toBeNull();
		expect(store.has(OPEN_PROJECT_KEY)).toBe(false);

		storage.setItem(
			OPEN_PROJECT_KEY,
			JSON.stringify({ backend: 'local', path: '/tmp/p', profileId: 'p1', ts: 5_000 })
		);
		const got = consumeOpenProject(storage, 5_000 + 1_000);
		expect(got).toEqual({ backend: 'local', path: '/tmp/p', profileId: 'p1', ts: 5_000 });
		expect(consumeOpenProject(storage, 5_000 + 1_000)).toBeNull();
	});
});
