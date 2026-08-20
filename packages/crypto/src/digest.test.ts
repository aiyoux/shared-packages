import { describe, expect, it } from 'vitest';
import { createFileDigest, digestChunks, digestFileStreaming } from './digest.js';

const ABC = new TextEncoder().encode('abc');
const BLAKE3_EMPTY = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262';
const BLAKE3_ABC = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('BLAKE3 digest', () => {
	it('matches empty and abc vectors', async () => {
		expect((await createFileDigest('blake3')).digestHex()).toBe(BLAKE3_EMPTY);
		expect((await createFileDigest('blake3')).update(ABC).digestHex()).toBe(BLAKE3_ABC);
	});

	it('hashes split chunks the same as one buffer', async () => {
		const data = new Uint8Array(300);
		for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
		const whole = (await createFileDigest('blake3')).update(data).digestHex();
		expect(await digestChunks([data.subarray(0, 80), data.subarray(80)], 'blake3')).toBe(whole);
	});

	it('streams a blob', async () => {
		const data = new Uint8Array(200_000);
		for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
		const expected = (await createFileDigest('blake3')).update(data).digestHex();
		expect(await digestFileStreaming(new Blob([data]), 'blake3', 32 * 1024)).toBe(expected);
	});
});

describe('SHA-256 via createFileDigest', () => {
	it('matches the abc vector', async () => {
		expect((await createFileDigest('sha256')).update(ABC).digestHex()).toBe(SHA256_ABC);
	});
});
