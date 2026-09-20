/**
 * IndexedDB store for hub AI connection profiles.
 * Secrets never leave this origin; never log apiKey.
 */
import { HUB_AI_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import { clearSessionSecret, getSessionSecret } from '../vault/session.js';
import { materializeForWrite, readSecret, revealStoredSecret } from '../vault/secrets.js';
import type { SealedSecret } from '../vault/types.js';
import { AiCredentialsError } from './errors.js';
import {
	HUB_AI_DB_NAME,
	HUB_AI_META,
	HUB_AI_STORE,
	normalizeAiBaseUrl,
	type AiConnectionProfileV1,
	type HubAiMeta
} from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(HUB_AI_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(HUB_AI_STORE)) {
					db.createObjectStore(HUB_AI_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(HUB_AI_META)) {
					db.createObjectStore(HUB_AI_META, { keyPath: 'key' });
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

/** Test helper: close connection so deleteDatabase can complete. */
export async function closeCredentialsDbForTests(): Promise<void> {
	if (!dbPromise) return;
	try {
		const db = await dbPromise;
		db.close();
	} catch {
		/* ignore */
	}
	dbPromise = null;
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

function storedSecretOf(row: AiConnectionProfileV1) {
	return {
		persistSecret: row.persistSecret !== false,
		plaintext: row.apiKey ?? '',
		sealed: row.sealedApiKey
	};
}

async function hydrate(row: AiConnectionProfileV1): Promise<AiConnectionProfileV1> {
	const apiKey = await readSecret('ai', row.id, storedSecretOf(row));
	return { ...row, apiKey };
}

export async function listStoredProfiles(): Promise<AiConnectionProfileV1[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readonly');
		const req = tx.objectStore(HUB_AI_STORE).getAll();
		req.onsuccess = () => {
			const rows = (req.result as AiConnectionProfileV1[]) ?? [];
			resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
		};
		req.onerror = () => reject(req.error);
	});
}

async function getRawProfile(id: string): Promise<AiConnectionProfileV1 | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readonly');
		const req = tx.objectStore(HUB_AI_STORE).get(id);
		req.onsuccess = () => resolve(req.result as AiConnectionProfileV1 | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function listProfiles(): Promise<AiConnectionProfileV1[]> {
	const rows = await listStoredProfiles();
	return Promise.all(rows.map(hydrate));
}

export async function getProfile(id: string): Promise<AiConnectionProfileV1 | undefined> {
	const raw = await getRawProfile(id);
	return raw ? hydrate(raw) : undefined;
}

/**
 * Reveal the API key for a chat call. Throws `VaultLockedError` /
 * `SecretUnavailableError` instead of silently returning '' — callers must
 * surface "unlock the vault", never send an empty key.
 */
export async function revealApiKey(profile: AiConnectionProfileV1): Promise<string> {
	if (profile.apiKey?.trim()) return profile.apiKey;
	if (profile.persistSecret === false) {
		const s = getSessionSecret('ai', profile.id);
		if (s) return s;
	}
	const raw = await getRawProfile(profile.id);
	if (!raw) throw new AiCredentialsError('AI_NOT_FOUND', 'That AI connection was removed.');
	return revealStoredSecret('ai', raw.id, storedSecretOf(raw));
}

/** Vault rekey: overwrite secret fields without re-running materialize. */
export async function rewriteStoredSecret(
	id: string,
	secret: { persistSecret: boolean; plaintext: string; sealed?: SealedSecret }
): Promise<void> {
	const raw = await getRawProfile(id);
	if (!raw) return;
	const row: AiConnectionProfileV1 = {
		...raw,
		persistSecret: secret.persistSecret,
		apiKey: secret.plaintext,
		sealedApiKey: secret.sealed,
		updatedAt: Date.now()
	};
	if (!secret.sealed) delete row.sealedApiKey;
	const db = await openDb();
	const tx = db.transaction(HUB_AI_STORE, 'readwrite');
	tx.objectStore(HUB_AI_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
}

export async function saveProfile(
	profile: Omit<AiConnectionProfileV1, 'v' | 'createdAt' | 'updatedAt'> & {
		createdAt?: number;
	}
): Promise<AiConnectionProfileV1> {
	const now = Date.now();
	const existing = await getRawProfile(profile.id);
	const mat = await materializeForWrite(
		'ai',
		profile.id,
		profile.apiKey ?? '',
		profile.persistSecret,
		existing ? storedSecretOf(existing) : undefined
	);
	const row: AiConnectionProfileV1 = {
		v: 1,
		id: profile.id,
		name: profile.name.trim(),
		baseUrl: normalizeAiBaseUrl(profile.baseUrl),
		apiKey: mat.idbPlaintext,
		model: profile.model.trim(),
		persistSecret: mat.persistSecret,
		sealedApiKey: mat.sealed,
		createdAt: profile.createdAt ?? existing?.createdAt ?? now,
		updatedAt: now
	};
	if (!mat.sealed) delete row.sealedApiKey;
	const db = await openDb();
	const tx = db.transaction(HUB_AI_STORE, 'readwrite');
	tx.objectStore(HUB_AI_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
	return { ...row, apiKey: mat.revealed || row.apiKey };
}

export async function deleteProfile(id: string): Promise<void> {
	clearSessionSecret('ai', id);
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([HUB_AI_STORE, HUB_AI_META], 'readwrite');
		const metaStore = tx.objectStore(HUB_AI_META);
		const getReq = metaStore.get('active');
		getReq.onsuccess = () => {
			const m = getReq.result as { key: string; value: HubAiMeta } | undefined;
			tx.objectStore(HUB_AI_STORE).delete(id);
			if (m?.value?.activeProfileId === id) {
				metaStore.put({
					key: 'active',
					value: { activeProfileId: null } satisfies HubAiMeta
				});
			}
		};
		getReq.onerror = () => reject(getReq.error);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('deleteProfile aborted'));
	});
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
}

export async function getActiveProfileId(): Promise<string | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_AI_META, 'readonly');
		const req = tx.objectStore(HUB_AI_META).get('active');
		req.onsuccess = () => {
			const m = req.result as { key: string; value: HubAiMeta } | undefined;
			resolve(m?.value?.activeProfileId ?? null);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function setActiveProfileId(id: string | null): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(HUB_AI_META, 'readwrite');
	tx.objectStore(HUB_AI_META).put({
		key: 'active',
		value: { activeProfileId: id } satisfies HubAiMeta
	});
	await txDone(tx);
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
}

/** Redact secrets for any debug export. */
export function redactProfile(p: AiConnectionProfileV1): Omit<AiConnectionProfileV1, 'apiKey'> & {
	apiKey: '***';
} {
	const { sealedApiKey: _sealed, ...rest } = p;
	return { ...rest, apiKey: '***' };
}