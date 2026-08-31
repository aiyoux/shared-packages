/**
 * Live SQLite engine: sqlite-wasm in-process for tests, dedicated-worker
 * OPFS SAH pool in the browser. COMMIT is durable — no catalog dump/export.
 *
 * SAH is exclusive. The tab that holds `vfs-catalog-sah` owns the worker;
 * other tabs (and the extract worker when it is not given a port) speak SQL
 * over BroadcastChannel to that leader.
 */
import { CATALOG_SCHEMA } from './catalogSchema.js';

export { CATALOG_SCHEMA };

export type SqlEngine = {
	exec(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
	run(sql: string, params?: unknown[]): Promise<void>;
	begin(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	wipe(): Promise<void>;
	close(): Promise<void>;
};

type Oo1Db = {
	exec(sql: string | { sql: string; bind?: unknown[] }): void;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	close(): void;
};

function applyLiveNameIndexes(db: Oo1Db): void {
	try {
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_parent_name ON nodes(parent_id, name) WHERE deleted_at IS NULL AND parent_id IS NOT NULL`
		);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_root_name ON nodes(name) WHERE deleted_at IS NULL AND parent_id IS NULL`
		);
	} catch {
		/* existing dupes */
	}
}

function wrapOo1(db: Oo1Db): SqlEngine {
	return {
		async exec(sql, params = []) {
			const rows = params.length ? db.selectObjects(sql, params) : db.selectObjects(sql);
			return rows.map((r) => ({ ...r }));
		},
		async run(sql, params = []) {
			if (params.length) db.exec({ sql, bind: params });
			else db.exec(sql);
		},
		async begin() {
			db.exec('BEGIN');
		},
		async commit() {
			db.exec('COMMIT');
		},
		async rollback() {
			try {
				db.exec('ROLLBACK');
			} catch {
				/* already closed */
			}
		},
		async wipe() {
			db.exec(`
				DROP TABLE IF EXISTS nodes;
				DROP TABLE IF EXISTS blob_refs;
				DROP TABLE IF EXISTS drafts;
				DROP TABLE IF EXISTS kv;
				DROP TABLE IF EXISTS leases;
			`);
			db.exec(CATALOG_SCHEMA);
			applyLiveNameIndexes(db);
		},
		async close() {
			try {
				db.exec('ROLLBACK');
			} catch {
				/* no open txn */
			}
			try {
				db.close();
			} catch {
				/* ignore */
			}
		}
	};
}

let sqlite3Promise: Promise<{ oo1: { DB: new (filename: string, flags?: string) => Oo1Db } }> | null =
	null;

async function loadSqlite3() {
	if (!sqlite3Promise) {
		sqlite3Promise = import('@sqlite.org/sqlite-wasm').then((mod) => {
			const init = (mod as { default: (opts?: unknown) => Promise<unknown> }).default;
			return init() as Promise<{ oo1: { DB: new (filename: string, flags?: string) => Oo1Db } }>;
		});
	}
	return sqlite3Promise;
}

const memoryByName = new Map<string, Promise<SqlEngine>>();

async function openFreshMemory(): Promise<SqlEngine> {
	const sqlite3 = await loadSqlite3();
	const db = new sqlite3.oo1.DB(':memory:');
	db.exec(CATALOG_SCHEMA);
	applyLiveNameIndexes(db);
	return wrapOo1(db);
}

export async function openMemoryEngine(name?: string): Promise<SqlEngine> {
	if (!name) return openFreshMemory();
	let p = memoryByName.get(name);
	if (!p) {
		p = openFreshMemory();
		memoryByName.set(name, p);
	}
	return p;
}

export function resetMemoryEngines(): void {
	memoryByName.clear();
}

type RpcMsg =
	| {
			id: number;
			session: string;
			db: string;
			op: 'exec' | 'run';
			sql: string;
			params: unknown[];
	  }
	| { id: number; session: string; db: string; op: 'begin' | 'commit' | 'rollback' | 'wipe' | 'close' };

type RpcRes = { id: number; session?: string; ok: boolean; rows?: unknown; error?: string };

const CATALOG_LOCK = 'vfs-catalog-sah';
const CATALOG_BC = 'vfs-catalog-sql';
const RPC_TIMEOUT_MS = 20_000;
let leaderAnnounced = false;

function newSession(): string {
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function engineFromCall(
	call: (msg: Omit<RpcMsg, 'id' | 'session' | 'db'>) => Promise<unknown>
): SqlEngine {
	return {
		async exec(sql, params = []) {
			return (await call({ op: 'exec', sql, params })) as Record<string, unknown>[];
		},
		async run(sql, params = []) {
			await call({ op: 'run', sql, params });
		},
		async begin() {
			await call({ op: 'begin' });
		},
		async commit() {
			await call({ op: 'commit' });
		},
		async rollback() {
			await call({ op: 'rollback' });
		},
		async wipe() {
			await call({ op: 'wipe' });
		},
		async close() {
			await call({ op: 'close' });
		}
	};
}

export function engineFromPort(port: MessagePort, dbName = 'SharedVFS'): SqlEngine {
	let next = 1;
	const session = newSession();
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	port.onmessage = (ev: MessageEvent) => {
		const msg = ev.data as RpcRes;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.rows);
		else p.reject(new Error(msg.error ?? 'catalog worker error'));
	};
	const failPending = (e: Error) => {
		for (const [, p] of pending) p.reject(e);
		pending.clear();
	};
	workerFailHandlers.add(failPending);
	const call = (msg: Omit<RpcMsg, 'id' | 'session' | 'db'>) =>
		new Promise<unknown>((resolve, reject) => {
			if (workerFatal) {
				reject(workerFatal);
				return;
			}
			const id = next++;
			const t = setTimeout(() => {
				pending.delete(id);
				reject(new Error('catalog RPC timeout'));
			}, RPC_TIMEOUT_MS);
			pending.set(id, {
				resolve: (v) => {
					clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(t);
					reject(e);
				}
			});
			port.postMessage({ ...msg, id, session, db: dbName });
		});
	const engine = engineFromCall(call);
	return {
		...engine,
		async close() {
			workerFailHandlers.delete(failPending);
			await engine.close();
			try {
				port.close();
			} catch {
				/* ignore */
			}
		}
	};
}

function inBrowserMain(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function engineFromBroadcast(dbName: string): SqlEngine {
	const bc = new BroadcastChannel(CATALOG_BC);
	let next = 1;
	const session = newSession();
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	bc.onmessage = (ev: MessageEvent) => {
		const msg = ev.data as RpcRes & { type?: string };
		if (msg?.type !== 'sql-res' || msg.session !== session) return;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.rows);
		else p.reject(new Error(msg.error ?? 'catalog leader error'));
	};
	const call = (msg: Omit<RpcMsg, 'id' | 'session' | 'db'>) =>
		new Promise<unknown>((resolve, reject) => {
			const id = next++;
			const t = setTimeout(() => {
				pending.delete(id);
				reject(new Error('catalog RPC timeout'));
			}, RPC_TIMEOUT_MS);
			pending.set(id, {
				resolve: (v) => {
					clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(t);
					reject(e);
				}
			});
			bc.postMessage({ type: 'sql', ...msg, id, session, db: dbName });
		});
	const engine = engineFromCall(call);
	return {
		...engine,
		async close() {
			await engine.close().catch(() => {});
			try {
				bc.close();
			} catch {
				/* ignore */
			}
		}
	};
}

async function waitForLeader(timeoutMs = 20_000): Promise<void> {
	const bc = new BroadcastChannel(CATALOG_BC);
	try {
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error('catalog leader timeout')), timeoutMs);
			const onMsg = (ev: MessageEvent) => {
				if (ev.data?.type === 'ready') {
					clearTimeout(t);
					bc.removeEventListener('message', onMsg);
					resolve();
				}
			};
			bc.addEventListener('message', onMsg);
			bc.postMessage({ type: 'who' });
		});
	} finally {
		bc.close();
	}
}

let catalogWorker: Worker | null = null;
let leaderBridge: BroadcastChannel | null = null;
let followerPort: MessagePort | null = null;
let followerNext = 1;
const followerPending = new Map<number, { id: number; session?: string }>();
let workerFatal: Error | null = null;
const workerFailHandlers = new Set<(e: Error) => void>();

function failCatalogWorker(err: Error): void {
	workerFatal = err;
	for (const h of workerFailHandlers) h(err);
}

export function getCatalogWorker(): Worker | null {
	return catalogWorker;
}

async function startLeaderWorker(): Promise<Worker | null> {
	if (typeof Worker === 'undefined') return null;
	if (!catalogWorker) {
		try {
			// Vite `?worker` emits a hashed /_app/immutable worker. `new URL(...,
			// import.meta.url)` is not rewritten when this file is compiled from a
			// file: symlink, so production fetched HTML and died with "load error".
			const { default: CatalogWorker } = await import('./catalog.worker.ts?worker');
			catalogWorker = new CatalogWorker({ name: 'vfs-catalog' });
			catalogWorker.onerror = (ev) => {
				const where = ev.filename ? ` (${ev.filename}:${ev.lineno || 0})` : '';
				failCatalogWorker(
					new Error(`catalog worker failed: ${ev.message || 'load error'}${where}`)
				);
			};
			catalogWorker.addEventListener('messageerror', () => {
				failCatalogWorker(new Error('catalog worker messageerror'));
			});
		} catch {
			return null;
		}
	}
	if (!leaderBridge && typeof BroadcastChannel !== 'undefined') {
		const bc = new BroadcastChannel(CATALOG_BC);
		leaderBridge = bc;
		const announce = () => {
			if (!leaderAnnounced) return;
			bc.postMessage({ type: 'ready' });
		};
		if (!followerPort) {
			const ch = new MessageChannel();
			catalogWorker.postMessage({ type: 'connect', dbName: '*' }, [ch.port1]);
			followerPort = ch.port2;
			followerPort.onmessage = (e: MessageEvent) => {
				const res = e.data as RpcRes;
				const orig = followerPending.get(res.id);
				if (!orig) return;
				followerPending.delete(res.id);
				bc.postMessage({
					type: 'sql-res',
					...res,
					id: orig.id,
					session: orig.session
				});
			};
			followerPort.start?.();
		}
		bc.onmessage = (ev: MessageEvent) => {
			const data = ev.data as {
				type?: string;
				id?: number;
				session?: string;
				db?: string;
				op?: string;
				sql?: string;
				params?: unknown[];
			};
			if (data?.type === 'who') {
				announce();
				return;
			}
			if (data?.type !== 'sql' || typeof data.id !== 'number' || !followerPort) return;
			const localId = followerNext++;
			followerPending.set(localId, { id: data.id, session: data.session });
			followerPort.postMessage({
				id: localId,
				session: data.session,
				db: data.db,
				op: data.op,
				sql: data.sql,
				params: data.params
			});
		};
		announce();
	}
	return catalogWorker;
}

export function connectCatalogPort(dbName = 'SharedVFS'): MessagePort | null {
	if (!catalogWorker) return null;
	const ch = new MessageChannel();
	catalogWorker.postMessage({ type: 'connect', dbName }, [ch.port1]);
	return ch.port2;
}

async function tryBecomeLeader(): Promise<boolean> {
	const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
	if (!locks?.request) {
		return !!(await startLeaderWorker());
	}
	return await new Promise<boolean>((resolve) => {
		let decided = false;
		const decide = (v: boolean) => {
			if (decided) return;
			decided = true;
			resolve(v);
		};
		try {
			void locks
				.request(CATALOG_LOCK, { ifAvailable: true }, async (lock) => {
					if (!lock) {
						decide(false);
						return;
					}
					if (!(await startLeaderWorker())) {
						decide(false);
						return;
					}
					decide(true);
					await new Promise<void>((release) => {
						if (typeof addEventListener === 'function') {
							for (const ev of ['pagehide', 'unload', 'freeze'] as const) {
								addEventListener(ev, () => release(), { once: true });
							}
						}
					});
				})
				.catch(() => decide(false));
		} catch {
			decide(false);
		}
	});
}

export async function openWorkerEngine(dbName = 'SharedVFS'): Promise<SqlEngine | null> {
	if (inBrowserMain()) {
		const leader = await tryBecomeLeader();
		if (leader) {
			const port = connectCatalogPort(dbName);
			if (!port) return null;
			const eng = engineFromPort(port, dbName);
			await eng.exec('SELECT 1 AS ok');
			leaderAnnounced = true;
			leaderBridge?.postMessage({ type: 'ready' });
			return eng;
		}
		if (typeof BroadcastChannel === 'undefined') return null;
		try {
			await waitForLeader();
		} catch {
			return null;
		}
		const follower = engineFromBroadcast(dbName);
		await follower.exec('SELECT 1 AS ok');
		return follower;
	}
	// Dedicated worker (extract) cannot nest a Worker; speak to the leader.
	if (typeof BroadcastChannel !== 'undefined') {
		try {
			await waitForLeader();
			const follower = engineFromBroadcast(dbName);
			await follower.exec('SELECT 1 AS ok');
			return follower;
		} catch {
			return null;
		}
	}
	return null;
}
