import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyViewForWrite, createMemoryOpfs, pathUnderPrefix } from '../src/opfs.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('OpfsBlobStore contract', () => {
	it('readBlob round-trips bytes and honours contentType', async () => {
		const store = createMemoryOpfs();
		await store.writeFinal('blobs/a.bin', enc.encode('hello store'));
		const blob = await store.readBlob('blobs/a.bin', 'text/plain');
		assert.equal(blob.type, 'text/plain');
		assert.equal(dec.decode(new Uint8Array(await blob.arrayBuffer())), 'hello store');
	});

	it('readRange is the capability gate for packed blobs', async () => {
		// Packing must only ever be enabled against a store that can serve a
		// byte range cheaply. The in-memory store deliberately does not, so a
		// caller checking for the method gets the right answer without sniffing
		// the constructor.
		const memory = createMemoryOpfs();
		assert.equal(
			typeof memory.readRange,
			'undefined',
			'memory store must not advertise range reads'
		);
	});

	it('copyViewForWrite copies a subarray, not the backing buffer', () => {
		const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const view = backing.subarray(2, 4);
		const copy = copyViewForWrite(view);
		assert.equal(copy.byteLength, 2);
		assert.equal(copy.buffer.byteLength, 2);
		assert.deepEqual([...copy], [3, 4]);
		backing[2] = 9;
		assert.equal(copy[0], 3);
	});

	it('listOrphans matches a directory prefix, not a string prefix', async () => {
		const store = createMemoryOpfs();
		await store.writeFinal('x/job/a.bin', enc.encode('extract'));
		await store.writeFinal('xtra.bin', enc.encode('sibling'));
		await store.writeFinal('packs/pack_1.bin', enc.encode('pack'));
		const extract = await store.listOrphans('x');
		assert.deepEqual(extract.sort(), ['x/job/a.bin']);
		assert.equal(pathUnderPrefix('xtra.bin', 'x'), false);
		assert.equal(pathUnderPrefix('x/job/a.bin', 'x'), true);
		assert.equal(pathUnderPrefix('packs/pack_1.bin', 'packs'), true);
	});

	it('reading a missing path fails as OPFS_IO rather than returning empty', async () => {
		const store = createMemoryOpfs();
		await assert.rejects(
			() => store.read('blobs/nope.bin'),
			(e: unknown) => (e as { code?: string }).code === 'OPFS_IO'
		);
	});
});
