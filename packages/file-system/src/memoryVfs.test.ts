import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	clearAllMemoryVfsForTests,
	createMemoryVfs,
	disposeMemoryVfs,
	getMemoryVfs,
	toVfsNodeLike
} from './memoryVfs.js';
import { createMemoryExplorerDriver } from './ui/memoryExplorerDriver.js';

describe('MemoryVfs fail-closed flat list', () => {
	beforeEach(() => {
		clearAllMemoryVfsForTests();
	});

	it('never opens IndexedDB', async () => {
		const open = vi.spyOn(indexedDB, 'open');
		const vfs = createMemoryVfs();
		await vfs.ready();
		await vfs.writeFile({ parentId: null, name: 'f.txt', body: 'x' });
		expect(open).not.toHaveBeenCalled();
		open.mockRestore();
	});

	it('never constructs SharedVfsDatabase path (no SharedVFS IDB name)', async () => {
		const open = vi.spyOn(indexedDB, 'open');
		const vfs = createMemoryVfs();
		await vfs.writeFile({ parentId: null, name: 'x.bin', body: new Uint8Array([1, 2, 3]) });
		expect(open).not.toHaveBeenCalled();
		for (const call of open.mock.calls) {
			expect(String(call[0])).not.toMatch(/SharedVFS/i);
		}
		open.mockRestore();
	});

	it('requestPersist surface is always false / memory', async () => {
		const vfs = createMemoryVfs();
		await vfs.ready();
		expect(vfs.persistence.status).toBe('memory');
		expect(vfs.persistence.requested).toBe(false);
	});

	it('is a single global store — scope arg is ignored', async () => {
		const a = getMemoryVfs('files');
		const b = getMemoryVfs('cm');
		await a.writeFile({ parentId: null, name: 'shared.txt', body: 'x' });
		// both observe the same global list
		const listA = await a.list({ parentId: null });
		const listB = await b.list({ parentId: null });
		expect(listA.some((n) => n.name === 'shared.txt')).toBe(true);
		expect(listB.some((n) => n.name === 'shared.txt')).toBe(true);
		expect((await getMemoryVfs().list({ parentId: null })).length).toBe(1);
	});

	it('dispose clears the global store', async () => {
		const vfs = getMemoryVfs();
		await vfs.writeFile({ parentId: null, name: 'gone.txt', body: 'x' });
		disposeMemoryVfs();
		const again = getMemoryVfs();
		expect(await again.list({ parentId: null })).toHaveLength(0);
	});

	it('has no folders — mkdir is not implemented', async () => {
		const vfs = createMemoryVfs();
		expect(typeof (vfs as unknown as { mkdir?: unknown }).mkdir).toBe('undefined');
		expect(typeof (vfs as unknown as { trash?: unknown }).trash).toBe('undefined');
		expect(typeof (vfs as unknown as { reorder?: unknown }).reorder).toBe('undefined');
	});

	it('CRUD round-trip body integrity in RAM', async () => {
		const vfs = createMemoryVfs();
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

	it('list sorts by name and updatedAt', async () => {
		const vfs = createMemoryVfs();
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		const byName = (await vfs.list({ parentId: null, sort: 'name' })).map((n) => n.name);
		expect(byName).toEqual(['a.txt', 'b.txt']);
	});

	it('rename enforces unique names', async () => {
		const vfs = createMemoryVfs();
		const a = await vfs.writeFile({ parentId: null, name: 'a.txt', body: 'a' });
		await vfs.writeFile({ parentId: null, name: 'b.txt', body: 'b' });
		const renamed = await vfs.rename(a.id, 'b.txt');
		expect(renamed.name).toBe('b (1).txt');
	});

	it('updateFile honours generation CAS', async () => {
		const vfs = createMemoryVfs();
		const f = await vfs.writeFile({ parentId: null, name: 'f.txt', body: 'a' });
		const gen = f.generation;
		await expect(
			vfs.updateFile(f.id, 'b', { expectedGeneration: gen + 1 })
		).rejects.toThrow();
		const updated = await vfs.updateFile(f.id, 'b', { expectedGeneration: gen });
		expect(updated.generation).toBe(gen + 1);
		expect(await vfs.readJson(f.id)).toBe('b');
	});

	it('delete removes the node and its blob', async () => {
		const vfs = createMemoryVfs();
		const f = await vfs.writeFile({ parentId: null, name: 'f.txt', body: 'a' });
		await vfs.delete(f.id);
		expect(await vfs.get(f.id)).toBeUndefined();
		await expect(vfs.readBytes(f.id)).rejects.toThrow();
	});

	it('memory driver id and caps (flat, no folders)', async () => {
		const vfs = createMemoryVfs();
		const driver = createMemoryExplorerDriver(vfs);
		expect(driver.id).toBe('memory');
		expect(driver.capabilities.supportsSiblingOrder).toBe(false);
		expect(driver.capabilities.supportsMkdir).toBe(false);
		expect(driver.capabilities.supportsDownload).toBe(true);
		await driver.ready();
		// Duck-typed file (jsdom's File lacks arrayBuffer in this env).
		const file = {
			name: 'note.txt',
			type: 'text/plain',
			arrayBuffer: async () => new TextEncoder().encode('hi').buffer
		} as unknown as File;
		await driver.writeFile!(null, file);
		const { entries } = await driver.list({ parentId: null });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe('file');
		expect(entries[0]?.parentId).toBeNull();
		// download path
		const blob = await driver.download!(entries[0]!.id);
		expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).toBe('hi');
		// delete path
		await driver.delete(entries[0]!.id);
		expect((await driver.list({ parentId: null })).entries).toHaveLength(0);
	});

	it('toVfsNodeLike produces a root-level file VfsNode shape', () => {
		const node = toVfsNodeLike({
			id: 'x',
			parentId: null,
			kind: 'file',
			name: 'a.txt',
			size: 1,
			createdAt: 1,
			updatedAt: 1,
			generation: 1,
			blobId: 'b'
		});
		expect(node.parentId).toBeNull();
		expect(node.kind).toBe('file');
	});
});