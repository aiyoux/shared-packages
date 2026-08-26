import { describe, expect, it } from 'vitest';
import {
	bindProjectRepo,
	repoInputFromFolder,
	resolveProjectRoot,
	sameProjectRepo
} from './projectRepo.js';
import type { ExplorerDriver, ExplorerEntry } from '@shared-packages/file-system/ui/driver';
import type { GitHost, GitRepoRef } from './types.js';

function folder(id: string, name: string, parentId: string | null = null): ExplorerEntry {
	return { id, kind: 'folder', name, parentId };
}

function driverWith(opts: {
	children: Record<string, ExplorerEntry[]>;
	path?: Record<string, ExplorerEntry[]>;
}): ExplorerDriver {
	return {
		id: 'test',
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: false,
			supportsDownload: false,
			supportsSiblingOrder: false
		},
		async ready() {},
		async list({ parentId }) {
			const key = parentId ?? '';
			return { entries: opts.children[key] ?? [], truncated: false };
		},
		async getPath(id) {
			return opts.path?.[id] ?? [];
		},
		async delete() {}
	} as ExplorerDriver;
}

describe('repoInputFromFolder', () => {
	it('returns the clicked folder when it has a .git child', async () => {
		const repo = folder('repo-1', 'myrepo');
		const git = folder('git-1', '.git', 'repo-1');
		const d = driverWith({
			children: { 'repo-1': [git] },
			path: { 'repo-1': [repo] }
		});
		const input = await repoInputFromFolder(d, 'repo-1', { backend: 'local' });
		expect(input).toEqual({ label: 'myrepo', backend: 'local', path: 'repo-1' });
	});

	it('walks up to the ancestor that has .git', async () => {
		const repo = folder('repo-1', 'myrepo');
		const src = folder('src-1', 'src', 'repo-1');
		const git = folder('git-1', '.git', 'repo-1');
		const d = driverWith({
			children: {
				'src-1': [],
				'repo-1': [git, src]
			},
			path: {
				'src-1': [repo, src],
				'repo-1': [repo]
			}
		});
		const input = await repoInputFromFolder(d, 'src-1', { backend: 'local' });
		expect(input?.path).toBe('repo-1');
		expect(input?.label).toBe('myrepo');
	});

	it('returns null when no .git exists on the folder or ancestors', async () => {
		const d = driverWith({
			children: { 'plain-1': [folder('a', 'notes', 'plain-1')] },
			path: { 'plain-1': [folder('plain-1', 'plain')] }
		});
		expect(await repoInputFromFolder(d, 'plain-1', { backend: 'local' })).toBeNull();
	});
});

describe('resolveProjectRoot', () => {
	it('reports the explorer id the working tree was found at', async () => {
		const repo = folder('repo-1', 'myrepo');
		const src = folder('src-1', 'src', 'repo-1');
		const dotGit = folder('git-1', '.git', 'repo-1');
		const d = driverWith({
			children: { 'src-1': [], 'repo-1': [dotGit, src] },
			path: { 'src-1': [repo, src], 'repo-1': [repo] }
		});
		const hit = await resolveProjectRoot(d, 'src-1', { backend: 'local' });
		// Clicking `src` roots Projects at `repo-1`, not at `src`.
		expect(hit?.folderId).toBe('repo-1');
		expect(hit?.input.path).toBe('repo-1');
	});

	it('keeps the monitor root path on the ref so later clicks stay absolute', async () => {
		const repo = folder('myrepo/', 'myrepo');
		const dotGit = folder('myrepo/.git', '.git', 'myrepo/');
		const d = driverWith({
			children: { 'myrepo/': [dotGit] },
			path: { 'myrepo/': [repo] }
		});
		const hit = await resolveProjectRoot(d, 'myrepo/', {
			backend: 'monitor',
			rootPath: '/home/me/code',
			profileId: 'p1',
			baseUrl: 'http://127.0.0.1:8300'
		});
		expect(hit?.input).toMatchObject({
			backend: 'monitor',
			path: '/home/me/code/myrepo',
			rootPath: '/home/me/code',
			profileId: 'p1'
		});
		expect(hit?.folderId).toBe('myrepo/');
	});

	it('is null when neither the folder nor an ancestor is a working tree', async () => {
		const d = driverWith({
			children: { 'plain-1': [folder('a', 'notes', 'plain-1')] },
			path: { 'plain-1': [folder('plain-1', 'plain')] }
		});
		expect(await resolveProjectRoot(d, 'plain-1', { backend: 'local' })).toBeNull();
	});
});

describe('bindProjectRepo', () => {
	it('reuses a saved ref with the same backend and path', async () => {
		const saved: GitRepoRef = { id: 'r1', label: 'old', backend: 'local', path: 'repo-1' };
		const host = {
			async listRepos() {
				return [saved];
			},
			async addRepo() {
				throw new Error('should not add');
			}
		} as unknown as GitHost;
		const bound = await bindProjectRepo(host, { label: 'myrepo', backend: 'local', path: 'repo-1' });
		expect(bound.id).toBe('r1');
	});
});

describe('sameProjectRepo', () => {
	it('matches local by path', () => {
		expect(
			sameProjectRepo(
				{ backend: 'local', path: 'a' },
				{ backend: 'local', path: 'a' }
			)
		).toBe(true);
		expect(
			sameProjectRepo(
				{ backend: 'local', path: 'a' },
				{ backend: 'local', path: 'b' }
			)
		).toBe(false);
	});
});
