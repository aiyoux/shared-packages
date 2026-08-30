import { describe, expect, it } from 'vitest';
import git from 'isomorphic-git';
import { createVfs, type VfsService } from '@shared-packages/file-system';
import { createVfsGitFs } from './vfsGitFs.js';

const AUTHOR = { name: 'T', email: 't@t.test' };

/** Wrap a VfsService, counting calls and how many entries `list` returns. */
function counted(vfs: VfsService) {
	const calls: Record<string, number> = {};
	let entriesScanned = 0;
	const proxy = new Proxy(vfs, {
		get(target, prop: string) {
			const v = (target as never)[prop];
			if (typeof v !== 'function') return v;
			return async (...args: unknown[]) => {
				calls[prop] = (calls[prop] ?? 0) + 1;
				const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				if (prop === 'list' && Array.isArray(r)) entriesScanned += r.length;
				return r;
			};
		}
	}) as VfsService;
	return { proxy, calls, entriesScanned: () => entriesScanned };
}

async function commitFiles(vfs: VfsService, n: number) {
	const folder = await vfs.mkdir(null, `repo-${n}`);
	const { proxy, entriesScanned } = counted(vfs);
	const fs = createVfsGitFs(proxy, { rootId: folder.id });
	await git.init({ fs, dir: '/' });
	for (let i = 0; i < n; i++) {
		await fs.promises.writeFile(`/f${i}.txt`, `content ${i}\n`);
		await git.add({ fs, dir: '/', filepath: `f${i}.txt` });
	}
	await git.commit({ fs, dir: '/', message: 'bulk', author: AUTHOR });
	return entriesScanned();
}

describe('vfsGitFs path resolution cost', () => {
	it('does not scan directory listings, and does not grow with repo size', async () => {
		const vfs = createVfs({
			dbName: `gitperf-${crypto.randomUUID()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();

		const small = await commitFiles(vfs, 20);
		const large = await commitFiles(vfs, 60);

		// walk() used to list each path segment's folder and scan for the name.
		// Because git resolves a path per stat/read/write, and .git/objects
		// grows as objects accumulate, total entries scanned was O(N^2):
		// measured 41,123 entries to commit 60 files, and per-file scanning
		// grew 427 -> 681 -> 1182 as N went 30 -> 60 -> 120.
		//
		// childByName() answers the same question with one [parentKey+name]
		// index hit, so nothing is scanned at all. Asserting zero (rather than
		// "smaller") is what makes this a real guard: reintroducing a list()
		// anywhere in walk() fails it immediately.
		expect(small).toBe(0);
		expect(large).toBe(0);
	}, 180_000);
});
