/**
 * A keyed cache every tab of this origin shares, with an arrival signal.
 *
 * Tabs share storage, so a value one tab stores here is read by any other
 * tab that needs it — nothing is sent between tabs, only "key X arrived".
 * Values are structured-cloned into IndexedDB (a Blob costs its own size
 * once). It is a cache, never the only copy: entries not used for `staleMs`
 * are pruned when the database is first opened; reading an entry counts as
 * using it.
 */
import { openIdb } from './idb.js';

type Stored<T> = { value: T; usedAt: number };

export function createTabSharedCache<T>(opts: {
	/** IndexedDB name; also the BroadcastChannel name. */
	name: string;
	store: string;
	staleMs: number;
}) {
	const listeners = new Set<(key: string) => void>();
	let channel: BroadcastChannel | null = null;
	const pruned = new WeakMap<IDBDatabase, Promise<IDBDatabase>>();

	function announce(key: string): void {
		for (const fn of [...listeners]) fn(key);
	}

	function ensureChannel(): void {
		if (channel || typeof BroadcastChannel === 'undefined') return;
		channel = new BroadcastChannel(opts.name);
		(channel as BroadcastChannel & { unref?: () => void }).unref?.();
		channel.onmessage = (event) => {
			const key = (event.data as { key?: unknown } | null)?.key;
			if (typeof key === 'string') announce(key);
		};
	}

	async function db(): Promise<IDBDatabase> {
		const opened = await openIdb({
			name: opts.name,
			version: 2,
			onUpgrade: (next) => {
				if (next.objectStoreNames.contains(opts.store)) next.deleteObjectStore(opts.store);
				next.createObjectStore(opts.store);
			}
		});
		let pending = pruned.get(opened);
		if (!pending) {
			pending = transaction(opened, 'readwrite', (store) => {
				const cutoff = Date.now() - opts.staleMs;
				const cursorReq = store.openCursor();
				cursorReq.onsuccess = () => {
					const cursor = cursorReq.result;
					if (!cursor) return;
					if ((cursor.value as Stored<T>).usedAt < cutoff) cursor.delete();
					cursor.continue();
				};
			}).then(() => opened);
			pruned.set(opened, pending);
			void pending.catch(() => pruned.delete(opened));
		}
		return pending;
	}

	// A request succeeding does not mean its transaction committed. Publish
	// arrivals only after commit, and reject a later quota/transaction abort.
	function transaction<R>(database: IDBDatabase, mode: IDBTransactionMode,
		work: (store: IDBObjectStore, result: (value: R) => void) => void): Promise<R> {
		return new Promise((resolve, reject) => {
			const tx = database.transaction(opts.store, mode);
			let value: R;
			tx.oncomplete = () => resolve(value);
			tx.onabort = () => reject(tx.error ?? new Error('Cache transaction aborted'));
			tx.onerror = () => {}; // onabort owns the outcome.
			try { work(tx.objectStore(opts.store), (next) => { value = next; }); }
			catch (error) { tx.abort(); reject(error); }
		});
	}

	return {
		/**
		 * Keep a value for every tab and announce it. With `keepExisting`, a
		 * key already held only counts as used: nothing is rewritten or
		 * announced.
		 */
		async put(key: string, value: T, put: { keepExisting?: boolean } = {}): Promise<void> {
			if (!key || typeof indexedDB === 'undefined') return;
			ensureChannel();
			const database = await db();
			const written = await transaction<boolean>(database, 'readwrite', (store, result) => {
				if (put.keepExisting) {
					const req = store.get(key);
					req.onsuccess = () => {
						const existing = req.result as Stored<T> | undefined;
						store.put(existing ? { ...existing, usedAt: Date.now() }
							: { value, usedAt: Date.now() } satisfies Stored<T>, key);
						result(!existing);
					};
				} else {
					store.put({ value, usedAt: Date.now() } satisfies Stored<T>, key);
					result(true);
				}
			});
			if (!written) return;
			channel?.postMessage({ key });
			announce(key);
		},
		/** A value any tab of this origin stored, or null. */
		async get(key: string): Promise<T | null> {
			if (!key || typeof indexedDB === 'undefined') return null;
			const database = await db();
			return transaction<T | null>(database, 'readwrite', (store, result) => {
				const req = store.get(key);
				req.onsuccess = () => {
					const entry = req.result as Stored<T> | undefined;
					if (entry) store.put({ ...entry, usedAt: Date.now() }, key);
					result(entry?.value ?? null);
				};
			});
		},
		/** Hear a key arrive, in this tab or another. */
		onArrival(fn: (key: string) => void): () => void {
			ensureChannel();
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
	};
}
