/**
 * HubVault IndexedDB: enabled flag, KDF salt, passphrase verifier.
 */
import { HUB_VAULT_CHANNEL, notifyTabChannel } from '../crossTab.js';
import { loadEngine } from '@shared-packages/crypto';
import {
	base64urlToBytes,
	bytesToBase64url,
	getVaultKdfCost,
	VERIFIER_BINDING,
	VERIFIER_PLAIN,
	wrapSecret
} from './crypto.js';
import {
	clearWrappingKey,
	getWrappingKey,
	isVaultUnlocked,
	notifyVaultSession,
	resetVaultSessionForTests,
	setWrappingKey
} from './session.js';
import {
	HUB_VAULT_DB_NAME,
	HUB_VAULT_META_KEY,
	HUB_VAULT_STORE,
	VaultLockedError,
	VaultWrongPassphraseError,
	type VaultMetaV1
} from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;
let enabledCache: boolean | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(HUB_VAULT_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(HUB_VAULT_STORE)) {
					db.createObjectStore(HUB_VAULT_STORE, { keyPath: 'key' });
				}
			};
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					db.close();
					dbPromise = null;
				};
				resolve(db);
			};
			req.onerror = () => {
				dbPromise = null;
				reject(req.error);
			};
		});
	}
	return dbPromise;
}

export async function closeVaultDbForTests(): Promise<void> {
	if (!dbPromise) return;
	try {
		const db = await dbPromise;
		db.close();
	} catch {
		/* ignore */
	}
	dbPromise = null;
	enabledCache = null;
	resetVaultSessionForTests();
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function getMeta(): Promise<VaultMetaV1 | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_VAULT_STORE, 'readonly');
		const req = tx.objectStore(HUB_VAULT_STORE).get(HUB_VAULT_META_KEY);
		req.onsuccess = () => {
			const row = req.result as { key: string; value: VaultMetaV1 } | VaultMetaV1 | undefined;
			if (!row) {
				resolve(null);
				return;
			}
			const value = 'value' in row ? row.value : row;
			resolve(value?.enabled ? value : null);
		};
		req.onerror = () => reject(req.error);
	});
}

async function putMeta(meta: VaultMetaV1 | null): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(HUB_VAULT_STORE, 'readwrite');
	if (meta) {
		tx.objectStore(HUB_VAULT_STORE).put({ key: HUB_VAULT_META_KEY, value: meta });
	} else {
		tx.objectStore(HUB_VAULT_STORE).delete(HUB_VAULT_META_KEY);
	}
	await txDone(tx);
}

export async function isVaultEnabled(): Promise<boolean> {
	if (enabledCache !== null) return enabledCache;
	const meta = await getMeta();
	enabledCache = !!meta;
	return enabledCache;
}

export { isVaultUnlocked };

export type VaultStatus = {
	enabled: boolean;
	unlocked: boolean;
};

export async function getVaultStatus(): Promise<VaultStatus> {
	return { enabled: await isVaultEnabled(), unlocked: isVaultUnlocked() };
}

async function deriveWrappingKey(passphrase: string, salt: Uint8Array, cost: number): Promise<Uint8Array> {
	const engine = await loadEngine('webcrypto');
	return engine.deriveKey(passphrase, salt, { cost });
}

function assertPassphrase(passphrase: string): string {
	const p = passphrase.trim();
	if (p.length < 8) throw new Error('Passphrase must be at least 8 characters.');
	return p;
}

/**
 * Turn on at-rest wrapping. Existing persisted B2/rclone secrets are re-sealed
 * and plaintext fields are wiped. Requires a new passphrase (vault must be off).
 */
export async function enableVault(passphrase: string): Promise<void> {
	const pass = assertPassphrase(passphrase);
	if (await isVaultEnabled()) throw new Error('Connection vault is already enabled.');
	const engine = await loadEngine('webcrypto');
	const salt = engine.randomBytes(engine.saltLength);
	const kdfCost = getVaultKdfCost();
	const key = await deriveWrappingKey(pass, salt, kdfCost);
	setWrappingKey(key);
	const verifier = await wrapSecret(VERIFIER_PLAIN, VERIFIER_BINDING);
	const meta: VaultMetaV1 = {
		v: 1,
		enabled: true,
		saltB64: bytesToBase64url(salt),
		verifierIvB64: verifier.iv,
		verifierCtB64: verifier.ct,
		kdfCost
	};
	await putMeta(meta);
	enabledCache = true;
	const { resealPersistedSecrets } = await import('./rekey.js');
	await resealPersistedSecrets();
	notifyTabChannel(HUB_VAULT_CHANNEL);
	notifyVaultSession();
}

/**
 * Decrypt every persisted secret back to plaintext and forget the vault.
 * Must be unlocked.
 */
export async function disableVault(): Promise<void> {
	if (!(await isVaultEnabled())) return;
	if (!isVaultUnlocked()) throw new VaultLockedError('Unlock the vault before turning encryption off.');
	const { unsealPersistedSecrets } = await import('./rekey.js');
	await unsealPersistedSecrets();
	await putMeta(null);
	enabledCache = false;
	clearWrappingKey();
	notifyTabChannel(HUB_VAULT_CHANNEL);
	notifyVaultSession();
}

export async function unlockVault(passphrase: string): Promise<void> {
	const pass = passphrase.trim();
	if (!pass) throw new VaultWrongPassphraseError();
	const meta = await getMeta();
	if (!meta) throw new Error('Connection vault is not enabled.');
	const key = await deriveWrappingKey(pass, base64urlToBytes(meta.saltB64), meta.kdfCost);
	setWrappingKey(key);
	try {
		const { unwrapSecret } = await import('./crypto.js');
		const plain = await unwrapSecret(
			{ v: 1, iv: meta.verifierIvB64, ct: meta.verifierCtB64 },
			VERIFIER_BINDING
		);
		if (plain !== VERIFIER_PLAIN) throw new VaultWrongPassphraseError();
	} catch (e) {
		clearWrappingKey();
		if (e instanceof VaultWrongPassphraseError) throw e;
		throw new VaultWrongPassphraseError();
	}
	notifyTabChannel(HUB_VAULT_CHANNEL);
	notifyVaultSession();
}

/**
 * Drop the wrapping key and evict authorized B2/rclone sessions in this tab.
 * Encrypted IDB rows stay; session-only secrets stay (they were never on disk).
 */
export async function lockVault(): Promise<void> {
	clearWrappingKey();
	const { evictRemoteSessions } = await import('./rekey.js');
	evictRemoteSessions();
	notifyTabChannel(HUB_VAULT_CHANNEL);
	notifyVaultSession();
}

/** Refresh enabledCache from IDB (other tab enabled/disabled). */
export async function syncVaultFromIdb(): Promise<void> {
	const meta = await getMeta();
	const enabled = !!meta;
	enabledCache = enabled;
	if (!enabled) clearWrappingKey();
}

export function peekWrappingKeyForTests(): Uint8Array | null {
	return getWrappingKey();
}
