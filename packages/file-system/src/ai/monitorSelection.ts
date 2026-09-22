/**
 * App-side AI selection (HubAi DB, v2): which monitor, which daemon profile,
 * which model. Replaces the retired key-holding profile store — no secret
 * and no provider URL is stored browser-side, so the writer changed freely
 * (pre-release, no migration).
 */
import { HUB_AI_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import { HUB_AI_DB_NAME, HUB_AI_META, HUB_AI_STORE, type AiMonitorSelectionV2 } from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			// v2 replaces the retired v1 profiles store with `selection`.
			const req = indexedDB.open(HUB_AI_DB_NAME, 2);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (db.objectStoreNames.contains('profiles')) {
					db.deleteObjectStore('profiles');
				}
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

/** Test helper: close the connection so deleteDatabase can complete. */
export async function closeSelectionDbForTests(): Promise<void> {
	if (!dbPromise) return;
	try {
		const db = await dbPromise;
		db.close();
	} catch {
		/* ignore */
	}
	dbPromise = null;
}

export const DEFAULT_SELECTION: Omit<AiMonitorSelectionV2, 'updatedAt'> = {
	v: 2,
	id: 'active',
	monitorProfileId: null,
	aiProfileId: null,
	model: ''
};

/** The current selection, or the empty default when none has been saved. */
export async function getAiSelection(): Promise<AiMonitorSelectionV2> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readonly');
		const req = tx.objectStore(HUB_AI_STORE).get('active');
		req.onsuccess = () => {
			const row = req.result as AiMonitorSelectionV2 | undefined;
			if (row && row.v === 2) {
				resolve(row);
			} else {
				resolve({ ...DEFAULT_SELECTION, updatedAt: 0 });
			}
		};
		req.onerror = () => reject(req.error);
	});
}

/** Persist the selection and wake other tabs. */
export async function setAiSelection(
	selection: Omit<AiMonitorSelectionV2, 'v' | 'id' | 'updatedAt'>
): Promise<AiMonitorSelectionV2> {
	const row: AiMonitorSelectionV2 = {
		v: 2,
		id: 'active',
		monitorProfileId: selection.monitorProfileId,
		aiProfileId: selection.aiProfileId,
		model: selection.model,
		updatedAt: Date.now()
	};
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readwrite');
		tx.objectStore(HUB_AI_STORE).put(row);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('setAiSelection aborted'));
	});
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
	return row;
}