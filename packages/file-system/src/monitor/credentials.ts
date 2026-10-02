/**
 * IndexedDB store for hub monitor connection profiles.
 */
import { closeIdbForTests, openIdb } from '@shared-packages/ui/idb';
import { HUB_MONITOR_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import {
	DEFAULT_MONITOR_BASE_URL,
	HUB_MONITOR_DB_NAME,
	HUB_MONITOR_STORE,
	normalizeMonitorRootPath,
	type MonitorConnectionProfileV1
} from './types.js';

function openDb(): Promise<IDBDatabase> {
	return openIdb({
		name: HUB_MONITOR_DB_NAME,
		version: 1,
		onUpgrade(db) {
			if (!db.objectStoreNames.contains(HUB_MONITOR_STORE)) {
				db.createObjectStore(HUB_MONITOR_STORE, { keyPath: 'id' });
			}
		}
	});
}

export function closeCredentialsDbForTests(): Promise<void> {
	return closeIdbForTests(HUB_MONITOR_DB_NAME);
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
	const tx = db.transaction(HUB_MONITOR_STORE, 'readwrite');
	tx.objectStore(HUB_MONITOR_STORE).delete(id);
	await txDone(tx);
	notifyTabChannel(HUB_MONITOR_PROFILES_CHANNEL);
}

export function redactProfile(p: MonitorConnectionProfileV1): MonitorConnectionProfileV1 {
	return { ...p };
}
