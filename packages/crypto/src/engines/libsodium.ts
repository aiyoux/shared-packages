import { engineInfo, type CryptoEngine, type HashAlg, type KdfParams } from '../types.js';

type Sodium = typeof import('libsodium-wrappers-sumo');

let sodium: Sodium | null = null;

async function get(): Promise<Sodium> {
	if (!sodium) {
		const mod = await import('libsodium-wrappers-sumo');
		const s = (mod.default ?? mod) as Sodium;
		await s.ready;
		sodium = s;
	}
	return sodium;
}

export const sodiumEngine: CryptoEngine = {
	info: engineInfo('libsodium'),
	nonceLength: 24,
	saltLength: 16,

	async load() {
		await get();
	},

	randomBytes(n: number) {
		if (!sodium) throw new Error('libsodium is not loaded');
		return sodium.randombytes_buf(n);
	},

	async hash(bytes, alg: HashAlg) {
		const s = await get();
		if (alg === 'sha256') return s.crypto_hash_sha256(bytes);
		if (alg === 'sha512') return s.crypto_hash_sha512(bytes);
		if (alg === 'blake2b') return s.crypto_generichash(32, bytes, null);
		throw new Error(`libsodium cannot hash with ${alg}`);
	},

	async deriveKey(password, salt, params) {
		const s = await get();
		const ops = Math.max(s.crypto_pwhash_OPSLIMIT_MIN, params.cost);
		const mem = Math.max(
			s.crypto_pwhash_MEMLIMIT_MIN,
			params.memory ?? s.crypto_pwhash_MEMLIMIT_INTERACTIVE
		);
		return s.crypto_pwhash(
			32,
			password,
			salt,
			ops,
			mem,
			s.crypto_pwhash_ALG_ARGON2ID13
		);
	},

	async encrypt(plaintext, key, nonce, aad) {
		const s = await get();
		return s.crypto_aead_xchacha20poly1305_ietf_encrypt(
			plaintext,
			aad ?? null,
			null,
			nonce.subarray(0, 24),
			key
		);
	},

	async decrypt(ciphertext, key, nonce, aad) {
		const s = await get();
		try {
			return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
				null,
				ciphertext,
				aad ?? null,
				nonce.subarray(0, 24),
				key
			);
		} catch {
			throw new Error('Decryption failed — wrong password or corrupted vault');
		}
	},

	defaultKdf(): KdfParams {
		if (!sodium) {
			// INTERACTIVE-ish defaults; refined after load.
			return { cost: 2, memory: 8 * 1024 * 1024 };
		}
		return {
			cost: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
			memory: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
		};
	}
};

export async function sodiumTestKdf(): Promise<KdfParams> {
	const s = await get();
	return { cost: s.crypto_pwhash_OPSLIMIT_MIN, memory: s.crypto_pwhash_MEMLIMIT_MIN };
}
