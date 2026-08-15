export type EngineId = 'webcrypto' | 'libsodium';

export type HashAlg = 'sha256' | 'sha384' | 'sha512' | 'blake2b';

export type VaultKind = 'single' | 'tree';

export type VaultEntry = {
	path: string;
	data: Uint8Array;
};

export type EngineInfo = {
	id: EngineId;
	label: string;
	description: string;
	hashes: readonly HashAlg[];
	aead: string;
	kdf: string;
};

export type KdfParams = {
	/** PBKDF2 iteration count, or Argon2 opslimit. */
	cost: number;
	/** Argon2 memlimit in bytes. Ignored by PBKDF2. */
	memory?: number;
};

export interface CryptoEngine {
	readonly info: EngineInfo;
	readonly nonceLength: number;
	readonly saltLength: number;
	load(): Promise<void>;
	randomBytes(n: number): Uint8Array;
	hash(bytes: Uint8Array, alg: HashAlg): Promise<Uint8Array>;
	deriveKey(password: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array>;
	encrypt(
		plaintext: Uint8Array,
		key: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array
	): Promise<Uint8Array>;
	decrypt(
		ciphertext: Uint8Array,
		key: Uint8Array,
		nonce: Uint8Array,
		aad?: Uint8Array
	): Promise<Uint8Array>;
	defaultKdf(): KdfParams;
}

export const ENGINE_CATALOG: readonly EngineInfo[] = [
	{
		id: 'webcrypto',
		label: 'Web Crypto',
		description: 'Browser-native SubtleCrypto — SHA-2 and AES-256-GCM. No extra download.',
		hashes: ['sha256', 'sha384', 'sha512'],
		aead: 'AES-256-GCM',
		kdf: 'PBKDF2-SHA-256'
	},
	{
		id: 'libsodium',
		label: 'libsodium',
		description: 'libsodium WASM — BLAKE2b, Argon2id, and XChaCha20-Poly1305.',
		hashes: ['sha256', 'sha512', 'blake2b'],
		aead: 'XChaCha20-Poly1305',
		kdf: 'Argon2id'
	}
] as const;

export const DEFAULT_ENGINE: EngineId = 'webcrypto';
export const DEFAULT_HASH: HashAlg = 'sha256';

export const HASH_LABEL: Record<HashAlg, string> = {
	sha256: 'SHA-256',
	sha384: 'SHA-384',
	sha512: 'SHA-512',
	blake2b: 'BLAKE2b'
};

export const VAULT_EXTENSION = '.spvault';

export function engineInfo(id: EngineId): EngineInfo {
	const found = ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown crypto engine: ${id}`);
	return found;
}

export function engineSupportsHash(id: EngineId, alg: HashAlg): boolean {
	return engineInfo(id).hashes.includes(alg);
}

export function defaultHashFor(id: EngineId): HashAlg {
	return engineInfo(id).hashes.includes('sha256') ? 'sha256' : engineInfo(id).hashes[0]!;
}
