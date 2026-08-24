import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { abortAllGitStreams } from '@shared-packages/file-system/monitor';
import { createGitHost } from './host.js';
import { closeGitReposDbForTests } from './repos.js';
import { consumeOpenProject, OPEN_PROJECT_KEY, OPEN_PROJECT_TTL_MS } from './openProject.js';
import type { GitRepoRef, GitSnapshot } from './types.js';

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
	abortAllGitStreams();
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

	it('readBlobAt returns committed bytes, not dirty worktree', async () => {
		const dir = await makeRepo();
		const host = createGitHost({ fs });
		const repo = await host.addRepo({ label: 'tiny', backend: 'local', path: dir });
		const sha = (await host.snapshot(repo.id)).log[0]?.sha;
		expect(sha).toBeTruthy();
		await fs.promises.writeFile(path.join(dir, 'README.md'), 'hello world\n');
		const blob = await host.readBlobAt(repo, sha!, 'README.md');
		expect(new TextDecoder().decode(blob)).toBe('hello\n');
		expect(new TextDecoder().decode(await host.readBlobAt(repo, 'HEAD', 'README.md'))).toBe(
			'hello\n'
		);
		expect(new TextDecoder().decode(await host.readBlobAt(repo, sha!.slice(0, 7), 'README.md'))).toBe(
			'hello\n'
		);
		expect(await fs.promises.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('hello world\n');
	});

	it('subscribeLocal re-snapshots after a working-tree change', async () => {
		const dir = await makeRepo();
		let notify: (() => void) | null = null;
		const host = createGitHost({
			fs,
			subscribeLocal: (_d, onChange) => {
				notify = onChange;
				return () => {
					notify = null;
				};
			}
		});
		const repo: GitRepoRef = { id: 'local-live', label: 'tiny', backend: 'local', path: dir };
		const snaps: GitSnapshot[] = [];
		const unsub = host.subscribeRepo(repo, (s) => snaps.push(s));
		await vi.waitFor(() => expect(snaps.length).toBe(1));
		expect(snaps[0]?.status.dirty).toBe(false);

		await fs.promises.writeFile(path.join(dir, 'README.md'), 'hello world\n');
		expect(notify).toBeTypeOf('function');
		notify!();
		await vi.waitFor(() => expect(snaps.length).toBe(2));
		expect(snaps[1]?.status.dirty).toBe(true);
		unsub();
	});
});

const MONITOR_GIT_JSON = {
	feature: 'git',
	branch: 'main',
	dirty: false,
	log: [
		{
			sha: 'abc123456789',
			subject: 'hello',
			author: 't',
			committed_at: '2026-01-01T00:00:00Z'
		}
	]
};

function fakeMonitorFetch(): typeof fetch {
	const encoder = new TextEncoder();
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes('/v1/git/snapshot')) {
			return new Response(JSON.stringify(MONITOR_GIT_JSON), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/git/events')) {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						encoder.encode(`event: git.snapshot\ndata: ${JSON.stringify(MONITOR_GIT_JSON)}\n\n`)
					);
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		return new Response('Not found', { status: 404 });
	}) as unknown as typeof fetch;
}

describe('createGitHost monitor backend', () => {
	const repo: GitRepoRef = {
		id: 'mon-1',
		label: 'proj',
		backend: 'monitor',
		path: '/tmp/p',
		baseUrl: 'http://127.0.0.1:8300'
	};

	it('readBlobAt throws until monitor transport is wired', async () => {
		const host = createGitHost({ fetchImpl: fakeMonitorFetch() });
		await expect(host.readBlobAt(repo, 'abc123456789', 'README.md')).rejects.toThrow(
			/Monitor git blob is not wired on this host yet/
		);
	});

	it('snapshotRepo maps a fake /v1/git/snapshot without a live daemon', async () => {
		const host = createGitHost({ fetchImpl: fakeMonitorFetch() });
		const snap = await host.snapshotRepo(repo);
		expect(snap.status).toEqual({ branch: 'main', dirty: false });
		expect(snap.log[0]).toEqual({
			sha: 'abc123456789',
			subject: 'hello',
			author: 't',
			committedAt: '2026-01-01T00:00:00Z'
		});
	});

	it('subscribeRepo emits the mapped snapshot from a fake fetchImpl', async () => {
		const host = createGitHost({ fetchImpl: fakeMonitorFetch() });
		const snaps: GitSnapshot[] = [];
		const unsub = host.subscribeRepo(repo, (s) => snaps.push(s));
		await vi.waitFor(() => expect(snaps.length).toBeGreaterThan(0));
		expect(snaps[0]?.status.branch).toBe('main');
		expect(snaps[0]?.log[0]?.subject).toBe('hello');
		expect(snaps[0]?.log[0]?.committedAt).toBe('2026-01-01T00:00:00Z');
		unsub();
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
			JSON.stringify({
				backend: 'local',
				path: '/tmp/p',
				folderId: 'fld-1',
				profileId: 'p1',
				ts: 5_000
			})
		);
		const got = consumeOpenProject(storage, 5_000 + 1_000);
		expect(got).toEqual({
			backend: 'local',
			path: '/tmp/p',
			folderId: 'fld-1',
			profileId: 'p1',
			ts: 5_000
		});
		expect(consumeOpenProject(storage, 5_000 + 1_000)).toBeNull();
	});

	it('round-trips optional label', () => {
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
			JSON.stringify({
				backend: 'local',
				path: 'fld_uuid',
				label: 'My Project',
				folderId: 'fld_uuid',
				ts: 5_000
			})
		);
		expect(consumeOpenProject(storage, 5_000 + 1_000)).toEqual({
			backend: 'local',
			path: 'fld_uuid',
			label: 'My Project',
			folderId: 'fld_uuid',
			ts: 5_000
		});
		expect(store.has(OPEN_PROJECT_KEY)).toBe(false);
	});
});
