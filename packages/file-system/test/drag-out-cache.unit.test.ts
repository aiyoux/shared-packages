import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	prefetchForDragOut,
	getDragOutFile,
	getDragOutUrl,
	hasDragOutFile,
	evictDragOutFile,
	clearDragOutCache,
	evictDriver,
	canZipFolderForDragOut,
	folderZipName,
	formatDownloadURL,
	type DragOutUrl
} from '../src/ui/dragOutCache.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import { createVfs } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';


/** `prefetchForDragOut` may resolve a URL payload; these cases expect a File. */
function asFile(v: File | DragOutUrl | null | undefined): File {
	assert.ok(v instanceof File, 'expected a File, got a drag-out URL payload');
	return v;
}

function makeEntry(overrides: Partial<ExplorerEntry> = {}): ExplorerEntry {
	return {
		id: 'f1',
		parentId: null,
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
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: true,
			supportsMove: true,
			supportsCopy: true,
			supportsMkdir: true,
			supportsUpload: false,
			supportsDownload: true,
			supportsSiblingOrder: false,
			supportsDragOut: true
		},
		ready: async () => {},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		mkdir: async () => ({ id: 'x', parentId: null, kind: 'folder' as const, name: 'x' }),
		rename: async () => ({ id: 'x', parentId: null, kind: 'folder' as const, name: 'x' }),
		move: async () => {},
		delete: async () => {},
		readBlob: async () => blob,
		writeFile: async () => ({ id: 'x', parentId: null, kind: 'file' as const, name: 'x' }),
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
		assert.equal(asFile(file).name, 'test.txt');
		assert.equal(asFile(file).type, 'text/plain');
		assert.equal(asFile(file).size, 5);

		// Cached — synchronous get works
		assert.equal(hasDragOutFile('f1'), true);
		const cached = getDragOutFile('f1');
		assert.notEqual(cached, null);
		assert.equal(asFile(cached).name, 'test.txt');
	});

	it('prefetchForDragOut uses download() when readBlob is absent', async () => {
		const blob = new Blob(['world'], { type: 'application/octet-stream' });
		const driver = makeDriver(blob, { readBlob: undefined, download: async () => blob });
		const entry = makeEntry({ name: 'data.bin', contentType: 'application/octet-stream' });

		const file = await prefetchForDragOut(driver, entry);
		assert.notEqual(file, null);
		assert.equal(asFile(file).name, 'data.bin');
		assert.equal(asFile(file).size, 5);
	});

	it('canZipFolderForDragOut is false for disk/B2/rclone (no zip-on-GET URL)', () => {
		assert.equal(canZipFolderForDragOut(makeDriver(new Blob(['x']), { id: 'disk' })), false);
		assert.equal(canZipFolderForDragOut(makeDriver(new Blob(['x']), { id: 'b2' })), false);
		assert.equal(canZipFolderForDragOut(makeDriver(new Blob(['x']), { id: 'rclone' })), false);
		assert.equal(folderZipName(makeEntry({ kind: 'folder', name: 'Docs' })), 'Docs.zip');
	});

	it('prefetchForDragOut skips B2/rclone folders (no zip URL, no in-tab buffer)', async () => {
		for (const id of ['b2', 'rclone'] as const) {
			const driver = makeDriver(new Blob(['hello']), { id });
			const entry = makeEntry({ id: 'docs/', kind: 'folder', name: 'Docs', parentId: null });
			const file = await prefetchForDragOut(driver, entry);
			assert.equal(file, null, id);
		}
	});

	it('prefetchForDragOut caches a download URL without reading bytes', async () => {
		let downloaded = 0;
		const driver = makeDriver(new Blob(['secret']), {
			id: 'b2',
			download: async () => {
				downloaded++;
				return new Blob(['secret']);
			},
			downloadUrl: async () => ({
				url: 'https://f000.backblazeb2.com/file/bucket/photo.png?Authorization=tok',
				filename: 'photo.png'
			})
		});
		const entry = makeEntry({ id: 'photo.png', name: 'photo.png', contentType: 'image/png' });
		const ready = await prefetchForDragOut(driver, entry);
		assert.equal(downloaded, 0);
		assert.ok(ready && !(ready instanceof File));
		assert.equal((ready as { url: string }).url.includes('backblazeb2.com'), true);
		assert.equal(getDragOutFile('photo.png'), null);
		const loc = getDragOutUrl('photo.png');
		assert.ok(loc);
		assert.equal(
			formatDownloadURL(loc),
			'image/png:photo.png:https://f000.backblazeb2.com/file/bucket/photo.png?Authorization=tok'
		);
	});

	it('prefetchForDragOut zips a local folder for OS drag-out', async () => {
		const vfs = createVfs({
			dbName: `drag-out-folder-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'Docs');
		await driver.writeFile!(folder.id, new File([new TextEncoder().encode('hello')], 'a.txt'));
		const file = await prefetchForDragOut(driver, folder);
		assert.notEqual(file, null);
		assert.equal(asFile(file).name, 'Docs.zip');
		assert.equal(asFile(file).type, 'application/zip');
		assert.ok(asFile(file).size > 0);
		assert.equal(hasDragOutFile(folder.id), true);
	});

	it('prefetchForDragOut uses monitor zip URL for folders (GET on drop)', async () => {
		let downloaded = 0;
		const driver = makeDriver(new Blob(['x']), {
			id: 'monitor',
			download: async () => {
				downloaded++;
				return new Blob(['nope']);
			},
			downloadUrl: async (id) => {
				if (String(id).endsWith('/')) {
					return {
						url: 'http://127.0.0.1:8300/v1/fs/zip?path=%2Ftmp%2FDocs&download=Docs.zip',
						filename: 'Docs.zip'
					};
				}
				return {
					url: 'http://127.0.0.1:8300/v1/fs/read?path=%2Ftmp%2Fa.png&download=a.png',
					filename: 'a.png'
				};
			}
		});
		const entry = makeEntry({ id: 'Docs/', kind: 'folder', name: 'Docs', parentId: null });
		const ready = await prefetchForDragOut(driver, entry);
		assert.equal(downloaded, 0);
		assert.ok(ready && !(ready instanceof File));
		assert.equal(getDragOutUrl('Docs/')?.url.includes('/v1/fs/zip'), true);
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
