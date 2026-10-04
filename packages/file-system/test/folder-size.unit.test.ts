import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	formatFolderMeasure,
	measureFolderSize
} from '../src/ui/folderSize.ts';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

function child(
	id: string,
	parentId: string,
	kind: 'file' | 'folder',
	size?: number
): ExplorerEntry {
	return { id, parentId, name: id, kind, ...(size != null ? { size } : {}) };
}

function driverFrom(tree: Map<string, ExplorerEntry[]>): ExplorerDriver {
	return {
		id: 'memory',
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
		ready: async () => {},
		list: async ({ parentId }) => ({
			entries: tree.get(parentId ?? '') ?? [],
			truncated: false
		}),
		getPath: async () => [],
		delete: async () => {}
	};
}

describe('measureFolderSize', () => {
	it('sums nested files and counts folders', async () => {
		const tree = new Map<string, ExplorerEntry[]>([
			['root', [child('a.txt', 'root', 'file', 10), child('sub', 'root', 'folder')]],
			['sub', [child('b.txt', 'sub', 'file', 5), child('deep', 'sub', 'folder')]],
			['deep', [child('c.txt', 'deep', 'file', 1)]]
		]);
		const measure = await measureFolderSize(driverFrom(tree), 'root');
		assert.equal(measure.bytes, 16);
		assert.equal(measure.files, 3);
		assert.equal(measure.folders, 2);
		assert.equal(measure.unknown, 0);
		assert.equal(measure.truncated, false);
		assert.equal(formatFolderMeasure(measure), '16 B');
	});

	it('measures the driver root when the folder id is null', async () => {
		const tree = new Map<string, ExplorerEntry[]>([
			['', [
				{ id: 'a.txt', parentId: null, name: 'a.txt', kind: 'file', size: 4 },
				{ id: 'sub', parentId: null, name: 'sub', kind: 'folder' }
			]],
			['sub', [child('b.txt', 'sub', 'file', 6)]]
		]);
		const measure = await measureFolderSize(driverFrom(tree), null);
		assert.equal(measure.bytes, 10);
		assert.equal(measure.files, 2);
		assert.equal(measure.folders, 1);
	});

	it('ignores rows that belong to another parent and files with no size', async () => {
		const tree = new Map<string, ExplorerEntry[]>([
			['root', [
				child('a.txt', 'root', 'file', 4),
				child('stray.txt', 'other', 'file', 100),
				{ id: 'bare.txt', parentId: 'root', name: 'bare.txt', kind: 'file' }
			]]
		]);
		const measure = await measureFolderSize(driverFrom(tree), 'root');
		assert.equal(measure.bytes, 4);
		assert.equal(measure.files, 2);
		assert.equal(measure.unknown, 1);
		assert.equal(formatFolderMeasure(measure), '4 B + 1 unknown');
	});

	it('stops at the entry cap and says the total is incomplete', async () => {
		const tree = new Map<string, ExplorerEntry[]>([
			['root', [
				child('a.txt', 'root', 'file', 2),
				child('b.txt', 'root', 'file', 3),
				child('c.txt', 'root', 'file', 4)
			]]
		]);
		const measure = await measureFolderSize(driverFrom(tree), 'root', { maxEntries: 2 });
		assert.equal(measure.truncated, true);
		assert.equal(measure.files, 2);
		assert.equal(measure.bytes, 5);
		assert.equal(formatFolderMeasure(measure), '5 B or more');
	});

	it('uses listAll when the driver has an uncapped listing', async () => {
		let listed = 0;
		const driver = driverFrom(new Map([['root', [child('a.txt', 'root', 'file', 8)]]]));
		driver.list = async () => {
			listed += 1;
			return { entries: [], truncated: true };
		};
		driver.listAll = async () => [child('a.txt', 'root', 'file', 8)];
		const measure = await measureFolderSize(driver, 'root');
		assert.equal(listed, 0);
		assert.equal(measure.bytes, 8);
		assert.equal(measure.truncated, false);
	});

	it('rejects when the walk is aborted', async () => {
		const ac = new AbortController();
		const driver = driverFrom(new Map());
		driver.list = async () => {
			ac.abort();
			return { entries: [], truncated: false };
		};
		await assert.rejects(
			() => measureFolderSize(driver, 'root', { signal: ac.signal }),
			(err: unknown) => err instanceof DOMException && err.name === 'AbortError'
		);
	});
});
