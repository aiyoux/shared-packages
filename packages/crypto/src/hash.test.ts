import { describe, expect, it } from 'vitest';
import { hashBytes, verifyHash } from './hash.js';
import { DEFAULT_HASH, ENGINE_CATALOG, engineSupportsHash } from './types.js';
import { listEngines } from './engines.js';

const ABC = new TextEncoder().encode('abc');
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('catalog', () => {
	it('lists Web Crypto and libsodium', () => {
		expect(listEngines().map((e) => e.id)).toEqual(['webcrypto', 'libsodium']);
		expect(ENGINE_CATALOG).toHaveLength(2);
		expect(engineSupportsHash('webcrypto', 'blake2b')).toBe(false);
		expect(engineSupportsHash('webcrypto', 'blake3')).toBe(true);
		expect(engineSupportsHash('libsodium', 'blake2b')).toBe(true);
		expect(engineSupportsHash('libsodium', 'blake3')).toBe(true);
		expect(DEFAULT_HASH).toBe('sha256');
	});
});

describe('hashBytes', () => {
	it('matches the SHA-256 vector on Web Crypto', async () => {
		const got = await hashBytes('webcrypto', ABC, 'sha256');
		expect(got.hex).toBe(SHA256_ABC);
	});

	it('matches the same vector on libsodium', async () => {
		const got = await hashBytes('libsodium', ABC, 'sha256');
		expect(got.hex).toBe(SHA256_ABC);
	});

	it('verifies and rejects a mismatch', async () => {
		const ok = await verifyHash('webcrypto', ABC, SHA256_ABC, 'sha256');
		expect(ok.ok).toBe(true);
		const bad = await verifyHash('webcrypto', ABC, '00'.repeat(32), 'sha256');
		expect(bad.ok).toBe(false);
	});

	it('hashes with BLAKE2b on libsodium only', async () => {
		const got = await hashBytes('libsodium', ABC, 'blake2b');
		expect(got.bytes.byteLength).toBe(32);
		await expect(hashBytes('webcrypto', ABC, 'blake2b')).rejects.toThrow(/does not support/);
	});

	it('hashes with BLAKE3 on both engines', async () => {
		const expected = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';
		const web = await hashBytes('webcrypto', ABC, 'blake3');
		expect(web.hex).toBe(expected);
		const sodium = await hashBytes('libsodium', ABC, 'blake3');
		expect(sodium.hex).toBe(expected);
	});
});
