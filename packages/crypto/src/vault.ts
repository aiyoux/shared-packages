import { loadEngine } from './engines.js';
import {
	type EngineId,
	type KdfParams,
	type VaultEntry,
	type VaultKind,
	VAULT_EXTENSION
} from './types.js';

/** Scratch Pad Vault v1 — unique container, not zip/7z/age. */
export const VAULT_MAGIC = new TextEncoder().encode('SPVLT01\n');
export const INNER_SINGLE_MAGIC = new TextEncoder().encode('SPVLTsf1');
export const INNER_TREE_MAGIC = new TextEncoder().encode('SPVLTfs1');
export const VAULT_HEADER_SIZE = 64;
export const VAULT_VERSION = 1;

const ENGINE_BYTE: Record<EngineId, number> = { webcrypto: 1, libsodium: 2 };
const ENGINE_FROM_BYTE: Record<number, EngineId> = { 1: 'webcrypto', 2: 'libsodium' };
const KIND_BYTE: Record<VaultKind, number> = { single: 1, tree: 2 };
const KIND_FROM_BYTE: Record<number, VaultKind> = { 1: 'single', 2: 'tree' };

export type VaultHeader = {
	version: number;
	kind: VaultKind;
	engine: EngineId;
	kdf: KdfParams;
	salt: Uint8Array;
	nonce: Uint8Array;
};

export type SealOptions = {
	kind?: VaultKind;
	/** Override KDF cost (PBKDF2 iterations or Argon2 opslimit). */
	kdf?: KdfParams;
};

export type OpenedVault = {
	kind: VaultKind;
	engine: EngineId;
	entries: VaultEntry[];
};

function startsWith(bytes: Uint8Array, sig: Uint8Array): boolean {
	if (bytes.length < sig.length) return false;
	for (let i = 0; i < sig.length; i++) {
		if (bytes[i] !== sig[i]) return false;
	}
	return true;
}

export function isVaultBytes(bytes: Uint8Array): boolean {
	return startsWith(bytes, VAULT_MAGIC);
}

export function isVaultName(name: string): boolean {
	return name.toLowerCase().endsWith(VAULT_EXTENSION);
}

function assertSafePath(path: string): string {
	const trimmed = path.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!trimmed) throw new Error('Vault entry path is empty');
	if (trimmed.split('/').some((p) => p === '' || p === '.' || p === '..')) {
		throw new Error(`Unsafe vault path: ${path}`);
	}
	if (trimmed.length > 1024) throw new Error('Vault path is too long');
	return trimmed;
}

function writeHeader(engine: EngineId, kind: VaultKind, salt: Uint8Array, nonce: Uint8Array, kdf: KdfParams): Uint8Array {
	const header = new Uint8Array(VAULT_HEADER_SIZE);
	header.set(VAULT_MAGIC, 0);
	header[8] = VAULT_VERSION;
	header[9] = KIND_BYTE[kind];
	header[10] = ENGINE_BYTE[engine];
	header[11] = engine === 'libsodium' ? 2 : 1;
	const view = new DataView(header.buffer);
	view.setUint32(12, kdf.cost >>> 0, false);
	view.setUint32(16, (kdf.memory ?? 0) >>> 0, false);
	if (salt.length < 16) throw new Error('salt too short');
	header.set(salt.subarray(0, 16), 20);
	header.set(nonce.subarray(0, Math.min(nonce.length, 24)), 36);
	return header;
}

export function parseVaultHeader(bytes: Uint8Array): VaultHeader {
	if (!isVaultBytes(bytes)) throw new Error('Not a Scratch Pad vault (.spvault)');
	if (bytes.length < VAULT_HEADER_SIZE) throw new Error('Vault header is truncated');
	const version = bytes[8]!;
	if (version !== VAULT_VERSION) throw new Error(`Unsupported vault version ${version}`);
	const kind = KIND_FROM_BYTE[bytes[9]!];
	const engine = ENGINE_FROM_BYTE[bytes[10]!];
	if (!kind || !engine) throw new Error('Unknown vault kind or engine');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const cost = view.getUint32(12, false);
	const memory = view.getUint32(16, false);
	return {
		version,
		kind,
		engine,
		kdf: { cost, memory: memory || undefined },
		salt: bytes.slice(20, 36),
		nonce: bytes.slice(36, 60)
	};
}

function encodeEntries(kind: VaultKind, entries: VaultEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const packed = entries.map((e) => ({
		path: enc.encode(assertSafePath(e.path)),
		data: e.data
	}));
	let size = 8 + 4;
	for (const e of packed) size += 2 + e.path.length + 4 + e.data.length;
	const out = new Uint8Array(size);
	out.set(kind === 'tree' ? INNER_TREE_MAGIC : INNER_SINGLE_MAGIC, 0);
	const view = new DataView(out.buffer);
	view.setUint32(8, packed.length, false);
	let off = 12;
	for (const e of packed) {
		if (e.path.length > 0xffff) throw new Error('Path too long');
		if (e.data.length > 0xffffffff) throw new Error('File too large for vault v1');
		view.setUint16(off, e.path.length, false);
		off += 2;
		out.set(e.path, off);
		off += e.path.length;
		view.setUint32(off, e.data.length, false);
		off += 4;
		out.set(e.data, off);
		off += e.data.length;
	}
	return out;
}

function decodeEntries(plain: Uint8Array, expected: VaultKind): VaultEntry[] {
	const magic = expected === 'tree' ? INNER_TREE_MAGIC : INNER_SINGLE_MAGIC;
	if (!startsWith(plain, magic)) throw new Error('Vault payload is not a valid filesystem');
	if (plain.length < 12) throw new Error('Vault payload is truncated');
	const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
	const count = view.getUint32(8, false);
	const dec = new TextDecoder();
	const out: VaultEntry[] = [];
	let off = 12;
	for (let i = 0; i < count; i++) {
		if (off + 2 > plain.length) throw new Error('Vault payload is truncated');
		const pathLen = view.getUint16(off, false);
		off += 2;
		if (off + pathLen + 4 > plain.length) throw new Error('Vault payload is truncated');
		const path = assertSafePath(dec.decode(plain.subarray(off, off + pathLen)));
		off += pathLen;
		const dataLen = view.getUint32(off, false);
		off += 4;
		if (off + dataLen > plain.length) throw new Error('Vault payload is truncated');
		out.push({ path, data: plain.slice(off, off + dataLen) });
		off += dataLen;
	}
	return out;
}

export function resolveVaultKind(entries: VaultEntry[], requested?: VaultKind): VaultKind {
	if (requested) return requested;
	return entries.length === 1 ? 'single' : 'tree';
}

export function suggestVaultName(entries: VaultEntry[]): string {
	if (entries.length === 1) {
		const base = entries[0]!.path.replace(/^.*\//, '') || 'file';
		return `${base}${VAULT_EXTENSION}`;
	}
	return `vault${VAULT_EXTENSION}`;
}

export async function sealVault(
	engineId: EngineId,
	entries: VaultEntry[],
	password: string,
	options?: SealOptions
): Promise<{ name: string; data: Uint8Array; kind: VaultKind }> {
	if (!entries.length) throw new Error('Nothing to seal');
	if (!password) throw new Error('Password is required');
	const kind = resolveVaultKind(entries, options?.kind);
	if (kind === 'single' && entries.length !== 1) {
		throw new Error('Single-file vaults can hold exactly one file');
	}

	const engine = await loadEngine(engineId);
	const kdf = options?.kdf ?? engine.defaultKdf();
	const salt = engine.randomBytes(engine.saltLength);
	const nonce = engine.randomBytes(Math.max(engine.nonceLength, 24));
	const header = writeHeader(engineId, kind, salt, nonce, kdf);
	const aad = header.subarray(0, 20);
	const key = await engine.deriveKey(password, salt, kdf);
	const plain = encodeEntries(kind, entries);
	const cipher = await engine.encrypt(plain, key, nonce, aad);
	const data = new Uint8Array(header.length + cipher.length);
	data.set(header, 0);
	data.set(cipher, header.length);
	return { name: suggestVaultName(entries), data, kind };
}

export async function openVault(bytes: Uint8Array, password: string): Promise<OpenedVault> {
	if (!password) throw new Error('Password is required');
	const header = parseVaultHeader(bytes);
	const engine = await loadEngine(header.engine);
	const aad = bytes.subarray(0, 20);
	const key = await engine.deriveKey(password, header.salt, header.kdf);
	const cipher = bytes.subarray(VAULT_HEADER_SIZE);
	const plain = await engine.decrypt(cipher, key, header.nonce, aad);
	const entries = decodeEntries(plain, header.kind);
	return { kind: header.kind, engine: header.engine, entries };
}
