/**
 * IndexedDB store for hub monitor connection profiles.
 */
import { HUB_MONITOR_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import {
	DEFAULT_MONITOR_BASE_URL,
	HUB_MONITOR_DB_NAME,
	HUB_MONITOR_META,
	HUB_MONITOR_STORE,
	normalizeMonitorRootPath,
	type HubMonitorMeta,
	type MonitorConnectionProfileV1
} from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(HUB_MONITOR_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(HUB_MONITOR_STORE)) {
					db.createObjectStore(HUB_MONITOR_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(HUB_MONITOR_META)) {
					db.createObjectStore(HUB_MONITOR_META, { keyPath: 'key' });
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

export async function listProfiles(): Promise<MonitorConnectionProfileV1[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_MONITOR_STORE, 'readonly');
		const req = tx.objectStore(HUB_MONITOR_STORE).getAll();
		req.onsuccess = () => {
			const rows = (req.result as MonitorConnectionProfileV1[]) ?? [];
			resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
		};
		req.onerror = () => reject(req.error);
	});
}

export async function getProfile(id: string): Promise<MonitorConnectionProfileV1 | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_MONITOR_STORE, 'readonly');
		const req = tx.objectStore(HUB_MONITOR_STORE).get(id);
		req.onsuccess = () => resolve(req.result as MonitorConnectionProfileV1 | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function saveProfile(
	profile: Omit<MonitorConnectionProfileV1, 'v' | 'createdAt' | 'updatedAt'> & {
		createdAt?: number;
	}
): Promise<MonitorConnectionProfileV1> {
	const now = Date.now();
	const existing = await getProfile(profile.id);
	const rootPath = normalizeMonitorRootPath(profile.rootPath);
	const row: MonitorConnectionProfileV1 = {
		v: 1,
		id: profile.id,
		name: profile.name.trim(),
		baseUrl: (profile.baseUrl || DEFAULT_MONITOR_BASE_URL).trim(),
		rootPath,
		createdAt: existing?.createdAt ?? profile.createdAt ?? now,
		updatedAt: now
	};
	const db = await openDb();
	const tx = db.transaction(HUB_MONITOR_STORE, 'readwrite');
	tx.objectStore(HUB_MONITOR_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_MONITOR_PROFILES_CHANNEL);
	return row;
}

export async function deleteProfile(id: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction([HUB_MONITOR_STORE, HUB_MONITOR_META], 'readwrite');
	tx.objectStore(HUB_MONITOR_STORE).delete(id);
	const metaReq = tx.objectStore(HUB_MONITOR_META).get('active');
	await new Promise<void>((resolve, reject) => {
		metaReq.onsuccess = () => {
			const row = metaReq.result as { key: string; value: HubMonitorMeta } | undefined;
			if (row?.value?.activeProfileId === id) {
				tx.objectStore(HUB_MONITOR_META).put({
					key: 'active',
					value: { activeProfileId: null } satisfies HubMonitorMeta
				});
			}
			resolve();
		};
		metaReq.onerror = () => reject(metaReq.error);
	});
	await txDone(tx);
	notifyTabChannel(HUB_MONITOR_PROFILES_CHANNEL);
}

export async function getActiveProfileId(): Promise<string | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_MONITOR_META, 'readonly');
		const req = tx.objectStore(HUB_MONITOR_META).get('active');
		req.onsuccess = () => {
			const row = req.result as { key: string; value: HubMonitorMeta } | undefined;
			resolve(row?.value?.activeProfileId ?? null);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function setActiveProfileId(id: string | null): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(HUB_MONITOR_META, 'readwrite');
	tx.objectStore(HUB_MONITOR_META).put({
		key: 'active',
		value: { activeProfileId: id } satisfies HubMonitorMeta
	});
	await txDone(tx);
	notifyTabChannel(HUB_MONITOR_PROFILES_CHANNEL);
}

export function redactProfile(p: MonitorConnectionProfileV1): MonitorConnectionProfileV1 {
	return { ...p };
}
