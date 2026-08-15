import { engineInfo, type CryptoEngine, type HashAlg, type KdfParams } from '../types.js';

const WEB_HASH: Record<Exclude<HashAlg, 'blake2b'>, string> = {
	sha256: 'SHA-256',
	sha384: 'SHA-384',
	sha512: 'SHA-512'
};

function subtle(): SubtleCrypto {
	const c = globalThis.crypto?.subtle;
	if (!c) throw new Error('Web Crypto SubtleCrypto is not available');
	return c;
}

function asBuf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
/** Fast enough for unit tests; never used as the production default. */
export const TEST_PBKDF2_ITERATIONS = 1_000;

export const webcryptoEngine: CryptoEngine = {
	info: engineInfo('webcrypto'),
	nonceLength: 12,
	saltLength: 16,

	async load() {
		void subtle();
	},

	randomBytes(n: number) {
		return globalThis.crypto.getRandomValues(new Uint8Array(n));
	},

	async hash(bytes, alg) {
		if (alg === 'blake2b') throw new Error('Web Crypto cannot hash with BLAKE2b');
		const digest = await subtle().digest(WEB_HASH[alg], asBuf(bytes));
		return new Uint8Array(digest);
	},

	async deriveKey(password, salt, params) {
		const base = await subtle().importKey(
			'raw',
			new TextEncoder().encode(password),
			'PBKDF2',
			false,
			['deriveBits']
		);
		const bits = await subtle().deriveBits(
			{
				name: 'PBKDF2',
				salt: asBuf(salt),
				iterations: Math.max(1, params.cost),
				hash: 'SHA-256'
			},
			base,
			256
		);
		return new Uint8Array(bits);
	},

	async encrypt(plaintext, keyBytes, nonce, aad) {
		const key = await subtle().importKey('raw', asBuf(keyBytes), { name: 'AES-GCM' }, false, [
			'encrypt'
		]);
		const iv = asBuf(nonce.subarray(0, 12));
		const ct = await subtle().encrypt(
			{ name: 'AES-GCM', iv, additionalData: aad ? asBuf(aad) : undefined, tagLength: 128 },
			key,
			asBuf(plaintext)
		);
		return new Uint8Array(ct);
	},

	async decrypt(ciphertext, keyBytes, nonce, aad) {
		const key = await subtle().importKey('raw', asBuf(keyBytes), { name: 'AES-GCM' }, false, [
			'decrypt'
		]);
		const iv = asBuf(nonce.subarray(0, 12));
		try {
			const pt = await subtle().decrypt(
				{ name: 'AES-GCM', iv, additionalData: aad ? asBuf(aad) : undefined, tagLength: 128 },
				key,
				asBuf(ciphertext)
			);
			return new Uint8Array(pt);
		} catch {
			throw new Error('Decryption failed — wrong password or corrupted vault');
		}
	},

	defaultKdf(): KdfParams {
		return { cost: DEFAULT_PBKDF2_ITERATIONS };
	}
};
