import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryOpfs } from '../src/opfs.ts';

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

	it('reading a missing path fails as OPFS_IO rather than returning empty', async () => {
		const store = createMemoryOpfs();
		await assert.rejects(
			() => store.read('blobs/nope.bin'),
			(e: unknown) => (e as { code?: string }).code === 'OPFS_IO'
		);
	});
});
