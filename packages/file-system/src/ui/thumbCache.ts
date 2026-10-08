/**
 * Thumbnail cache for FileExplorer rows.
 *
 * The memory map makes a return to the folder instant. IndexedDB keeps the
 * small image across a refresh. The key includes a content token, so a rewrite
 * misses and is built again:
 *
 * - local / memory: `generation` (content CAS; rename does not bump it)
 * - disk / monitor / others: file size + modified time, plus monitor inode
 *   when the listing sent one
 *
 * Disk has no stable path. The granted folder handle is stored beside the
 * images and matched with `isSameEntry`, so picking the same folder again
 * reuses the thumbnails.
 */
import { generateId } from '../id.js';
import type { ExplorerDiskRoot, ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

const DB_NAME = 'sp-fe-thumb-cache';
const DB_VERSION = 2;
const STORE_THUMBS = 'thumbs';
const STORE_META = 'thumbMeta';
const STORE_GRANTS = 'diskGrants';
const STORE_STATS = 'stats';

/** Skip anything that is not a small preview. */
const MAX_BLOB_BYTES = 512 * 1024;
const DEFAULT_MEM_ENTRIES = 1024;
const MEM_MAX_BYTES = 24 * 1024 * 1024;
const IDB_MAX_ENTRIES = 8192;
const IDB_MAX_BYTES = 128 * 1024 * 1024;

type ThumbMeta = { key: string; bytes: number; touched: number };
type ThumbRow = { key: string; blob: Blob | null; failedUntil?: number };
type CacheStats = { key: 'totals'; count: number; bytes: number };
export type CachedThumb = Blob | 'failed' | null;
type DiskGrantRecord = { id: string; handle: ExplorerDiskRoot };

let memMaxEntries = DEFAULT_MEM_ENTRIES;
const memoryScope = `memory:${generateId('mem')}`;
const mem = new Map<string, ThumbRow>();
let memBytes = 0;
let idbMaxEntries = IDB_MAX_ENTRIES;
let idbMaxBytes = IDB_MAX_BYTES;
let touchedClock = 0;
const touchedInMemory = new Map<string, number>();
const scopePromises = new WeakMap<ExplorerDriver, Promise<string | null>>();
const grantInflight = new WeakMap<ExplorerDiskRoot, Promise<string>>();
let grantChain: Promise<unknown> = Promise.resolve();

let dbPromise: Promise<IDBDatabase> | null = null;
const pendingWrites = new Map<string, Promise<void>>();

/** Bytes identity for a row. Null when a cached image could not be invalidated. */
export function thumbContentToken(entry: ExplorerEntry): string | null {
	if (!entry || entry.kind !== 'file') return null;
	if (typeof entry.generation === 'number' && Number.isFinite(entry.generation)) {
		return `g:${entry.generation}`;
	}
	if (
		typeof entry.size !== 'number' ||
		!Number.isFinite(entry.size) ||
		typeof entry.updatedAt !== 'number' ||
		!Number.isFinite(entry.updatedAt)
	) {
		return null;
	}
	const ino = entry.meta?.ino;
	const dev = entry.meta?.dev;
	const inode =
		typeof ino === 'string' && ino && typeof dev === 'string' && dev ? `:i:${ino}:d:${dev}` : '';
	return `m:${entry.size}:${entry.updatedAt}${inode}`;
}

/** Match Monitor's HTTP image identity to the content version used by previews. */
export function versionedThumbUrl(driver: Pick<ExplorerDriver, 'id'>, url: string, token: string | null): string {
	if (driver.id !== 'monitor' || !token) return url;
	const remote = new URL(url);
	if (remote.protocol !== 'http:' && remote.protocol !== 'https:') return url;
	remote.searchParams.set('v', token);
	return remote.href;
}

export async function thumbCacheKey(
	driver: ExplorerDriver,
	entry: ExplorerEntry,
	maxDim: number
): Promise<string | null> {
	const token = thumbContentToken(entry);
	if (!token) return null;
	const scope = await thumbScope(driver);
	if (!scope) return null;
	const dim = Math.max(1, Math.round(maxDim));
	return `${scope}\u0000${entry.id}\u0000${token}\u0000${dim}`;
}

function thumbScope(driver: ExplorerDriver): Promise<string | null> {
	if (driver.thumbScope) return Promise.resolve(driver.thumbScope);
	const pending = scopePromises.get(driver);
	if (pending) return pending;
	const next = resolveScope(driver);
	scopePromises.set(driver, next);
	return next;
}

async function resolveScope(driver: ExplorerDriver): Promise<string | null> {
	if (driver.thumbScope) return driver.thumbScope;
	if (driver.id === 'local') return 'local';
	if (driver.id === 'memory') return memoryScope;
	if (driver.id === 'disk') {
		if (driver.diskRoot) return `disk:${await resolveDiskGrantId(driver.diskRoot)}`;
		return driver.connectionId ? `disk:${driver.connectionId}` : null;
	}
	if (driver.id === 'monitor') {
		return `monitor:${driver.connectionId ?? driver.endpointKey ?? 'monitor'}`;
	}
	if (driver.connectionId) return `${driver.id}:${driver.connectionId}`;
	if (driver.endpointKey) return `${driver.id}:${driver.endpointKey}`;
	return driver.id || null;
}

/**
 * Stable id for a granted computer folder. The same directory picked again
 * resolves to the id already stored with its thumbnails.
 */
export async function resolveDiskGrantId(root: ExplorerDiskRoot): Promise<string> {
	const pending = grantInflight.get(root);
	if (pending) return pending;
	const job = enqueueGrant(async () => {
		try {
			const rows = await listGrants();
			for (const row of rows) {
				if (await sameDiskRoot(root, row.handle)) return row.id;
			}
			const id = generateId('disk');
			await putGrant({ id, handle: root });
			return id;
		} catch {
			return generateId('disk');
		}
	});
	grantInflight.set(root, job);
	return job;
}

function enqueueGrant<T>(task: () => Promise<T>): Promise<T> {
	const run = grantChain.then(task, task);
	grantChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

async function sameDiskRoot(live: ExplorerDiskRoot, stored: ExplorerDiskRoot): Promise<boolean> {
	if (live === stored) return true;
	try {
		if (live.isSameEntry) return await live.isSameEntry(stored);
	} catch {
		/* A removed folder rejects; try the stored handle. */
	}
	try {
		if (stored.isSameEntry) return await stored.isSameEntry(live);
	} catch {
		return false;
	}
	return false;
}

/** Reads wait only for a write of their own key, never the directory's write backlog. */
export async function recallThumbResult(key: string): Promise<CachedThumb> {
	let row = memGet(key);
	if (!row) {
		await pendingWrites.get(key);
		row = await idbGet(key);
		if (row) putMem(row);
	} else if (!key.startsWith('memory:')) {
		// A hot tile counts as a use too, without writing on every reactive refresh.
		const last = touchedInMemory.get(key) ?? 0;
		if (Date.now() - last > 30_000) void idbTouch(key).catch(() => {});
	}
	if (!row) return null;
	if (row.blob) return row.blob;
	return row.failedUntil && row.failedUntil > Date.now() ? 'failed' : null;
}

export async function recallThumb(key: string): Promise<Blob | null> {
	const result = await recallThumbResult(key);
	return result instanceof Blob ? result : null;
}

/** Remember a small preview. Memory is updated synchronously. Cache errors are best-effort. */
export function rememberThumb(key: string, blob: Blob): Promise<void> {
	if (!blob || blob.size <= 0 || blob.size > MAX_BLOB_BYTES) return Promise.resolve();
	return rememberRow({ key, blob });
}

/** Briefly remember failures across revisits/refreshes; a changed file has a new key. */
export function rememberThumbFailure(key: string): Promise<void> {
	return rememberRow({ key, blob: null, failedUntil: Date.now() + 60_000 });
}

function rememberRow(row: ThumbRow): Promise<void> {
	putMem(row);
	if (row.key.startsWith('memory:')) return Promise.resolve();
	const previous = pendingWrites.get(row.key) ?? Promise.resolve();
	const run = previous.then(() => idbPut(row)).catch(() => {});
	pendingWrites.set(row.key, run);
	void run.then(() => { if (pendingWrites.get(row.key) === run) pendingWrites.delete(row.key); });
	return run;
}

/** Turn a generated thumbnail URL into bytes for the cache. HTTP URLs are left to the caller. */
export async function blobFromThumbSrc(src: string): Promise<Blob | null> {
	if (src.startsWith('data:')) return blobFromDataUrl(src);
	if (src.startsWith('blob:')) {
		try {
			const res = await fetch(src);
			if (!res.ok) return null;
			return await res.blob();
		} catch {
			return null;
		}
	}
	return null;
}

function blobFromDataUrl(src: string): Blob | null {
	const comma = src.indexOf(',');
	if (comma < 0) return null;
	const header = src.slice('data:'.length, comma);
	const body = src.slice(comma + 1);
	const mime = header.split(';')[0] || 'application/octet-stream';
	try {
		if (header.includes(';base64')) {
			const clean = body.replace(/\s/g, '');
			const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
			const bin = atob(padded);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return new Blob([bytes], { type: mime });
		}
		return new Blob([decodeURIComponent(body)], { type: mime });
	} catch {
		return null;
	}
}

function putMem(row: ThumbRow): void {
	const old = mem.get(row.key);
	if (old) { memBytes -= old.blob?.size ?? 0; mem.delete(row.key); }
	mem.set(row.key, row);
	memBytes += row.blob?.size ?? 0;
	while ((mem.size > memMaxEntries || memBytes > MEM_MAX_BYTES) && mem.size > 1) {
		const oldest = mem.keys().next().value!;
		memBytes -= mem.get(oldest)?.blob?.size ?? 0;
		mem.delete(oldest);
		touchedInMemory.delete(oldest);
	}
}

function memGet(key: string): ThumbRow | null {
	const row = mem.get(key);
	if (!row) return null;
	mem.delete(key);
	mem.set(key, row);
	return row;
}

function touched(): number {
	return touchedClock = Math.max(Date.now(), touchedClock + 1);
}

function openDb(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') return Promise.reject(new Error('indexedDB unavailable'));
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_THUMBS)) {
				db.createObjectStore(STORE_THUMBS, { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains(STORE_META)) {
				const meta = db.createObjectStore(STORE_META, { keyPath: 'key' });
				meta.createIndex('touched', 'touched');
			}
			if (!db.objectStoreNames.contains(STORE_GRANTS)) {
				db.createObjectStore(STORE_GRANTS, { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains(STORE_STATS)) {
				const stats = db.createObjectStore(STORE_STATS, { keyPath: 'key' });
				// Upgrade existing caches once. Normal inserts never scan the metadata table.
				const totals: CacheStats = { key: 'totals', count: 0, bytes: 0 };
				const cursor = req.transaction!.objectStore(STORE_META).openCursor();
				cursor.onsuccess = () => {
					const row = cursor.result;
					if (!row) { stats.put(totals); return; }
					totals.count++; totals.bytes += (row.value as ThumbMeta).bytes;
					row.continue();
				};
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
			reject(req.error ?? new Error('indexedDB open failed'));
		};
		req.onblocked = () => {
			dbPromise = null;
			reject(new Error('thumbnail cache upgrade is blocked'));
		};
	});
	return dbPromise;
}

async function idbGet(key: string): Promise<ThumbRow | null> {
	try {
		const db = await openDb();
		return await new Promise((resolve, reject) => {
			const tx = db.transaction([STORE_THUMBS, STORE_META], 'readwrite');
			let result: ThumbRow | null = null;
			const req = tx.objectStore(STORE_THUMBS).get(key);
			req.onsuccess = () => {
				result = req.result ?? null;
				if (result) touchMeta(tx.objectStore(STORE_META), key);
			};
			tx.oncomplete = () => resolve(result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} catch { return null; }
}

function touchMeta(meta: IDBObjectStore, key: string) {
	const req = meta.get(key);
	req.onsuccess = () => {
		if (req.result) {
			meta.put({ ...req.result, touched: touched() });
			if (mem.has(key)) touchedInMemory.set(key, Date.now());
		}
	};
}

async function idbTouch(key: string): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_META, 'readwrite');
		touchMeta(tx.objectStore(STORE_META), key);
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
		tx.onerror = () => reject(tx.error);
	});
}

async function idbPut(row: ThumbRow): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction([STORE_THUMBS, STORE_META, STORE_STATS], 'readwrite');
		const thumbs = tx.objectStore(STORE_THUMBS);
		const meta = tx.objectStore(STORE_META);
		const stats = tx.objectStore(STORE_STATS);
		const old = meta.get(row.key);
		const totalsReq = stats.get('totals');
		totalsReq.onsuccess = () => {
			const totals: CacheStats = totalsReq.result ?? { key: 'totals', count: 0, bytes: 0 };
			const bytes = row.blob?.size ?? 0;
			totals.count += old.result ? 0 : 1;
			totals.bytes += bytes - (old.result?.bytes ?? 0);
			thumbs.put(row);
			meta.put({ key: row.key, bytes, touched: touched() } satisfies ThumbMeta);
			if (mem.has(row.key)) touchedInMemory.set(row.key, Date.now());
			if (totals.count <= idbMaxEntries && totals.bytes <= idbMaxBytes) { stats.put(totals); return; }
			// Walk the existing recency index only as far as eviction needs.
			const cursor = meta.index('touched').openCursor();
			cursor.onsuccess = () => {
				const current = cursor.result;
				if (!current || (totals.count <= idbMaxEntries && totals.bytes <= idbMaxBytes)) {
					stats.put(totals); return;
				}
				const oldest = current.value as ThumbMeta;
				if (oldest.key !== row.key) {
					thumbs.delete(oldest.key); current.delete();
					totals.count--; totals.bytes -= oldest.bytes;
				}
				current.continue();
			};
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function listGrants(): Promise<DiskGrantRecord[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE_GRANTS, 'readonly');
		const req = tx.objectStore(STORE_GRANTS).getAll();
		req.onsuccess = () => resolve((req.result as DiskGrantRecord[]) ?? []);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function putGrant(record: DiskGrantRecord): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_GRANTS, 'readwrite');
		tx.objectStore(STORE_GRANTS).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export function forgetThumbMemoryForTests(): void {
	mem.clear();
	memBytes = 0;
	touchedInMemory.clear();
}

export function setThumbCacheLimitsForTests(opts: { memEntries?: number; idbEntries?: number; idbBytes?: number }): void {
	if (opts.memEntries != null) memMaxEntries = opts.memEntries;
	if (opts.idbEntries != null) idbMaxEntries = opts.idbEntries;
	if (opts.idbBytes != null) idbMaxBytes = opts.idbBytes;
}

export async function resetThumbCacheForTests(): Promise<void> {
	await Promise.all(pendingWrites.values());
	forgetThumbMemoryForTests();
	pendingWrites.clear();
	memMaxEntries = DEFAULT_MEM_ENTRIES;
	idbMaxEntries = IDB_MAX_ENTRIES;
	idbMaxBytes = IDB_MAX_BYTES;
	grantChain = Promise.resolve();
	if (dbPromise) {
		try {
			(await dbPromise).close();
		} catch {
			/* already closed */
		}
	}
	dbPromise = null;
	if (typeof indexedDB === 'undefined') return;
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(DB_NAME);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}
