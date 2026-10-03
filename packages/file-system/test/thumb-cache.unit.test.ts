import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ExplorerDiskRoot, ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import { nodeToEntry } from '../src/ui/explorerDriver.ts';
import {
	forgetThumbMemoryForTests,
	recallThumb,
	rememberThumb,
	resetThumbCacheForTests,
	resolveDiskGrantId,
	setThumbCacheLimitsForTests,
	thumbCacheKey,
	thumbContentToken
} from '../src/ui/thumbCache.ts';

const caps: ExplorerDriver['capabilities'] = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: false,
	supportsMove: false,
	supportsCopy: false,
	supportsMkdir: false,
	supportsUpload: false,
	supportsDownload: true,
	supportsSiblingOrder: false
};

function driver(partial: Partial<ExplorerDriver> & Pick<ExplorerDriver, 'id'>): ExplorerDriver {
	return {
		capabilities: caps,
		ready: async () => {},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		delete: async () => {},
		...partial
	};
}

function file(partial: Partial<ExplorerEntry> & Pick<ExplorerEntry, 'id'>): ExplorerEntry {
	return { kind: 'file', name: 'a.png', parentId: null, ...partial };
}

class FakeRoot {
	kind = 'directory' as const;
	name: string;
	token: string;
	constructor(name: string, token: string) {
		this.name = name;
		this.token = token;
	}
	async isSameEntry(other: { token?: string }): Promise<boolean> {
		return other.token === this.token;
	}
}

describe('thumb cache', () => {
	beforeEach(async () => {
		await resetThumbCacheForTests();
	});

	it('keys local files by generation and ignores a rename-only timestamp', () => {
		const entry = nodeToEntry({
			id: 'n1',
			parentId: null,
			name: 'a.png',
			kind: 'file',
			size: 10,
			updatedAt: 5,
			generation: 3
		});
		assert.equal(entry.generation, 3);
		assert.equal(thumbContentToken(entry), 'g:3');
		assert.equal(thumbContentToken({ ...entry, updatedAt: 99, name: 'b.png' }), 'g:3');
		assert.equal(thumbContentToken({ ...entry, generation: 4 }), 'g:4');
	});

	it('keys disk and monitor files by size and modified time', () => {
		assert.equal(thumbContentToken(file({ id: 'p', size: 20, updatedAt: 8 })), 'm:20:8');
		assert.equal(
			thumbContentToken(file({ id: 'p', size: 20, updatedAt: 8, meta: { ino: '7', dev: '1' } })),
			'm:20:8:i:7:d:1'
		);
		assert.equal(thumbContentToken(file({ id: 'p', size: 20 })), null);
	});

	it('reuses a local thumbnail from IndexedDB after the memory copy is dropped', async () => {
		const key = await thumbCacheKey(driver({ id: 'local' }), file({ id: 'n1', generation: 2 }), 96);
		assert.ok(key);
		const blob = new Blob(['webp'], { type: 'image/webp' });
		await rememberThumb(key, blob);
		forgetThumbMemoryForTests();
		const again = await recallThumb(key);
		assert.equal(await again?.text(), 'webp');
		const rewritten = await thumbCacheKey(
			driver({ id: 'local' }),
			file({ id: 'n1', generation: 3 }),
			96
		);
		assert.notEqual(rewritten, key);
		assert.equal(await recallThumb(rewritten!), null);
	});

	it('keeps memory-list thumbnails in the tab and not in IndexedDB', async () => {
		const key = await thumbCacheKey(
			driver({ id: 'memory' }),
			file({ id: 'm1', generation: 1 }),
			32
		);
		assert.ok(key?.startsWith('memory:'));
		await rememberThumb(key!, new Blob(['x'], { type: 'image/webp' }));
		assert.equal((await recallThumb(key!))?.size, 1);
		forgetThumbMemoryForTests();
		assert.equal(await recallThumb(key!), null);
	});

	it('shares a disk grant id across two handles for the same folder', async () => {
		const first = new FakeRoot('Photos', 'same') as unknown as ExplorerDiskRoot;
		const again = new FakeRoot('Photos', 'same') as unknown as ExplorerDiskRoot;
		const other = new FakeRoot('Other', 'other') as unknown as ExplorerDiskRoot;
		const id = await resolveDiskGrantId(first);
		assert.equal(await resolveDiskGrantId(again), id);
		assert.notEqual(await resolveDiskGrantId(other), id);
		const key = await thumbCacheKey(
			driver({ id: 'disk', diskRoot: again }),
			file({ id: 'a.png', size: 4, updatedAt: 9 }),
			64
		);
		assert.ok(key?.startsWith(`disk:${id}\u0000`));
	});

	it('puts the monitor root in the cache scope', async () => {
		const key = await thumbCacheKey(
			driver({ id: 'monitor', thumbScope: 'monitor:p1:/data' }),
			file({ id: 'a.png', size: 4, updatedAt: 9, meta: { ino: '3', dev: '1' } }),
			96
		);
		assert.equal(key, 'monitor:p1:/data\u0000a.png\u0000m:4:9:i:3:d:1\u000096');
	});

	it('drops the oldest in-tab thumbnails past the cap', async () => {
		setThumbCacheLimitsForTests({ memEntries: 2 });
		const memDriver = driver({ id: 'memory' });
		const keys: string[] = [];
		for (const id of ['a', 'b', 'c']) {
			const key = await thumbCacheKey(memDriver, file({ id, generation: 1 }), 16);
			keys.push(key!);
			await rememberThumb(key!, new Blob([id], { type: 'image/webp' }));
		}
		assert.equal(await recallThumb(keys[0]!), null);
		assert.equal(await (await recallThumb(keys[2]!))?.text(), 'c');
	});
});
