// @vitest-environment node
import { describe, expect, it } from 'vitest';
import git, { Errors } from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
import {
	ROOM_BRANCH_PREFIX,
	localBranch,
	localCommit,
	localFetch,
	localFindMergeBase,
	localMerge,
	localPackObjects,
	roomBranchName,
	type HttpClient,
	type MergeDriverCallback
} from './local.js';
import { createVfsGitFs } from './vfsGitFs.js';

const AUTHOR = {
	name: 'Tester',
	email: 't@t.test',
	timestamp: 1_700_000_000,
	timezoneOffset: 0
};

async function repo(tag = 'verbs') {
	const vfs: VfsService = createVfs({
		dbName: `${tag}-${crypto.randomUUID()}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	const folder = await vfs.mkdir(null, 'r');
	const fs = createVfsGitFs(vfs, { rootId: folder.id });
	await git.init({ fs, dir: '/', defaultBranch: 'main' });
	return { vfs, fs };
}

async function seed(fs: ReturnType<typeof createVfsGitFs>, content = 'base\n') {
	await fs.promises.writeFile('/a.txt', content);
	return localCommit(fs, '/', { message: 'base', paths: ['a.txt'], author: AUTHOR });
}

describe('GitAuthor determinism', () => {
	it('passes timestamp and committer through; identical metadata yields the same hash', async () => {
		const a = await repo('det-a');
		const b = await repo('det-b');
		const shaA = await seed(a.fs);
		const shaB = await seed(b.fs);
		expect(shaA).toBe(shaB);

		const { commit } = await git.readCommit({ fs: a.fs, dir: '/', oid: shaA });
		expect(commit.author).toMatchObject({
			name: AUTHOR.name,
			email: AUTHOR.email,
			timestamp: AUTHOR.timestamp,
			timezoneOffset: AUTHOR.timezoneOffset
		});
		expect(commit.committer).toMatchObject({
			name: AUTHOR.name,
			email: AUTHOR.email,
			timestamp: AUTHOR.timestamp,
			timezoneOffset: AUTHOR.timezoneOffset
		});
	});

	it('defaults committer to author, including timestamp', async () => {
		const { fs } = await repo('det-committer');
		await fs.promises.writeFile('/a.txt', 'x\n');
		const sha = await localCommit(fs, '/', {
			message: 'only author',
			paths: ['a.txt'],
			author: AUTHOR
		});
		const { commit } = await git.readCommit({ fs, dir: '/', oid: sha });
		expect(commit.committer.timestamp).toBe(AUTHOR.timestamp);
		expect(commit.committer.timezoneOffset).toBe(AUTHOR.timezoneOffset);
	});

	it('changes the hash when committer timestamp differs', async () => {
		const a = await repo('det-diff-a');
		const b = await repo('det-diff-b');
		await a.fs.promises.writeFile('/a.txt', 'same\n');
		await b.fs.promises.writeFile('/a.txt', 'same\n');
		const shaA = await localCommit(a.fs, '/', {
			message: 'c',
			paths: ['a.txt'],
			author: AUTHOR,
			committer: AUTHOR
		});
		const shaB = await localCommit(b.fs, '/', {
			message: 'c',
			paths: ['a.txt'],
			author: AUTHOR,
			committer: { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 }
		});
		expect(shaA).not.toBe(shaB);
	});
});

describe('localBranch room refs', () => {
	it('creates refs/heads/room/<id> (ROOM_BRANCH_PREFIX) without checking it out', async () => {
		const { fs } = await repo('branch');
		const head = await seed(fs);
		const ref = roomBranchName('abc');
		expect(ref).toBe(`${ROOM_BRANCH_PREFIX}abc`);

		await localBranch(fs, '/', { ref });
		const listed = await git.listBranches({ fs, dir: '/' });
		expect(listed).toContain('room/abc');
		expect(listed).toContain('main');
		expect(await git.resolveRef({ fs, dir: '/', ref: `refs/heads/${ref}` })).toBe(head);
		expect(await git.currentBranch({ fs, dir: '/', fullname: false })).toBe('main');
	});

	it('checks out the room branch when asked', async () => {
		const { fs } = await repo('branch-co');
		await seed(fs);
		await localBranch(fs, '/', { ref: roomBranchName('r1'), checkout: true });
		expect(await git.currentBranch({ fs, dir: '/', fullname: false })).toBe('room/r1');
	});

	it('refuses an empty branch name and an empty room id', async () => {
		const { fs } = await repo('branch-err');
		await seed(fs);
		await expect(localBranch(fs, '/', { ref: '  ' })).rejects.toThrow(/branch name/i);
		expect(() => roomBranchName('')).toThrow(/room id/i);
	});
});

describe('localMerge mergeDriver', () => {
	it('throws MergeConflictError when the driver returns cleanMerge: false and leaves HEAD', async () => {
		const { fs } = await repo('merge-false');
		const base = await seed(fs);
		await localBranch(fs, '/', { ref: roomBranchName('r1') });
		await localBranch(fs, '/', { ref: roomBranchName('r2') });

		await git.checkout({ fs, dir: '/', ref: roomBranchName('r1') });
		await fs.promises.writeFile('/a.txt', 'ours\n');
		await localCommit(fs, '/', { message: 'ours', paths: ['a.txt'], author: AUTHOR });

		await git.checkout({ fs, dir: '/', ref: roomBranchName('r2') });
		await fs.promises.writeFile('/a.txt', 'theirs\n');
		await localCommit(fs, '/', { message: 'theirs', paths: ['a.txt'], author: AUTHOR });
		const headBefore = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' });

		const seen: Array<{ path: string; contents: string[] }> = [];
		const mergeDriver: MergeDriverCallback = (args) => {
			seen.push({ path: args.path, contents: args.contents });
			return { cleanMerge: false, mergedText: args.contents[1] ?? '' };
		};

		await expect(
			localMerge(fs, '/', { theirs: roomBranchName('r1'), author: AUTHOR, mergeDriver })
		).rejects.toSatisfy((e: unknown) => e instanceof Errors.MergeConflictError);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.path).toBe('a.txt');
		expect(seen[0]?.contents).toHaveLength(3);
		expect(seen[0]?.contents[0]).toBe('base\n');
		expect(await git.resolveRef({ fs, dir: '/', ref: 'HEAD' })).toBe(headBefore);
		expect(await git.resolveRef({ fs, dir: '/', ref: `refs/heads/${roomBranchName('r2')}` })).toBe(
			headBefore
		);
		expect(await localFindMergeBase(fs, '/', [
			await git.resolveRef({ fs, dir: '/', ref: `refs/heads/${roomBranchName('r1')}` }),
			headBefore
		])).toEqual([base]);
	});

	it('records a merge commit when the driver returns cleanMerge: true', async () => {
		const { fs } = await repo('merge-true');
		await seed(fs);
		await localBranch(fs, '/', { ref: roomBranchName('r1') });
		await localBranch(fs, '/', { ref: roomBranchName('r2') });

		await git.checkout({ fs, dir: '/', ref: roomBranchName('r1') });
		await fs.promises.writeFile('/a.txt', 'ours\n');
		await localCommit(fs, '/', { message: 'ours', paths: ['a.txt'], author: AUTHOR });

		await git.checkout({ fs, dir: '/', ref: roomBranchName('r2') });
		await fs.promises.writeFile('/a.txt', 'theirs\n');
		await localCommit(fs, '/', { message: 'theirs', paths: ['a.txt'], author: AUTHOR });

		const result = await localMerge(fs, '/', {
			theirs: roomBranchName('r1'),
			author: AUTHOR,
			mergeDriver: ({ contents }) => ({
				cleanMerge: true,
				mergedText: `${contents[1] ?? ''}${contents[2] ?? ''}`
			})
		});
		expect(result.mergeCommit || result.fastForward).toBeTruthy();
		expect(result.oid).toMatch(/^[0-9a-f]{40}$/);
		const blob = await git.readBlob({ fs, dir: '/', oid: result.oid!, filepath: 'a.txt' });
		expect(new TextDecoder().decode(blob.blob)).toBe('theirs\nours\n');
		const work = await fs.promises.readFile('/a.txt');
		const workBytes = work instanceof Uint8Array ? work : new Uint8Array(work as ArrayBuffer);
		expect(new TextDecoder().decode(workBytes)).toBe('theirs\nours\n');
	});

	it('refuses an empty theirs ref', async () => {
		const { fs } = await repo('merge-empty');
		await seed(fs);
		await expect(localMerge(fs, '/', { theirs: ' ', author: AUTHOR })).rejects.toThrow(/theirs/i);
	});
});

describe('localFindMergeBase / pack / fetch', () => {
	it('refuses an empty oid list', async () => {
		const { fs } = await repo('base-empty');
		await seed(fs);
		await expect(localFindMergeBase(fs, '/', [])).rejects.toThrow(/at least one/i);
	});

	it('packs objects and refuses an empty oid list', async () => {
		const { fs } = await repo('pack');
		const oid = await seed(fs);
		const packed = await localPackObjects(fs, '/', { oids: [oid] });
		expect(packed.filename).toMatch(/pack-.*\.pack/);
		expect(packed.packfile?.byteLength).toBeGreaterThan(0);
		await expect(localPackObjects(fs, '/', { oids: [] })).rejects.toThrow(/at least one/i);
	});

	it('fetch requires http and a url or remote, and surfaces HTTP errors', async () => {
		const { fs } = await repo('fetch');
		await seed(fs);
		const http: HttpClient = {
			async request({ url }) {
				return {
					url,
					method: 'GET',
					statusCode: 404,
					statusMessage: 'Not Found',
					headers: {},
					body: (async function* () {})()
				};
			}
		};
		await expect(localFetch(fs, '/', { http })).rejects.toThrow(/url or remote/i);
		await expect(
			localFetch(fs, '/', { http, url: 'https://example.test/repo.git' })
		).rejects.toThrow();
	});
});
