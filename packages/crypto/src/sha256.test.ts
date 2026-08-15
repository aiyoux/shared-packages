import { describe, expect, it } from 'vitest';
import { createSha256, sha256Chunks, sha256Uint8 } from './sha256.js';

const ABC = new TextEncoder().encode('abc');
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('incremental SHA-256', () => {
	it('matches empty and abc vectors', async () => {
		expect(createSha256().digestHex()).toBe(SHA256_EMPTY);
		expect(createSha256().update(ABC).digestHex()).toBe(SHA256_ABC);
		expect(await sha256Uint8(ABC)).toBe(SHA256_ABC);
	});

	it('hashes split chunks the same as one buffer', async () => {
		const data = new Uint8Array(300);
		for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
		const whole = createSha256().update(data).digestHex();
		expect(await sha256Chunks([data.subarray(0, 80), data.subarray(80)])).toBe(whole);
	});
});
