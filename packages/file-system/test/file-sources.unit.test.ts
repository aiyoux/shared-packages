import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createVfs } from '../src/vfs.ts';
import { getMemoryVfs } from '../src/memoryVfs.ts';
import { memoryFileId } from '../src/fileSourceIds.ts';
import { openDiskFile } from '../src/disk/fileSource.ts';
import { createMemoryDiskRoot } from '../src/disk/memoryDisk.ts';

it('Memory editor reads and CAS-saves the original without opening durable storage', async () => {
	const memory = getMemoryVfs(); const node = await memory.writeFile({ parentId: null, name: 'Ephemeral.txt', fileType: 'text', body: new TextEncoder().encode('original'), contentType: 'text/plain' });
	const vfs = createVfs({ memoryOpfs: true, requestPersist: false });
	const original = indexedDB.open; let opens = 0;
	indexedDB.open = function (...args: Parameters<IDBFactory['open']>) { opens++; return original.apply(this, args); };
	try {
		const id = memoryFileId(node.id); const doc = await vfs.openDocument(id);
		assert.equal(await (await vfs.readBlob(id)).text(), 'original');
		await doc.save(new TextEncoder().encode('saved'));
		assert.equal(await (await memory.readBlob(node.id)).text(), 'saved');
		assert.equal((await vfs.get(id))?.generation, 2);
		assert.deepEqual((await vfs.getPath(id)).map((node) => node.name), ['In memory', 'Ephemeral.txt']);
		assert.equal((await vfs.list({ parentId: 'memory:' })).some((node) => node.id === id), true);
		const copy = await doc.saveAs({ parentId: 'memory:', name: 'Copy.txt', body: new TextEncoder().encode('copy') });
		assert.equal(await (await vfs.readBlob(copy.id)).text(), 'copy');
		await memory.delete(copy.id.slice('memory:'.length));
		await assert.rejects(vfs.updateFile(id, 'stale', { expectedGeneration: 1 }), { code: 'GENERATION_CONFLICT' });
		doc.close(); await memory.delete(node.id);
		assert.equal(await vfs.get(id), undefined);
		assert.equal(opens, 0);
	} finally { indexedDB.open = original; }
});

it('Disk editor saves the same nested file, preserves metadata and rejects external changes', async () => {
	const root = createMemoryDiskRoot('Source test'); const folder = await root.getDirectoryHandle('nested', { create: true });
	const handle = await folder.getFileHandle('file.txt', { create: true });
	let writer = await handle.createWritable(); await writer.write('original'); await writer.close();
	const id = await openDiskFile(root, 'nested/file.txt');
	assert.equal(await openDiskFile(root, 'nested/file.txt'), id);
	const vfs = createVfs({ memoryOpfs: true }); const doc = await vfs.openDocument(id);
	assert.deepEqual((await vfs.getPath(id)).map((node) => node.name), ['Source test', 'nested', 'file.txt']);
	await doc.save(new TextEncoder().encode('saved'), { meta: { marker: 'kept' } });
	assert.equal(await (await handle.getFile()).text(), 'saved');
	assert.equal((await vfs.get(id))?.meta?.marker, 'kept');
	writer = await handle.createWritable(); await writer.write('external content with a different size'); await writer.close();
	await assert.rejects(doc.save('overwrite'), { code: 'GENERATION_CONFLICT' });
	assert.equal(await (await handle.getFile()).text(), 'external content with a different size');
	doc.close();
});

it('two Disk saves from the same generation cannot both overwrite the source', async () => {
	const root = createMemoryDiskRoot('Concurrent source'); const handle = await root.getFileHandle('race.txt', { create: true });
	const writer = await handle.createWritable(); await writer.write('before'); await writer.close();
	const id = await openDiskFile(root, 'race.txt'); const vfs = createVfs({ memoryOpfs: true });
	const generation = (await vfs.get(id))!.generation;
	const results = await Promise.allSettled(['first', 'second'].map((body) => vfs.updateFile(id, new TextEncoder().encode(body), { expectedGeneration: generation })));
	assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
	assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
	assert.equal(await (await handle.getFile()).text(), 'first');
});

it('Disk sibling copies choose unique names under concurrent writes and preserve folders', async () => {
	const root = createMemoryDiskRoot('Copy test');
	await root.getDirectoryHandle('same.txt', { create: true });
	const parentId = await openDiskFile(root, ''); const vfs = createVfs({ memoryOpfs: true });
	const copies = await Promise.all(['first', 'second'].map((text) => vfs.writeFile({ parentId, name: 'same.txt', body: new TextEncoder().encode(text) })));
	assert.equal(new Set(copies.map((node) => node.name)).size, 2);
	assert.deepEqual(await Promise.all(copies.map(async (node) => (await vfs.readBlob(node.id)).text())), ['first', 'second']);
	assert.equal((await root.getDirectoryHandle('same.txt')).kind, 'directory');
	await assert.rejects(vfs.writeFile({ parentId, name: 'same.txt', body: 'overwrite', onConflict: 'overwrite' }), { code: 'NAME_CONFLICT' });
});
