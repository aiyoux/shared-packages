/**
 * IndexedDB store for hub B2 connection profiles (plaintext v1).
 * Secrets never leave this origin; never log applicationKey.
 */
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

export async function listProfiles(): Promise<B2ConnectionProfileV1[]> {
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

export async function getProfile(id: string): Promise<B2ConnectionProfileV1 | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_B2_STORE, 'readonly');
		const req = tx.objectStore(HUB_B2_STORE).get(id);
		req.onsuccess = () => resolve(req.result as B2ConnectionProfileV1 | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function saveProfile(
	profile: Omit<B2ConnectionProfileV1, 'v' | 'createdAt' | 'updatedAt'> & {
		createdAt?: number;
	}
): Promise<B2ConnectionProfileV1> {
	const now = Date.now();
	const row: B2ConnectionProfileV1 = {
		v: 1,
		id: profile.id,
		name: profile.name.trim(),
		applicationKeyId: profile.applicationKeyId.trim(),
		applicationKey: profile.applicationKey,
		bucketName: profile.bucketName.trim(),
		namePrefix: normalizeNamePrefix(profile.namePrefix) || undefined,
		createdAt: profile.createdAt ?? now,
		updatedAt: now
	};
	const db = await openDb();
	const tx = db.transaction(HUB_B2_STORE, 'readwrite');
	tx.objectStore(HUB_B2_STORE).put(row);
	await txDone(tx);
	return row;
}

export async function deleteProfile(id: string): Promise<void> {
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
}

/** Redact secrets for any debug export. */
export function redactProfile(p: B2ConnectionProfileV1): Omit<B2ConnectionProfileV1, 'applicationKey'> & {
	applicationKey: '***';
} {
	return { ...p, applicationKey: '***' };
}
