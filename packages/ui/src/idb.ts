/**
 * One cached IndexedDB open per database name.
 *
 * Every store used to carry its own copy of the same opener: promise-cached,
 * `versionchange` closes the handle and drops the cache so a peer tab's
 * upgrade is never blocked, an error drops the cache so the next call
 * retries. This is that opener; `onUpgrade` carries each database's own
 * schema steps.
 *
 * Deliberately not used where open semantics differ: `persistKv` resolves
 * null on error (localStorage fallback), and the Connections transfer store
 * answers `blocked` with an in-memory copy — those keep their own openers.
 */
export type OpenIdbOptions = {
	name: string;
	version?: number;
	onUpgrade?: (db: IDBDatabase, oldVersion: number) => void;
};

const opens = new Map<string, Promise<IDBDatabase>>();

function dropIfCurrent(name: string, open: Promise<IDBDatabase>): void {
	if (opens.get(name) === open) opens.delete(name);
}

export function openIdb(options: OpenIdbOptions): Promise<IDBDatabase> {
	const { name } = options;
	const cached = opens.get(name);
	if (cached) return cached;
	const open = new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, options.version);
		req.onupgradeneeded = (event) =>
			options.onUpgrade?.(req.result, (event as IDBVersionChangeEvent).oldVersion);
		req.onsuccess = () => {
			const db = req.result;
			// Another tab upgrading must not leave this one holding a handle
			// that blocks it.
			db.onversionchange = () => {
				db.close();
				dropIfCurrent(name, open);
			};
			resolve(db);
		};
		req.onerror = () => {
			dropIfCurrent(name, open);
			reject(req.error);
		};
	});
	opens.set(name, open);
	return open;
}

/** Test helper: close the connection so deleteDatabase can complete. */
export async function closeIdbForTests(name: string): Promise<void> {
	const cached = opens.get(name);
	if (!cached) return;
	try {
		const db = await cached;
		db.close();
	} catch {
		/* ignore */
	}
	dropIfCurrent(name, cached);
}