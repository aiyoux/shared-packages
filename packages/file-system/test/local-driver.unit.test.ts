import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import { EXPLORER_LIST_MAX_ENTRIES } from '../src/ui/explorerDriver.ts';

describe('LocalExplorerDriver', () => {
	beforeEach(() => {
		resetSharedVfsForTests();
	});

	it('maps list + trash delete to VFS', async () => {
		const vfs = createVfs({
			dbName: `local-drv-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		const drv = createLocalExplorerDriver(vfs);
		await drv.ready();
		assert.equal(drv.id, 'local');
		assert.equal(drv.capabilities.supportsTrash, true);
		assert.equal(drv.capabilities.supportsUpload, true);
		assert.equal(drv.capabilities.supportsDownload, false);

		await drv.mkdir!(null, 'Docs');
		const listed = await drv.list({ parentId: null });
		assert.equal(listed.truncated, false);
		assert.ok(listed.entries.some((e) => e.name === 'Docs' && e.kind === 'folder'));

		const file = await vfs.writeFile({
			parentId: null,
			name: 'a.skch',
			fileType: 'skch',
			body: { v: 1 }
		});
		await drv.delete(file.id);
		const active = await drv.list({ parentId: null });
		assert.ok(!active.entries.some((e) => e.id === file.id));
		const trash = await drv.list({ parentId: null, trashOnly: true });
		assert.ok(trash.entries.some((e) => e.id === file.id));
	});

	it('supportsSiblingOrder=true and mandatory reorder → vfs.reorder', async () => {
		const vfs = createVfs({
			dbName: `local-ord-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		const drv = createLocalExplorerDriver(vfs);
		assert.equal(drv.capabilities.supportsSiblingOrder, true);
		assert.equal(typeof drv.reorder, 'function');

		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		await drv.reorder!(b.id, { afterId: a.id });
		const { entries } = await drv.list({ parentId: null });
		const files = entries.filter((e) => e.kind === 'file');
		assert.equal(files[0]?.name, 'b.txt');
		assert.equal(files[1]?.name, 'a.txt');
		assert.ok((files[0]?.sortOrder ?? 0) < (files[1]?.sortOrder ?? 0));
	});

	it('list uses sort order when supportsSiblingOrder', async () => {
		const vfs = createVfs({
			dbName: `local-list-ord-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		const drv = createLocalExplorerDriver(vfs);
		await vfs.writeFile({ parentId: null, name: 'z.txt', body: 'z' });
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const { entries } = await drv.list({ parentId: null });
		const files = entries.filter((e) => e.kind === 'file');
		// creation order ranks, not name sort
		assert.deepEqual(
			files.map((e) => e.name),
			['z.txt', 'a.txt']
		);
	});

	it('stock local caps: download false, upload true (OS file drop)', async () => {
		const vfs = createVfs({
			dbName: `local-caps-${Date.now()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		const drv = createLocalExplorerDriver(vfs);
		assert.equal(drv.capabilities.supportsDownload, false);
		assert.equal(drv.capabilities.supportsUpload, true);
	});

	it('apply list cap via EXPLORER_LIST_MAX_ENTRIES constant', () => {
		assert.equal(EXPLORER_LIST_MAX_ENTRIES, 2000);
	});
});
