import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDiskExplorerDriver } from '../src/disk/diskExplorerDriver.ts';
import { createMemoryDiskRoot } from '../src/disk/memoryDisk.ts';
import { isLocalClass } from '../src/ui/explorerDriver.ts';

describe('diskExplorerDriver', () => {
	it('is local-class', () => {
		assert.equal(isLocalClass('disk'), true);
	});

	it('lists, writes, reads, and deletes files under the picked root', async () => {
		const root = createMemoryDiskRoot('Work');
		const drv = createDiskExplorerDriver(root);
		await drv.ready();

		const written = await drv.writeFile!(
			null,
			new File(['hello'], 'note.txt', { type: 'text/plain' })
		);
		assert.equal(written.name, 'note.txt');
		assert.equal(written.kind, 'file');

		const listed = await drv.list({ parentId: null });
		assert.deepEqual(
			listed.entries.map((e) => e.name),
			['note.txt']
		);

		const blob = await drv.readBlob!(written.id);
		assert.equal(await blob.text(), 'hello');

		await drv.delete(written.id);
		const after = await drv.list({ parentId: null });
		assert.equal(after.entries.length, 0);
	});

	it('mkdir + upload into a folder', async () => {
		const drv = createDiskExplorerDriver(createMemoryDiskRoot());
		const folder = await drv.mkdir!(null, 'Docs');
		assert.equal(folder.id, 'Docs/');
		await drv.upload!(folder.id, new File(['x'], 'a.bin'));
		const kids = await drv.list({ parentId: folder.id });
		assert.equal(kids.entries.length, 1);
		assert.equal(kids.entries[0]!.name, 'a.bin');
		assert.equal(kids.entries[0]!.parentId, 'Docs/');
	});

	it('copy a file into a new folder', async () => {
		const drv = createDiskExplorerDriver(createMemoryDiskRoot());
		const src = await drv.writeFile!(null, new File(['z'], 'z.txt'));
		const dest = await drv.mkdir!(null, 'Out');
		await drv.copy!(src.id, dest.id);
		const kids = await drv.list({ parentId: dest.id });
		assert.deepEqual(
			kids.entries.map((e) => e.name),
			['z.txt']
		);
		const still = await drv.list({ parentId: null });
		assert.equal(
			still.entries.some((e) => e.name === 'z.txt' && e.kind === 'file'),
			true
		);
	});

	it('identity rename is a no-op (file and folder)', async () => {
		const drv = createDiskExplorerDriver(createMemoryDiskRoot());
		const file = await drv.writeFile!(null, new File(['keep'], 'keep.txt'));
		const folder = await drv.mkdir!(null, 'Docs');
		await drv.writeFile!(folder.id, new File(['c'], 'child.txt'));
		const sameFile = await drv.rename!(file.id, 'keep.txt');
		assert.equal(sameFile.id, file.id);
		assert.equal(await (await drv.readBlob!(file.id)).text(), 'keep');
		const sameFolder = await drv.rename!(folder.id, 'Docs');
		assert.equal(sameFolder.id, folder.id);
		const kids = await drv.list({ parentId: folder.id });
		assert.equal(kids.entries.length, 1);
		assert.equal(kids.entries[0]!.name, 'child.txt');
	});

	it('rejects copy/move of a folder into itself or a descendant', async () => {
		const drv = createDiskExplorerDriver(createMemoryDiskRoot());
		const docs = await drv.mkdir!(null, 'Docs');
		const nested = await drv.mkdir!(docs.id, 'Nested');
		await assert.rejects(() => drv.copy!(docs.id, docs.id), /CYCLE/);
		await assert.rejects(() => drv.move!(docs.id, nested.id), /CYCLE/);
		const still = await drv.list({ parentId: null });
		assert.equal(
			still.entries.some((e) => e.id === docs.id),
			true
		);
	});
});
