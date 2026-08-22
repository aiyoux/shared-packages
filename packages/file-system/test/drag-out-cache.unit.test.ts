import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	prefetchForDragOut,
	getDragOutFile,
	hasDragOutFile,
	evictDragOutFile,
	clearDragOutCache,
	evictDriver
} from '../src/ui/dragOutCache.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

function makeEntry(overrides: Partial<ExplorerEntry> = {}): ExplorerEntry {
	return {
		id: 'f1',
		kind: 'file',
		name: 'test.txt',
		size: 5,
		contentType: 'text/plain',
		...overrides
	};
}

function makeDriver(blob: Blob, opts: Partial<ExplorerDriver> = {}): ExplorerDriver {
	return {
		id: 'local',
		capabilities: {
			supportsMkdir: true,
			supportsRename: true,
			supportsMove: true,
			supportsDragOut: true,
			supportsSiblingOrder: false,
			canDownload: true
		},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		mkdir: async () => ({ id: 'x', kind: 'folder', name: 'x' }),
		rename: async () => ({ id: 'x', kind: 'folder', name: 'x' }),
		move: async () => {},
		delete: async () => {},
		readBlob: async () => blob,
		writeFile: async () => ({ id: 'x', kind: 'file', name: 'x' }),
		...opts
	};
}

describe('dragOutCache', () => {
	beforeEach(() => clearDragOutCache());

	it('getDragOutFile returns null when nothing cached', () => {
		assert.equal(getDragOutFile('f1'), null);
		assert.equal(hasDragOutFile('f1'), false);
	});

	it('prefetchForDragOut fetches and caches a file', async () => {
		const blob = new Blob(['hello'], { type: 'text/plain' });
		const driver = makeDriver(blob);
		const entry = makeEntry();

		const file = await prefetchForDragOut(driver, entry);
		assert.notEqual(file, null);
		assert.equal(file!.name, 'test.txt');
		assert.equal(file!.type, 'text/plain');
		assert.equal(file!.size, 5);

		// Cached — synchronous get works
		assert.equal(hasDragOutFile('f1'), true);
		const cached = getDragOutFile('f1');
		assert.notEqual(cached, null);
		assert.equal(cached!.name, 'test.txt');
	});

	it('prefetchForDragOut uses download() when readBlob is absent', async () => {
		const blob = new Blob(['world'], { type: 'application/octet-stream' });
		const driver = makeDriver(blob, { readBlob: undefined, download: async () => blob });
		const entry = makeEntry({ name: 'data.bin', contentType: 'application/octet-stream' });

		const file = await prefetchForDragOut(driver, entry);
		assert.notEqual(file, null);
		assert.equal(file!.name, 'data.bin');
		assert.equal(file!.size, 5);
	});

	it('prefetchForDragOut returns null for folders', async () => {
		const driver = makeDriver(new Blob(['x']));
		const entry = makeEntry({ kind: 'folder' });
		const file = await prefetchForDragOut(driver, entry);
		assert.equal(file, null);
	});

	it('prefetchForDragOut returns null for oversized files', async () => {
		const driver = makeDriver(new Blob(['x']));
		const entry = makeEntry({ size: 200 * 1024 * 1024 }); // 200 MiB > 100 MiB cap
		const file = await prefetchForDragOut(driver, entry);
		assert.equal(file, null);
	});

	it('prefetchForDragOut returns null when driver has no read method', async () => {
		const driver = makeDriver(new Blob(['x']), {
			readBlob: undefined,
			download: undefined
		});
		const entry = makeEntry();
		const file = await prefetchForDragOut(driver, entry);
		assert.equal(file, null);
	});

	it('prefetchForDragOut returns null on read error', async () => {
		const driver = makeDriver(new Blob(['x']), {
			readBlob: async () => {
				throw new Error('disk full');
			}
		});
		const entry = makeEntry();
		const file = await prefetchForDragOut(driver, entry);
		assert.equal(file, null);
	});

	it('concurrent prefetch calls share one fetch', async () => {
		let fetchCount = 0;
		const driver = makeDriver(new Blob(['x']), {
			readBlob: async () => {
				fetchCount++;
				await new Promise((r) => setTimeout(r, 10));
				return new Blob(['data'], { type: 'text/plain' });
			}
		});
		const entry = makeEntry();
		const [a, b] = await Promise.all([
			prefetchForDragOut(driver, entry),
			prefetchForDragOut(driver, entry)
		]);
		assert.equal(fetchCount, 1);
		assert.notEqual(a, null);
		assert.notEqual(b, null);
	});

	it('evictDragOutFile removes a cached entry', async () => {
		const driver = makeDriver(new Blob(['hi'], { type: 'text/plain' }));
		const entry = makeEntry();
		await prefetchForDragOut(driver, entry);
		assert.equal(hasDragOutFile('f1'), true);
		evictDragOutFile('f1');
		assert.equal(hasDragOutFile('f1'), false);
		assert.equal(getDragOutFile('f1'), null);
	});

	it('clearDragOutCache removes all entries', async () => {
		const driver = makeDriver(new Blob(['hi'], { type: 'text/plain' }));
		await prefetchForDragOut(driver, makeEntry({ id: 'f1' }));
		await prefetchForDragOut(driver, makeEntry({ id: 'f2' }));
		assert.equal(hasDragOutFile('f1'), true);
		assert.equal(hasDragOutFile('f2'), true);
		clearDragOutCache();
		assert.equal(hasDragOutFile('f1'), false);
		assert.equal(hasDragOutFile('f2'), false);
	});

	it('evictDriver clears all entries', async () => {
		const driver = makeDriver(new Blob(['hi'], { type: 'text/plain' }));
		await prefetchForDragOut(driver, makeEntry({ id: 'f1' }));
		evictDriver('local');
		assert.equal(hasDragOutFile('f1'), false);
	});
});
