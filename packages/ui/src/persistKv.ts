/**
 * Origin-wide durable key-value store on IndexedDB.
 *
 * Replaces localStorage for prefs, last-open ids, and crash drafts. Values are
 * structured-cloneable (strings, JSON-shaped objects, Uint8Array), so a PDF
 * session can keep source bytes without the ~5MB localStorage quota.
 *
 * Sync get/set hit an in-memory cache. `ready()` hydrates from IDB and copies
 * leftover localStorage keys once. Until that finishes, getItem falls back to
 * localStorage so e2e seeds and first paint still work.
 *
 * Left on localStorage on purpose:
 *  - `scratchpad-color-scheme` — blocking FOUC script cannot await IDB
 *  - keys ending in `:storage` — live-document bus ping, not persistence
 */
const DB_NAME = 'scratch-persist-kv';
const DB_STORE = 'kv';
const DB_VERSION = 1;
const CHANNEL = 'scratch-persist-kv';
const FOUC_KEY = 'scratchpad-color-scheme';

const TOMBSTONE = Symbol('persist-kv-tombstone');

type CacheValue = unknown | typeof TOMBSTONE;

const cache = new Map<string, CacheValue>();
let hydrated = false;
let readyPromise: Promise<void> | null = null;
let db: IDBDatabase | null = null;
let writes: Promise<void> = Promise.resolve();
let channel: BroadcastChannel | null = null;
const ORIGIN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type PersistKv = {
	ready: () => Promise<void>;
	get: (key: string) => unknown | undefined;
	set: (key: string, value: unknown) => void;
	remove: (key: string) => void;
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
	flush: () => Promise<void>;
};

function keepInLocalStorage(key: string): boolean {
	return key === FOUC_KEY || key.endsWith(':storage');
}

function lsGet(key: string): string | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function lsRemove(key: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* private mode */
	}
}

function lsKeys(): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const keys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key) keys.push(key);
		}
		return keys;
	} catch {
		return [];
	}
}

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = () => {
				const next = req.result;
				if (!next.objectStoreNames.contains(DB_STORE)) {
					next.createObjectStore(DB_STORE);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function loadAll(database: IDBDatabase): Promise<void> {
	const tx = database.transaction(DB_STORE, 'readonly');
	const store = tx.objectStore(DB_STORE);
	const keys = (await idbReq(store.getAllKeys())) as IDBValidKey[];
	const values = await idbReq(store.getAll());
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (typeof key !== 'string') continue;
		if (!cache.has(key)) cache.set(key, values[i]);
	}
}

async function migrateLocalStorage(database: IDBDatabase | null): Promise<void> {
	const keys = lsKeys().filter((key) => !keepInLocalStorage(key));
	if (keys.length === 0) return;
	for (const key of keys) {
		if (cache.has(key)) {
			lsRemove(key);
			continue;
		}
		const raw = lsGet(key);
		if (raw == null) continue;
		cache.set(key, raw);
		if (database) {
			try {
				const tx = database.transaction(DB_STORE, 'readwrite');
				tx.objectStore(DB_STORE).put(raw, key);
				await waitTx(tx);
			} catch {
				/* quota — keep the cache copy */
			}
		}
		lsRemove(key);
	}
}

function notify(key: string, value: unknown | undefined): void {
	try {
		channel?.postMessage({ origin: ORIGIN, key, value, deleted: value === undefined });
	} catch {
		/* closed channel */
	}
}

function waitTx(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => resolve();
		tx.onabort = () => resolve();
	});
}

function enqueueWrite(fn: (database: IDBDatabase) => IDBTransaction): void {
	writes = writes.then(async () => {
		if (!db) return;
		try {
			await waitTx(fn(db));
		} catch {
			/* private mode / closing */
		}
	});
}

function maybeUnref(ch: BroadcastChannel): void {
	const unref = (ch as BroadcastChannel & { unref?: () => void }).unref;
	if (typeof unref === 'function') unref.call(ch);
}

function listenChannel(): void {
	if (typeof BroadcastChannel === 'undefined') return;
	try {
		channel = new BroadcastChannel(CHANNEL);
		// Node's BroadcastChannel is a ref'd MessagePort. Without unref(), any
		// node:test file that imports this module (even a pure helper) never
		// exits — file-system's archive-ops suite hung the whole `test:all`
		// run that way. Cross-tab still works; the process is just allowed to
		// leave when nothing else is pending. Same pattern as file-system
		// crossTab.ts / live/bus.ts.
		maybeUnref(channel);
	} catch {
		channel = null;
		return;
	}
	channel.addEventListener('message', (e: MessageEvent) => {
		const data = e.data as { origin?: string; key?: string; value?: unknown; deleted?: boolean } | null;
		if (!data || data.origin === ORIGIN || typeof data.key !== 'string') return;
		if (data.deleted) cache.set(data.key, TOMBSTONE);
		else cache.set(data.key, data.value);
	});
}

async function hydrate(): Promise<void> {
	listenChannel();
	db = await openDb();
	if (db) {
		try {
			await loadAll(db);
		} catch {
			/* corrupt / closing */
		}
	}
	await migrateLocalStorage(db);
	hydrated = true;
}

export function persistReady(): Promise<void> {
	if (!readyPromise) readyPromise = hydrate();
	return readyPromise;
}

if (typeof indexedDB !== 'undefined' || typeof localStorage !== 'undefined') {
	void persistReady();
}

export function persistGet(key: string): unknown | undefined {
	if (cache.has(key)) {
		const value = cache.get(key);
		return value === TOMBSTONE ? undefined : value;
	}
	// Not in cache (and not tombstoned): the localStorage leftover is the only
	// remaining source of truth. This cannot be gated on `!hydrated` — a
	// post-hydrate write (a legacy call site, a test seeding localStorage)
	// would then be unreadable for the rest of the session, because the
	// migration has already removed the key it knew about.
	const raw = lsGet(key);
	return raw === null ? undefined : raw;
}

export function persistSet(key: string, value: unknown): void {
	cache.set(key, value);
	void persistReady().then(() => {
		enqueueWrite((database) => {
			const tx = database.transaction(DB_STORE, 'readwrite');
			tx.objectStore(DB_STORE).put(value, key);
			return tx;
		});
	});
	notify(key, value);
}

export function persistRemove(key: string): void {
	cache.set(key, TOMBSTONE);
	if (!hydrated) lsRemove(key);
	void persistReady().then(() => {
		enqueueWrite((database) => {
			const tx = database.transaction(DB_STORE, 'readwrite');
			tx.objectStore(DB_STORE).delete(key);
			return tx;
		});
		lsRemove(key);
	});
	notify(key, undefined);
}

export function persistGetItem(key: string): string | null {
	const value = persistGet(key);
	if (value == null) return null;
	return typeof value === 'string' ? value : JSON.stringify(value);
}

export function persistSetItem(key: string, value: string): void {
	persistSet(key, value);
}

export function persistRemoveItem(key: string): void {
	persistRemove(key);
}

export async function persistFlush(): Promise<void> {
	await persistReady();
	await writes;
}

/**
 * Read authoritative values and atomically write the synchronous update.
 * Unlike legacy cache setters, storage failure rejects. The callback can write
 * additional keys; an undefined value deletes a key. Separate tabs serialize
 * through IndexedDB's readwrite transaction, rather than their cache snapshots.
 */
export async function persistTransaction(
	keys: string[],
	update: (values: Map<string, unknown>) => Map<string, unknown | undefined>
): Promise<void> {
	await persistReady();
	const operation = writes.then(() => {
		if (!db) throw new Error('Durable storage is unavailable.');
		return new Promise<void>((resolve, reject) => {
			const tx = db!.transaction(DB_STORE, 'readwrite');
			const store = tx.objectStore(DB_STORE);
			const values = new Map<string, unknown>();
			let changes = new Map<string, unknown | undefined>();
			let failure: unknown;
			tx.oncomplete = () => {
				for (const [key, value] of changes) {
					cache.set(key, value === undefined ? TOMBSTONE : value);
					lsRemove(key);
					notify(key, value);
				}
				resolve();
			};
			tx.onabort = () => reject(failure ?? tx.error ?? new Error('Durable storage transaction aborted.'));
			const apply = () => {
				try {
					changes = new Map(update(values));
					for (const [key, value] of changes) {
						if (value === undefined) store.delete(key);
						else store.put(value, key);
					}
				} catch (error) {
					failure = error;
					tx.abort();
				}
			};
			const uniqueKeys = [...new Set(keys)];
			let remaining = uniqueKeys.length;
			if (!remaining) apply();
			else for (const key of uniqueKeys) {
				const request = store.get(key);
				request.onsuccess = () => {
					values.set(key, request.result);
					if (--remaining === 0) apply();
				};
			}
		});
	});
	// A strict failure belongs to its caller; it must not poison later legacy
	// writes or transactions queued in this tab.
	writes = operation.catch(() => {});
	await operation;
}

/** Drop-in `Storage`-shaped adapter for existing getItem/setItem call sites. */
export const persistKv: PersistKv = {
	ready: persistReady,
	get: persistGet,
	set: persistSet,
	remove: persistRemove,
	getItem: persistGetItem,
	setItem: persistSetItem,
	removeItem: persistRemoveItem,
	flush: persistFlush
};

export const persistStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
	getItem: persistGetItem,
	setItem: persistSetItem,
	removeItem: persistRemoveItem
};

/** Test seam: forget IDB + cache so the next ready() is a clean hydrate. */
export function __resetPersistKvForTests(): void {
	cache.clear();
	hydrated = false;
	readyPromise = null;
	writes = Promise.resolve();
	if (db) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
		db = null;
	}
	if (channel) {
		try {
			channel.close();
		} catch {
			/* already closed */
		}
		channel = null;
	}
}

declare global {
	interface Window {
		__PERSIST_KV__?: PersistKv;
	}
}

if (typeof window !== 'undefined') {
	window.__PERSIST_KV__ = persistKv;
}
