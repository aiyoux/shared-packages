export {
	DEFAULT_ENGINE,
	DEFAULT_HASH,
	ENGINE_CATALOG,
	HASH_LABEL,
	VAULT_EXTENSION,
	defaultHashFor,
	engineInfo,
	engineSupportsHash,
	type CryptoEngine,
	type EngineId,
	type EngineInfo,
	type HashAlg,
	type KdfParams,
	type VaultEntry,
	type VaultKind
} from './types.js';

export { listEngines, loadEngine, peekEngine } from './engines.js';

export {
	bytesToHex,
	hashBytes,
	hexToBytes,
	timingSafeEqual,
	timingSafeEqualHex,
	verifyHash,
	type HashResult
} from './hash.js';

export {
	base64urlToBytes,
	base64urlToUint8,
	bytesToBase64url,
	uint8ToBase64url
} from './base64url.js';

export {
	HASH_SLICE_BYTES,
	SUBTLE_DIGEST_MAX_BYTES,
	Sha256,
	createSha256,
	sha256Blob,
	sha256BlobStreaming,
	sha256Chunks,
	sha256FileStreaming,
	sha256Uint8
} from './sha256.js';

export {
	DEFAULT_FILE_DIGEST_ALG,
	FILE_DIGEST_LABEL,
	createFileDigest,
	digestChunks,
	digestFileStreaming,
	isFileDigestAlg,
	type FileDigestAlg,
	type IncrementalDigest
} from './digest.js';

export {
	INNER_SINGLE_MAGIC,
	INNER_TREE_MAGIC,
	VAULT_HEADER_SIZE,
	VAULT_MAGIC,
	VAULT_VERSION,
	isVaultBytes,
	isVaultName,
	openVault,
	parseVaultHeader,
	resolveVaultKind,
	sealVault,
	suggestVaultName,
	type OpenedVault,
	type SealOptions,
	type VaultHeader
} from './vault.js';
