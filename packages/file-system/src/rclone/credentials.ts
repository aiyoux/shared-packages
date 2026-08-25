/**
 * IndexedDB store for hub rclone connection profiles.
 * Secrets never leave this origin; never log rcPass.
 */
import { HUB_RCLONE_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import { clearSessionSecret, getSessionSecret } from '../vault/session.js';
import { materializeForWrite, readSecret, revealStoredSecret } from '../vault/secrets.js';
import type { SealedSecret } from '../vault/types.js';
import { ExplorerRcloneError } from './errors.js';
import {
	DEFAULT_RCLONE_BASE_URL,
	HUB_RCLONE_DB_NAME,
	HUB_RCLONE_META,
	HUB_RCLONE_STORE,
	normalizeRootPath,
	type HubRcloneMeta,
	type RcloneConnectionProfileV1
} from './types.js';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(HUB_RCLONE_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(HUB_RCLONE_STORE)) {
					db.createObjectStore(HUB_RCLONE_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(HUB_RCLONE_META)) {
					db.createObjectStore(HUB_RCLONE_META, { keyPath: 'key' });
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

function storedSecretOf(row: RcloneConnectionProfileV1) {
	return {
		persistSecret: row.persistSecret !== false,
		plaintext: row.rcPass ?? '',
		sealed: row.sealedRcPass
	};
}

async function hydrate(row: RcloneConnectionProfileV1): Promise<RcloneConnectionProfileV1> {
	const rcPass = await readSecret('rclone', row.id, storedSecretOf(row));
	return { ...row, rcPass };
}

export async function listStoredProfiles(): Promise<RcloneConnectionProfileV1[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_RCLONE_STORE, 'readonly');
		const req = tx.objectStore(HUB_RCLONE_STORE).getAll();
		req.onsuccess = () => {
			const rows = (req.result as RcloneConnectionProfileV1[]) ?? [];
			resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
		};
		req.onerror = () => reject(req.error);
	});
}

async function getRawProfile(id: string): Promise<RcloneConnectionProfileV1 | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_RCLONE_STORE, 'readonly');
		const req = tx.objectStore(HUB_RCLONE_STORE).get(id);
		req.onsuccess = () => resolve(req.result as RcloneConnectionProfileV1 | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function listProfiles(): Promise<RcloneConnectionProfileV1[]> {
	const rows = await listStoredProfiles();
	return Promise.all(rows.map(hydrate));
}

export async function getProfile(id: string): Promise<RcloneConnectionProfileV1 | undefined> {
	const raw = await getRawProfile(id);
	return raw ? hydrate(raw) : undefined;
}

export async function revealRcPass(profile: RcloneConnectionProfileV1): Promise<string> {
	if (profile.rcPass?.trim()) return profile.rcPass;
	if (profile.persistSecret === false) {
		const s = getSessionSecret('rclone', profile.id);
		if (s) return s;
	}
	const raw = await getRawProfile(profile.id);
	if (!raw) throw new ExplorerRcloneError('RCLONE_ERROR', 'That rclone connection was removed.');
	return revealStoredSecret('rclone', raw.id, storedSecretOf(raw));
}

/** Vault rekey: overwrite secret fields without re-running materialize. */
export async function rewriteStoredSecret(
	id: string,
	secret: { persistSecret: boolean; plaintext: string; sealed?: SealedSecret }
): Promise<void> {
	const raw = await getRawProfile(id);
	if (!raw) return;
	const row: RcloneConnectionProfileV1 = {
		...raw,
		persistSecret: secret.persistSecret,
		rcPass: secret.plaintext,
		sealedRcPass: secret.sealed,
		updatedAt: Date.now()
	};
	if (!secret.sealed) delete row.sealedRcPass;
	const db = await openDb();
	const tx = db.transaction(HUB_RCLONE_STORE, 'readwrite');
	tx.objectStore(HUB_RCLONE_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
}

/**
 * Save profile. Blank `rcPass` keeps the previously stored secret when updating.
 */
export async function saveProfile(
	profile: Omit<RcloneConnectionProfileV1, 'v' | 'createdAt' | 'updatedAt'> & {
		createdAt?: number;
	}
): Promise<RcloneConnectionProfileV1> {
	const now = Date.now();
	const existing = await getRawProfile(profile.id);
	let rootPath: string | undefined;
	try {
		const n = normalizeRootPath(profile.rootPath);
		rootPath = n || undefined;
	} catch {
		throw new Error('INVALID_ROOT_PATH');
	}

	const mat = await materializeForWrite(
		'rclone',
		profile.id,
		profile.rcPass ?? '',
		profile.persistSecret,
		existing ? storedSecretOf(existing) : undefined
	);

	const row: RcloneConnectionProfileV1 = {
		v: 1,
		id: profile.id,
		name: profile.name.trim(),
		baseUrl: (profile.baseUrl || DEFAULT_RCLONE_BASE_URL).trim() || DEFAULT_RCLONE_BASE_URL,
		fs: profile.fs.trim(),
		rootPath,
		rcUser: profile.rcUser.trim(),
		rcPass: mat.idbPlaintext,
		persistSecret: mat.persistSecret,
		sealedRcPass: mat.sealed,
		createdAt: profile.createdAt ?? existing?.createdAt ?? now,
		updatedAt: now
	};
	if (!mat.sealed) delete row.sealedRcPass;
	const db = await openDb();
	const tx = db.transaction(HUB_RCLONE_STORE, 'readwrite');
	tx.objectStore(HUB_RCLONE_STORE).put(row);
	await txDone(tx);
	notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
	return { ...row, rcPass: mat.revealed || row.rcPass };
}

export async function deleteProfile(id: string): Promise<void> {
	clearSessionSecret('rclone', id);
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([HUB_RCLONE_STORE, HUB_RCLONE_META], 'readwrite');
		const metaStore = tx.objectStore(HUB_RCLONE_META);
		const getReq = metaStore.get('active');
		getReq.onsuccess = () => {
			const m = getReq.result as { key: string; value: HubRcloneMeta } | undefined;
			tx.objectStore(HUB_RCLONE_STORE).delete(id);
			if (m?.value?.activeProfileId === id) {
				metaStore.put({
					key: 'active',
					value: { activeProfileId: null } satisfies HubRcloneMeta
				});
			}
		};
		getReq.onerror = () => reject(getReq.error);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('deleteProfile aborted'));
	});
	notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
}

export async function getActiveProfileId(): Promise<string | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_RCLONE_META, 'readonly');
		const req = tx.objectStore(HUB_RCLONE_META).get('active');
		req.onsuccess = () => {
			const m = req.result as { key: string; value: HubRcloneMeta } | undefined;
			resolve(m?.value?.activeProfileId ?? null);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function setActiveProfileId(id: string | null): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(HUB_RCLONE_META, 'readwrite');
	tx.objectStore(HUB_RCLONE_META).put({
		key: 'active',
		value: { activeProfileId: id } satisfies HubRcloneMeta
	});
	await txDone(tx);
	notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
}

/** Redact secrets for any debug export. */
export function redactProfile(
	p: RcloneConnectionProfileV1
): Omit<RcloneConnectionProfileV1, 'rcPass'> & { rcPass: '***' } {
	const { sealedRcPass: _sealed, ...rest } = p;
	return { ...rest, rcPass: '***' };
}
