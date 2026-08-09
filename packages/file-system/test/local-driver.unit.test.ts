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
		assert.equal(drv.capabilities.supportsUpload, false);

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

	it('apply list cap via EXPLORER_LIST_MAX_ENTRIES constant', () => {
		assert.equal(EXPLORER_LIST_MAX_ENTRIES, 2000);
	});
});
