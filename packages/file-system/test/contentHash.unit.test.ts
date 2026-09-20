import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/contentHash.ts';

describe('sha256Hex', () => {
	it('matches the empty and abc NIST vectors', async () => {
		assert.equal(
			await sha256Hex(new Uint8Array()),
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		assert.equal(
			await sha256Hex(new TextEncoder().encode('abc')),
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('hashes a subarray without including neighbouring bytes', async () => {
		const buf = new Uint8Array([0, 97, 98, 99, 0]);
		assert.equal(await sha256Hex(buf.subarray(1, 4)), await sha256Hex(new TextEncoder().encode('abc')));
	});
});
