import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	clearAllMemoryVfsForTests,
	createMemoryVfs,
	disposeMemoryVfs,
	getMemoryVfs
} from './memoryVfs.js';
import { createLocalExplorerDriver } from './ui/localExplorerDriver.js';

describe('MemoryVfs fail-closed', () => {
	beforeEach(() => {
		clearAllMemoryVfsForTests();
	});

	it('never opens IndexedDB', async () => {
		const open = vi.spyOn(indexedDB, 'open');
		const vfs = createMemoryVfs('files');
		await vfs.ready();
		await vfs.mkdir(null, 'a');
		await vfs.writeFile({ parentId: null, name: 'f.txt', body: 'x' });
		expect(open).not.toHaveBeenCalled();
		open.mockRestore();
	});

	it('never constructs SharedVfsDatabase path (no SharedVFS IDB name)', async () => {
		const open = vi.spyOn(indexedDB, 'open');
		const vfs = createMemoryVfs('no-shared');
		await vfs.writeFile({ parentId: null, name: 'x.bin', body: new Uint8Array([1, 2, 3]) });
		await vfs.reorder(
			(await vfs.list({ parentId: null }))[0]!.id,
			{}
		);
		expect(open).not.toHaveBeenCalled();
		// product path must not open SharedVFS / any db
		for (const call of open.mock.calls) {
			expect(String(call[0])).not.toMatch(/SharedVFS/i);
		}
		open.mockRestore();
	});

	it('requestPersist surface is always false / memory', async () => {
		const vfs = createMemoryVfs('persist');
		await vfs.ready();
		expect(vfs.persistence.status).toBe('memory');
		expect(vfs.persistence.requested).toBe(false);
	});

	it('isolates files vs cm scopes', async () => {
		const files = getMemoryVfs('files');
		const cm = getMemoryVfs('cm');
		await files.mkdir(null, 'OnlyFiles');
		const listCm = await cm.list({ parentId: null });
		expect(listCm.some((n) => n.name === 'OnlyFiles')).toBe(false);
		// same scope is singleton store
		const files2 = getMemoryVfs('files');
		const list = await files2.list({ parentId: null });
		expect(list.some((n) => n.name === 'OnlyFiles')).toBe(true);
	});

	it('dispose clears scope', async () => {
		const vfs = getMemoryVfs('files');
		await vfs.mkdir(null, 'gone');
		disposeMemoryVfs('files');
		const again = getMemoryVfs('files');
		const list = await again.list({ parentId: null });
		expect(list).toHaveLength(0);
	});

	it('reorder changes list order', async () => {
		const vfs = createMemoryVfs('ord');
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const b = await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		// move b before a
		await vfs.reorder(b.id, { afterId: a.id });
		const list = await vfs.list({ parentId: null, sort: 'order' });
		const names = list.filter((n) => n.kind === 'file').map((n) => n.name);
		expect(names[0]).toBe('b.txt');
		expect((list[0]?.sortOrder ?? 0) < (list[1]?.sortOrder ?? 0)).toBe(true);
	});

	it('CRUD round-trip body integrity in RAM', async () => {
		const vfs = createMemoryVfs('crud');
		const f = await vfs.writeFile({
			parentId: null,
			name: 'payload.bin',
			body: new Uint8Array([9, 8, 7])
		});
		const blob = await vfs.readBlob(f.id);
		expect(blob.size).toBe(3);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		expect([...bytes]).toEqual([9, 8, 7]);
	});

	it('memory driver id and caps', async () => {
		const vfs = createMemoryVfs('drv') as unknown as import('./vfs.js').VfsService;
		const driver = createLocalExplorerDriver(vfs, {
			id: 'memory',
			capabilitiesPatch: { supportsDownload: true, supportsUpload: false }
		});
		expect(driver.id).toBe('memory');
		expect(driver.capabilities.supportsSiblingOrder).toBe(true);
		expect(driver.capabilities.supportsDownload).toBe(true);
		await driver.ready();
		await driver.mkdir!(null, 'd');
		const { entries } = await driver.list({ parentId: null });
		expect(entries.some((e) => e.name === 'd')).toBe(true);
	});

	it('restore recursively restores trashed folder children', async () => {
		const vfs = createMemoryVfs('rec-restore');
		const fld = await vfs.mkdir(null, 'Folder');
		const child = await vfs.writeFile({ parentId: fld.id, name: 'child.txt', body: 'hello' });
		await vfs.trash(fld.id);

		expect((await vfs.get(fld.id))?.deletedAt).not.toBeNull();
		expect((await vfs.get(child.id))?.deletedAt).not.toBeNull();

		await vfs.restore(fld.id);

		expect((await vfs.get(fld.id))?.deletedAt).toBeNull();
		expect((await vfs.get(child.id))?.deletedAt).toBeNull();
	});
});
