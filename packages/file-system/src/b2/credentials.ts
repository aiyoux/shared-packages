/**
 * IndexedDB store for hub B2 connection profiles.
 * Secrets never leave this origin; never log applicationKey.
 */
import { HUB_B2_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import {
	clearSessionSecret,
	getSessionSecret
} from '../vault/session.js';
import { materializeForWrite, readSecret, revealStoredSecret } from '../vault/secrets.js';
import type { SealedSecret } from '../vault/types.js';
import { looksLikeMasterApplicationKeyId, masterKeyIdError } from './keyScope.js';
import { ExplorerB2Error } from './errors.js';
import {
	HUB_B2_DB_NAME,
	HUB_B2_META,
	HUB_B2_STORE,
	normalizeNamePrefix,
	type B2ConnectionProfileV1,
	type HubB2Meta
} from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(HUB_B2_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(HUB_B2_STORE)) {
					db.createObjectStore(HUB_B2_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(HUB_B2_META)) {
					db.createObjectStore(HUB_B2_META, { keyPath: 'key' });
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

function storedSecretOf(row: B2ConnectionProfileV1) {
	return {
		persistSecret: row.persistSecret !== false,
		plaintext: row.applicationKey ?? '',
		sealed: row.sealedApplicationKey
	};
}

async function hydrate(row: B2ConnectionProfileV1): Promise<B2ConnectionProfileV1> {
	const applicationKey = await readSecret('b2', row.id, storedSecretOf(row));
	return { ...row, applicationKey };
}

export async function listStoredProfiles(): Promise<B2ConnectionProfileV1[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_B2_STORE, 'readonly');
		const req = tx.objectStore(HUB_B2_STORE).getAll();
		req.onsuccess = () => {
			const rows = (req.result as B2ConnectionProfileV1[]) ?? [];
			resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
		};
		req.onerror = () => reject(req.error);
	});
}

async function getRawProfile(id: string): Promise<B2ConnectionProfileV1 | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_B2_STORE, 'readonly');
		const req = tx.objectStore(HUB_B2_STORE).get(id);
		req.onsuccess = () => resolve(req.result as B2ConnectionProfileV1 | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function listProfiles(): Promise<B2ConnectionProfileV1[]> {
	const rows = await listStoredProfiles();
	return Promise.all(rows.map(hydrate));
}

export async function getProfile(id: string): Promise<B2ConnectionProfileV1 | undefined> {
	const raw = await getRawProfile(id);
	return raw ? hydrate(raw) : undefined;
}

export async function revealApplicationKey(profile: B2ConnectionProfileV1): Promise<string> {
	if (profile.applicationKey?.trim()) return profile.applicationKey;
	if (profile.persistSecret === false) {
		const s = getSessionSecret('b2', profile.id);
		if (s) return s;
	}
	const raw = await getRawProfile(profile.id);
	if (!raw) throw new ExplorerB2Error('B2_AUTH', 'That B2 connection was removed.');
	return revealStoredSecret('b2', raw.id, storedSecretOf(raw));
}

/** Vault rekey: overwrite secret fields without re-running materialize. */
export async function rewriteStoredSecret(
	id: string,
	secret: { persistSecret: boolean; plaintext: string; sealed?: SealedSecret }
): Promise<void> {
	const raw = await getRawProfile(id);
	if (!raw) return;
	const row: B2ConnectionProfileV1 = {
		...raw,
		persistSecret: secret.persistSecret,
		applicationKey: secret.plaintext,
		sealedApplicationKey: secret.sealed,
		updatedAt: Date.now()
	};
	if (!secret.sealed) delete row.sealedApplicationKey;
	const db = await openDb();
	const tx = db.transaction(HUB_B2_STORE, 'readwrite');
	tx.objectStore(HUB_B2_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
}

export async function saveProfile(
	profile: Omit<B2ConnectionProfileV1, 'v' | 'createdAt' | 'updatedAt'> & {
		createdAt?: number;
	}
): Promise<B2ConnectionProfileV1> {
	if (looksLikeMasterApplicationKeyId(profile.applicationKeyId)) {
		throw new ExplorerB2Error('B2_MASTER_KEY', masterKeyIdError());
	}
	const now = Date.now();
	const existing = await getRawProfile(profile.id);
	const mat = await materializeForWrite(
		'b2',
		profile.id,
		profile.applicationKey ?? '',
		profile.persistSecret,
		existing ? storedSecretOf(existing) : undefined
	);
	const row: B2ConnectionProfileV1 = {
		v: 1,
		id: profile.id,
		name: profile.name.trim(),
		applicationKeyId: profile.applicationKeyId.trim(),
		applicationKey: mat.idbPlaintext,
		bucketName: profile.bucketName.trim(),
		namePrefix: normalizeNamePrefix(profile.namePrefix) || undefined,
		persistSecret: mat.persistSecret,
		sealedApplicationKey: mat.sealed,
		createdAt: profile.createdAt ?? existing?.createdAt ?? now,
		updatedAt: now
	};
	if (!mat.sealed) delete row.sealedApplicationKey;
	const db = await openDb();
	const tx = db.transaction(HUB_B2_STORE, 'readwrite');
	tx.objectStore(HUB_B2_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
	return { ...row, applicationKey: mat.revealed || row.applicationKey };
}

export async function deleteProfile(id: string): Promise<void> {
	clearSessionSecret('b2', id);
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([HUB_B2_STORE, HUB_B2_META], 'readwrite');
		const metaStore = tx.objectStore(HUB_B2_META);
		const getReq = metaStore.get('active');
		getReq.onsuccess = () => {
			const m = getReq.result as { key: string; value: HubB2Meta } | undefined;
			tx.objectStore(HUB_B2_STORE).delete(id);
			if (m?.value?.activeProfileId === id) {
				metaStore.put({
					key: 'active',
					value: { activeProfileId: null } satisfies HubB2Meta
				});
			}
		};
		getReq.onerror = () => reject(getReq.error);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('deleteProfile aborted'));
	});
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
}

export async function getActiveProfileId(): Promise<string | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_B2_META, 'readonly');
		const req = tx.objectStore(HUB_B2_META).get('active');
		req.onsuccess = () => {
			const m = req.result as { key: string; value: HubB2Meta } | undefined;
			resolve(m?.value?.activeProfileId ?? null);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function setActiveProfileId(id: string | null): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(HUB_B2_META, 'readwrite');
	tx.objectStore(HUB_B2_META).put({
		key: 'active',
		value: { activeProfileId: id } satisfies HubB2Meta
	});
	await txDone(tx);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
}

/** Redact secrets for any debug export. */
export function redactProfile(p: B2ConnectionProfileV1): Omit<B2ConnectionProfileV1, 'applicationKey'> & {
	applicationKey: '***';
} {
	const { sealedApplicationKey: _sealed, ...rest } = p;
	return { ...rest, applicationKey: '***' };
}
