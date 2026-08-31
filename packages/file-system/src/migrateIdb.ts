/**
 * One-shot IndexedDB → SQLite catalog copy. No Dexie — raw IDB.
 *
 * Fail closed: a read error does not stamp migrated_from_idb or enable GC.
 * Missing IDB is a true fresh install.
 */
import { MIGRATED_KEY, type SqliteCatalog } from './catalog.js';
import type { AppDraft, BlobRef, VfsNode } from './types.js';
import type { LeaseRow, MetaRow } from './db.js';

export type MigrateReport = {
	ok: boolean;
	reason: 'already' | 'fresh' | 'copied' | 'failed';
	nodes?: number;
	blobRefs?: number;
	drafts?: number;
	leases?: number;
	meta?: number;
	error?: string;
};

function emptyCounts() {
	return { nodes: 0, blobRefs: 0, drafts: 0, leases: 0, meta: 0 };
}

type CatalogDump = {
	missing: boolean;
	nodes: VfsNode[];
	blobRefs: BlobRef[];
	drafts: AppDraft[];
	leases: LeaseRow[];
	meta: MetaRow[];
};

function getAllStore<T>(db: IDBDatabase, store: string): Promise<T[]> {
	if (!db.objectStoreNames.contains(store)) return Promise.resolve([]);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, 'readonly');
		const r = tx.objectStore(store).getAll();
		r.onsuccess = () => resolve((r.result as T[]) ?? []);
		r.onerror = () => reject(r.error ?? new Error(`idb getAll ${store} failed`));
	});
}

/** One connection. Errors throw — callers must not treat that as empty. */
async function readIdbCatalog(dbName: string): Promise<CatalogDump> {
	if (typeof indexedDB === 'undefined') {
		return { missing: true, nodes: [], blobRefs: [], drafts: [], leases: [], meta: [] };
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (e: unknown) => {
			if (settled) return;
			settled = true;
			reject(e instanceof Error ? e : new Error(String(e)));
		};
		const req = indexedDB.open(dbName);
		req.onerror = () => fail(req.error ?? new Error('idb open failed'));
		req.onupgradeneeded = () => {
			/* opening a missing DB would create it — abort */
			req.transaction?.abort();
		};
		req.onblocked = () => fail(new Error('idb open blocked'));
		req.onsuccess = () => {
			const db = req.result;
			void (async () => {
				try {
					const [nodes, blobRefs, drafts, leases, meta] = await Promise.all([
						getAllStore<VfsNode>(db, 'nodes'),
						getAllStore<BlobRef>(db, 'blobRefs'),
						getAllStore<AppDraft>(db, 'drafts'),
						getAllStore<LeaseRow>(db, 'leases'),
						getAllStore<MetaRow>(db, 'meta')
					]);
					if (settled) return;
					settled = true;
					db.close();
					resolve({ missing: false, nodes, blobRefs, drafts, leases, meta });
				} catch (e) {
					try {
						db.close();
					} catch {
						/* ignore */
					}
					fail(e);
				}
			})();
		};
	}).catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e);
		const name = e instanceof Error ? e.name : '';
		if (name === 'AbortError' || /abort/i.test(msg)) {
			return {
				missing: true,
				nodes: [] as VfsNode[],
				blobRefs: [] as BlobRef[],
				drafts: [] as AppDraft[],
				leases: [] as LeaseRow[],
				meta: [] as MetaRow[]
			};
		}
		throw e;
	});
}

export async function migrateIdbToSqlite(
	catalog: SqliteCatalog,
	dbName: string
): Promise<MigrateReport> {
	try {
		const existing = await catalog.meta.get(MIGRATED_KEY);
		const sqlCount = (await catalog.nodes.toArray()).length;
		const stamp = existing?.value as { fresh?: boolean; copiedNodes?: number } | undefined;
		if (existing && sqlCount > 0 && stamp && stamp.fresh !== true) {
			catalog.migrationOk = true;
			return { ok: true, reason: 'already' };
		}

		if (typeof indexedDB === 'undefined') {
			await catalog.meta.put({
				key: MIGRATED_KEY,
				value: { at: Date.now(), fresh: true, counts: emptyCounts() }
			});
			catalog.migrationOk = true;
			return { ok: true, reason: 'fresh' };
		}

		const dump = await readIdbCatalog(dbName);
		const counts = {
			nodes: dump.nodes.length,
			blobRefs: dump.blobRefs.length,
			drafts: dump.drafts.length,
			leases: dump.leases.length,
			meta: dump.meta.length
		};

		if (dump.missing || (counts.nodes === 0 && counts.blobRefs === 0 && counts.drafts === 0 && counts.leases === 0)) {
			if (existing && sqlCount > 0) {
				catalog.migrationOk = true;
				return { ok: true, reason: 'already', ...counts };
			}
			await catalog.meta.put({
				key: MIGRATED_KEY,
				value: { at: Date.now(), fresh: true, counts }
			});
			catalog.migrationOk = true;
			return { ok: true, reason: 'fresh', ...counts };
		}

		await catalog.transaction('rw', async () => {
			for (const n of dump.nodes) await catalog.nodes.put(n);
			for (const r of dump.blobRefs) await catalog.blobRefs.put(r);
			for (const d of dump.drafts) await catalog.drafts.put(d);
			for (const l of dump.leases) await catalog.leases.put(l);
			for (const m of dump.meta) {
				if (m.key === MIGRATED_KEY) continue;
				await catalog.meta.put(m);
			}
		});

		const copiedNodes = (await catalog.nodes.toArray()).length;
		const copiedRefs = (await catalog.blobRefs.toArray()).length;
		const fileNodes = dump.nodes.filter((n) => n.kind === 'file' && n.blobId);
		const refIds = new Set(dump.blobRefs.map((r) => r.id));
		const missingRefs = fileNodes.filter((n) => n.blobId && !refIds.has(n.blobId)).length;
		if (copiedNodes < dump.nodes.length || copiedRefs < dump.blobRefs.length || missingRefs > 0) {
			catalog.migrationOk = false;
			return {
				ok: false,
				reason: 'failed',
				...counts,
				error: `incomplete copy (nodes ${copiedNodes}/${dump.nodes.length}, refs ${copiedRefs}/${dump.blobRefs.length}, files missing blobRefs ${missingRefs})`
			};
		}

		await catalog.meta.put({
			key: MIGRATED_KEY,
			value: { at: Date.now(), counts, copiedNodes }
		});
		catalog.migrationOk = true;
		return { ok: true, reason: 'copied', ...counts };
	} catch (e) {
		catalog.migrationOk = false;
		return {
			ok: false,
			reason: 'failed',
			error: e instanceof Error ? e.message : String(e)
		};
	}
}
