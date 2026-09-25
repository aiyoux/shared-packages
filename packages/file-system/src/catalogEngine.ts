/**
 * Live SQLite engine: sqlite-wasm in-process for tests, dedicated-worker
 * OPFS SAH pool in the browser. COMMIT is durable — no catalog dump/export.
 *
 * SAH is exclusive, so one tab runs the catalog worker: the leader that
 * `createElection` picks for `vfs-catalog-sah`. Every other context — other
 * tabs, and extract workers not handed a port — sends SQL over BroadcastChannel
 * ADDRESSED to that leader by id.
 *
 * No call here is failed by a clock (scratch-pad
 * `docs/design/tab-coordination.md`). A call fails when something happens: the
 * leader changes (the election says so, exactly), the worker errors, or no
 * tab can lead and none is queued to try. A slow query is just slow.
 */
import { applyCatalogColumnMigrations, CATALOG_SCHEMA } from './catalogSchema.js';
import { createElection, type Election } from './live/election.js';
import { CATALOG_SESSION_LOCK } from './catalogSession.js';
import { clearTabWait, reportTabWait, REPORT_AFTER_MS } from './live/waits.js';

export { CATALOG_SCHEMA };

export type SqlEngine = {
	exec(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
	run(sql: string, params?: unknown[]): Promise<void>;
	/** Many binds of one statement in a single RPC (extract bulkPut). */
	runMany(sql: string, rows: unknown[][]): Promise<void>;
	begin(): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	wipe(): Promise<void>;
	close(): Promise<void>;
};

type Oo1Stmt = {
	bind(args: unknown[]): Oo1Stmt;
	stepReset(): unknown;
	finalize(): unknown;
};
type Oo1Db = {
	exec(sql: string | { sql: string; bind?: unknown[] }): void;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	prepare(sql: string): Oo1Stmt;
	close(): void;
};

function runManyPrepared(d: Oo1Db, sql: string, rows: unknown[][]): void {
	if (!rows.length) return;
	const st = d.prepare(sql);
	try {
		for (const bind of rows) st.bind(bind).stepReset();
	} finally {
		st.finalize();
	}
}

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
		async runMany(sql, rows) {
			runManyPrepared(db, sql, rows);
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
			applyCatalogColumnMigrations(db);
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
		sqlite3Promise = import('@sqlite.org/sqlite-wasm')
			.then((mod) => {
				const init = (mod as { default: (opts?: unknown) => Promise<unknown> }).default;
				return init() as Promise<{ oo1: { DB: new (filename: string, flags?: string) => Oo1Db } }>;
			})
			.catch((e) => {
				sqlite3Promise = null;
				throw e;
			});
	}
	return sqlite3Promise;
}

const memoryByName = new Map<string, Promise<SqlEngine>>();

async function openFreshMemory(): Promise<SqlEngine> {
	const sqlite3 = await loadSqlite3();
	const db = new sqlite3.oo1.DB(':memory:');
	db.exec(CATALOG_SCHEMA);
	applyCatalogColumnMigrations(db);
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

/**
 * `Omit` over a union collapses it to the keys every member shares, which for
 * `RpcMsg` is just `op` — so `sql` and `rows` vanished from the call signature.
 * Distributing keeps each arm's own fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type RpcMsg =
	| {
			id: number;
			session: string;
			db: string;
			op: 'exec' | 'run';
			sql: string;
			params: unknown[];
	  }
	| {
			id: number;
			session: string;
			db: string;
			op: 'runMany';
			sql: string;
			rows: unknown[][];
	  }
	| { id: number; session: string; db: string; op: 'begin' | 'commit' | 'rollback' | 'wipe' | 'close' | 'shutdown' };

type RpcRes = { id: number; session?: string; ok: boolean; rows?: unknown; error?: string };

const CATALOG_LOCK = 'vfs-catalog-sah';
const CATALOG_BC = 'vfs-catalog-sql';
export { CATALOG_SESSION_LOCK };

/** The message every call routed to a leader that is no longer the leader fails with. */
export const CATALOG_LEADER_CHANGED = 'catalog leader changed';

function newSession(): string {
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function engineFromCall(
	call: (msg: DistributiveOmit<RpcMsg, 'id' | 'session' | 'db'>) => Promise<unknown>
): SqlEngine {
	const profileWrap = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const add = (globalThis as { __VFS_PROFILE_ADD__?: (n: string, ms: number) => void })
			.__VFS_PROFILE_ADD__;
		if (!add) return fn();
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			add(name, performance.now() - t0);
		}
	};
	return {
		async exec(sql, params = []) {
			return (await profileWrap('catalog.rpc', () =>
				call({ op: 'exec', sql, params })
			)) as Record<string, unknown>[];
		},
		async run(sql, params = []) {
			await profileWrap('catalog.rpc', () => call({ op: 'run', sql, params }));
		},
		async runMany(sql, rows) {
			if (!rows.length) return;
			await profileWrap('catalog.rpc', () => call({ op: 'runMany', sql, rows }));
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

type LocksLike = {
	request(
		name: string,
		options: Record<string, unknown>,
		cb: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
};

function webLocks(): LocksLike | null {
	const nav = (globalThis as { navigator?: { locks?: LocksLike } }).navigator;
	return typeof nav?.locks?.request === 'function' ? nav.locks : null;
}

/** Hold the session lock until `release()`. `ready` resolves once it is held. */
function holdSessionLock(session: string): { ready: Promise<void>; release: () => void } {
	const locks = webLocks();
	if (!locks) return { ready: Promise.resolve(), release: () => {} };
	let release: () => void = () => {};
	const ready = new Promise<void>((granted) => {
		void locks
			.request(`${CATALOG_SESSION_LOCK}${session}`, {}, () => {
				granted();
				return new Promise<void>((r) => {
					release = r;
				});
			})
			.catch(() => granted());
	});
	return { ready, release: () => release() };
}

/**
 * Engine over a port straight to the catalog worker: this tab's own when it
 * leads, or one handed to an extract worker by the leader.
 *
 * `boundTo` is the leader that port belongs to. A port has no event for its
 * far end dying, so an extract worker follows the election instead: once the
 * leader is anyone else, every call on the port fails as a leader change and
 * the catalog moves to a routed engine.
 */
export function engineFromPort(
	port: MessagePort,
	dbName = 'SharedVFS',
	opts?: { boundTo?: string | null }
): SqlEngine {
	let next = 1;
	const session = newSession();
	const sessionLock = holdSessionLock(session);
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let dead: Error | null = null;
	port.onmessage = (ev: MessageEvent) => {
		const msg = ev.data as RpcRes;
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.rows);
		else p.reject(new Error(msg.error ?? 'catalog worker error'));
	};
	const failPending = (e: Error) => {
		dead = e;
		for (const [, p] of pending) p.reject(e);
		pending.clear();
	};
	workerFailHandlers.add(failPending);

	let offElection: (() => void) | null = null;
	const boundTo = opts?.boundTo ?? null;
	if (boundTo) {
		const e = catalogElection();
		const check = () => {
			if (e.leader && e.leader.id !== boundTo) failPending(new Error(CATALOG_LEADER_CHANGED));
		};
		offElection = e.onChange(check);
		check();
	}

	const call = (msg: DistributiveOmit<RpcMsg, 'id' | 'session' | 'db'>) =>
		sessionLock.ready.then(
			() =>
				new Promise<unknown>((resolve, reject) => {
					if (dead) {
						reject(dead);
						return;
					}
					const id = next++;
					pending.set(id, { resolve, reject });
					try {
						port.postMessage({ ...msg, id, session, db: dbName });
					} catch (e) {
						pending.delete(id);
						reject(e instanceof Error ? e : new Error(String(e)));
					}
				})
		);
	const engine = engineFromCall(call);
	return {
		...engine,
		async close() {
			workerFailHandlers.delete(failPending);
			offElection?.();
			if (!dead) await engine.close().catch(() => {});
			sessionLock.release();
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

// --- the catalog worker, while this tab leads ---------------------------

let catalogWorker: Worker | null = null;
let workerFatal: Error | null = null;
const workerFailHandlers = new Set<(e: Error) => void>();
/** Replies to `{ type: 'pool' }` requests, by id. */
const poolWaiters = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let poolNext = 1;
let shutdownWait: (() => void) | null = null;
/** Our wait on the worker's life lock; see `watchWorkerLife`. */
let lifeWatch: AbortController | null = null;
let heldWait: ((ok: boolean) => void) | null = null;

/**
 * Why the live catalog last refused to open, kept across retries so the error
 * the user sees can say what actually happened — most useful on a phone, where
 * there is no console to read.
 */
let lastCatalogFailure: string | null = null;
/** What the catalog is waiting on right now, for a "still waiting" notice. */
let catalogWaiting: string | null = null;
const waitingListeners = new Set<() => void>();

function noteCatalogFailure(reason: string): void {
	lastCatalogFailure = reason;
}

function setCatalogWaiting(reason: string | null): void {
	if (catalogWaiting === reason) return;
	catalogWaiting = reason;
	for (const fn of [...waitingListeners]) fn();
	if (reportedStuck) reportStuck();
}

// --- "still waiting" notice (report-only) ---------------------------------

const WAIT_ID = 'vfs-catalog';
/** Calls held up on another tab (or on no leader yet), by when they started. */
const blockedCalls = new Map<symbol, number>();
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let reportedStuck = false;

function blockedStart(): symbol {
	const token = Symbol('blocked');
	blockedCalls.set(token, Date.now());
	if (!reportTimer && inBrowserMain()) {
		// Decides only when a notice is worth showing; see `live/waits.ts`.
		reportTimer = setTimeout(() => {
			reportTimer = null;
			if (blockedCalls.size) reportStuck();
		}, REPORT_AFTER_MS);
	}
	return token;
}

function blockedEnd(token: symbol): void {
	blockedCalls.delete(token);
	if (blockedCalls.size) return;
	if (reportTimer) clearTimeout(reportTimer);
	reportTimer = null;
	reportedStuck = false;
	clearTabWait(WAIT_ID);
}

function reportStuck(): void {
	if (!blockedCalls.size) return;
	reportedStuck = true;
	const since = Math.min(...blockedCalls.values());
	const e = election;
	if (catalogWaiting) {
		// This tab leads, but another tab's worker still has the files open.
		// Taking over again would not help; that tab has to run to let go.
		reportTabWait({
			id: WAIT_ID,
			what: 'your files',
			detail: `${catalogWaiting}. Switch to that tab once and it will let go.`,
			since
		});
		return;
	}
	reportTabWait({
		id: WAIT_ID,
		what: 'your files',
		detail: e?.leader
			? 'Another tab is handling your files and has not answered. It may be busy, or frozen in the background.'
			: 'No tab is handling your files yet.',
		since,
		takeOver: e && inBrowserMain() ? () => e.takeOver() : undefined
	});
}

/** Reason the live catalog is unavailable, if one was recorded. */
export function catalogFailureReason(): string | null {
	return lastCatalogFailure ?? catalogElectionIfAny()?.failure ?? null;
}

/**
 * What this tab's catalog is waiting on, if anything — "another tab still has
 * the files open". Report-only: it decides nothing, it lets a person decide.
 */
export function catalogWaitingReason(): string | null {
	return catalogWaiting;
}

export function onCatalogWaitingChange(fn: () => void): () => void {
	waitingListeners.add(fn);
	return () => waitingListeners.delete(fn);
}

function failCatalogWorker(err: Error): void {
	noteCatalogFailure(err.message);
	workerFatal = err;
	for (const h of [...workerFailHandlers]) h(err);
	for (const [, w] of poolWaiters) w.reject(err);
	poolWaiters.clear();
}

export function isCatalogDeadError(e: unknown): boolean {
	const m = e instanceof Error ? e.message : String(e);
	return /catalog leader changed|catalog worker failed|catalog worker messageerror|catalog leader gone|Live OPFS catalog is unavailable/.test(
		m
	);
}

function onWorkerMessage(e: MessageEvent): void {
	const data = e.data as { type?: string; id?: number; ok?: boolean; error?: string; waiting?: string | null } | null;
	if (!data) return;
	if (data.type === 'shutdown-ok') shutdownWait?.();
	if (data.type === 'held') heldWait?.((data as { ok?: boolean }).ok === true);
	if (data.type === 'status') setCatalogWaiting(data.waiting ?? null);
	if (data.type === 'pool-res' && typeof data.id === 'number') {
		const w = poolWaiters.get(data.id);
		poolWaiters.delete(data.id);
		if (data.ok) w?.resolve();
		else w?.reject(new Error(data.error ?? 'catalog worker could not open its files'));
	}
}

/** Drop the worker and its ports at once. For a context that will run no more JS, and tests. */
export function resetCatalogLeader(): void {
	const err = workerFatal ?? new Error('catalog leader gone');
	for (const h of [...workerFailHandlers]) h(err);
	for (const [, w] of poolWaiters) w.reject(err);
	poolWaiters.clear();
	workerFatal = null;
	shutdownWait = null;
	heldWait?.(false);
	heldWait = null;
	lifeWatch?.abort();
	lifeWatch = null;
	closeBridge();
	if (catalogWorker) {
		catalogWorker.onerror = null;
		catalogWorker.removeEventListener('message', onWorkerMessage);
		try {
			catalogWorker.terminate();
		} catch {
			/* ignore */
		}
	}
	catalogWorker = null;
	setCatalogWaiting(null);
}

/**
 * Close the databases and pause the SAH pool, then terminate — so the next
 * leader can open the files the moment the lock moves. Waits for the worker to
 * say it is done, or to fail; there is no deadline, because a worker that is
 * still pausing is still holding the files.
 */
export async function shutdownCatalogLeader(): Promise<void> {
	const w = catalogWorker;
	if (!w || workerFatal) {
		resetCatalogLeader();
		return;
	}
	const onFail = () => shutdownWait?.();
	await new Promise<void>((resolve) => {
		shutdownWait = resolve;
		workerFailHandlers.add(onFail);
		try {
			w.postMessage({ type: 'shutdown' });
		} catch {
			resolve();
		}
	}).finally(() => {
		shutdownWait = null;
		workerFailHandlers.delete(onFail);
	});
	resetCatalogLeader();
}

export function getCatalogWorker(): Worker | null {
	return catalogWorker;
}

async function startLeaderWorker(): Promise<Worker | null> {
	if (typeof Worker === 'undefined') {
		noteCatalogFailure('no Worker constructor in this context');
		return null;
	}
	if (catalogWorker) return catalogWorker;
	workerFatal = null;
	try {
		// Vite `?worker` emits a hashed /_app/immutable worker. `new URL(...,
		// import.meta.url)` is not rewritten when this file is compiled from a
		// file: symlink, so production fetched HTML and died with "load error".
		const { default: CatalogWorker } = await import('./catalog.worker.ts?worker');
		const w: Worker = new CatalogWorker({ name: 'vfs-catalog' });
		catalogWorker = w;
		w.onerror = (ev) => {
			const where = ev.filename ? ` (${ev.filename}:${ev.lineno || 0})` : '';
			workerDied(new Error(`catalog worker failed: ${ev.message || 'load error'}${where}`));
		};
		w.addEventListener('messageerror', () => workerDied(new Error('catalog worker messageerror')));
		w.addEventListener('message', onWorkerMessage);
		return w;
	} catch (e) {
		// The `?worker` chunk failed to import — a 404 on a stale hashed
		// asset, a CSP refusal, or storage the browser will not hand over.
		noteCatalogFailure(`catalog worker did not start: ${(e as Error)?.message ?? e}`);
		return null;
	}
}

/** The worker died under us. Fail its calls, then hand leadership on. */
function workerDied(err: Error): void {
	failCatalogWorker(err);
	resetCatalogLeader();
	// We cannot serve without it. Yielding tears down and rejoins the queue:
	// another tab takes over, or — alone — we start a fresh worker.
	const e = catalogElectionIfAny();
	if (e?.isLeader) e.yieldLeadership();
}

/**
 * Learn exactly when the worker dies, however it dies. It holds a lock for its
 * whole life; once it says so, we queue on that lock. A worker that calls
 * `self.close()` or crashes fires no `error` event here, and a 20-second RPC
 * timeout used to be the only thing that noticed — by killing every slow
 * query along with it.
 */
function watchWorkerLife(w: Worker): Promise<void> {
	const locks = webLocks();
	if (!locks) return Promise.resolve();
	const name = `vfs-catalog-worker:${newSession()}`;
	return new Promise<void>((ready) => {
		heldWait = (ok) => {
			heldWait = null;
			if (ok && catalogWorker === w) {
				const ctl = new AbortController();
				lifeWatch = ctl;
				void locks
					.request(name, { signal: ctl.signal }, () => {
						if (ctl.signal.aborted || catalogWorker !== w) return;
						workerDied(new Error('catalog worker failed: it stopped'));
					})
					.catch(() => {});
			}
			ready();
		};
		w.postMessage({ type: 'hold', lock: name });
	});
}

/** Ask the worker to open its SAH pool; resolves once it has. */
function openPool(w: Worker): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (workerFatal) {
			reject(workerFatal);
			return;
		}
		const id = poolNext++;
		poolWaiters.set(id, { resolve, reject });
		w.postMessage({ type: 'pool', id });
	});
}

export function connectCatalogPort(dbName = 'SharedVFS'): MessagePort | null {
	if (!catalogWorker || !catalogElectionIfAny()?.isLeader) return null;
	const ch = new MessageChannel();
	catalogWorker.postMessage({ type: 'connect', dbName }, [ch.port1]);
	return ch.port2;
}

/** The leader id a port from `connectCatalogPort` belongs to. */
export function catalogLeaderId(): string | null {
	const e = catalogElectionIfAny();
	return e?.isLeader ? (e.leader?.id ?? null) : null;
}

// --- the election -------------------------------------------------------

let election: Election | null = null;

function catalogElectionIfAny(): Election | null {
	return election;
}

/**
 * The catalog's election. Browser tabs contend; workers only follow — an
 * extract worker cannot host the catalog worker, but must know who does.
 */
function catalogElection(): Election {
	if (election) return election;
	const e = createElection(CATALOG_LOCK, {
		contend: inBrowserMain(),
		// Explicit, so a worker (no window) gets a real election, not the SSR stub.
		locks: webLocks(),
		async prepare() {
			lastCatalogFailure = null;
			const w = await startLeaderWorker();
			if (!w) return false;
			try {
				await watchWorkerLife(w);
				await openPool(w);
			} catch (err) {
				noteCatalogFailure(err instanceof Error ? err.message : String(err));
				// Pause before terminate: a hard reset leaves the sync handles
				// held, and the next tab to lead would find them taken.
				await shutdownCatalogLeader();
				throw err;
			}
			setCatalogWaiting(null);
			return true;
		},
		teardown: () => shutdownCatalogLeader(),
		abandon: () => resetCatalogLeader(),
		onStolen: () => noteCatalogFailure('another tab took the file catalog over from this one')
	});
	election = e;
	e.onChange(syncBridge);
	return e;
}

/** The catalog's election, for a "take over here" control. Null outside a browser tab. */
export function getCatalogElection(): Election | null {
	return inBrowserMain() ? catalogElection() : null;
}

// --- the bridge: followers' SQL, answered while this tab leads -----------

let bridge: BroadcastChannel | null = null;
let bridgePort: MessagePort | null = null;
let bridgeNext = 1;
const bridgePending = new Map<number, { id: number; session?: string }>();
/** Sessions whose owner we are watching; see CATALOG_SESSION_LOCK. */

function closeBridge(): void {
	bridgePending.clear();
	try {
		bridgePort?.close();
	} catch {
		/* ignore */
	}
	bridgePort = null;
	try {
		bridge?.close();
	} catch {
		/* ignore */
	}
	bridge = null;
}

function syncBridge(): void {
	const e = election;
	const leading = !!e?.isLeader && !!catalogWorker;
	if (!leading) {
		if (bridge) closeBridge();
		return;
	}
	if (bridge || typeof BroadcastChannel === 'undefined') return;
	const bc = new BroadcastChannel(CATALOG_BC);
	bridge = bc;
	const ch = new MessageChannel();
	catalogWorker!.postMessage({ type: 'connect', dbName: '*' }, [ch.port1]);
	bridgePort = ch.port2;
	bridgePort.onmessage = (ev: MessageEvent) => {
		const res = ev.data as RpcRes;
		const orig = bridgePending.get(res.id);
		if (!orig) return;
		bridgePending.delete(res.id);
		bc.postMessage({ type: 'sql-res', ...res, id: orig.id, session: orig.session });
	};
	bridgePort.start?.();
	bc.onmessage = (ev: MessageEvent) => {
		const data = ev.data as {
			type?: string;
			to?: string;
			id?: number;
			session?: string;
			db?: string;
			op?: string;
			sql?: string;
			params?: unknown[];
			rows?: unknown[][];
		};
		if (data?.type !== 'sql' || typeof data.id !== 'number' || !bridgePort) return;
		// Fenced: a call addressed to another leader (an older one) is told
		// so, and retries against whoever leads now.
		if (data.to !== election?.leader?.id) {
			bc.postMessage({
				type: 'sql-res',
				id: data.id,
				session: data.session,
				ok: false,
				error: CATALOG_LEADER_CHANGED
			});
			return;
		}
		const localId = bridgeNext++;
		bridgePending.set(localId, { id: data.id, session: data.session });
		bridgePort.postMessage({
			id: localId,
			session: data.session,
			db: data.db,
			op: data.op,
			sql: data.sql,
			params: data.params,
			rows: data.rows
		});
	};
}

// --- the routed engine every caller uses ----------------------------------

/**
 * SQL to whoever leads the catalog: this tab's worker over a port, or the
 * leader tab over BroadcastChannel, addressed to it by id.
 *
 * A call made while no leader is known waits for one — the election says when
 * there is one, exactly. A call in flight to a leader that stops being the
 * leader fails with `CATALOG_LEADER_CHANGED`, which `SqliteCatalog` retries.
 * The only other failure is "unavailable": this tab could not lead, is out of
 * the queue, and no other tab leads.
 */
function routedEngine(dbName: string): SqlEngine {
	const e = catalogElection();
	const session = newSession();
	const sessionLock = holdSessionLock(session);
	let next = 1;
	let closed = false;
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; via: string }
	>();
	const waiting: Array<() => void> = [];
	let localPort: MessagePort | null = null;
	let localVia: string | null = null;

	const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CATALOG_BC) : null;
	(bc as { unref?: () => void } | null)?.unref?.();
	if (bc) {
		bc.onmessage = (ev: MessageEvent) => {
			const msg = ev.data as RpcRes & { type?: string };
			if (msg?.type !== 'sql-res' || msg.session !== session) return;
			settle(msg);
		};
	}

	function settle(msg: RpcRes): void {
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.rows);
		else p.reject(new Error(msg.error ?? 'catalog leader error'));
	}

	/** Where a call goes right now: `local:<term>`, a leader id, or nowhere yet. */
	function currentVia(): string | null {
		if (e.isLeader) return catalogWorker && !workerFatal ? `local:${e.term}` : null;
		return e.leader?.id ?? null;
	}

	function unavailable(): Error | null {
		if (e.isLeader || e.leader || e.queued) return null;
		if (!e.decided && inBrowserMain()) return null;
		const why = e.failure ?? lastCatalogFailure;
		if (!why) return null;
		return new Error(`Live OPFS catalog is unavailable (SAH worker / COOP) — ${why}`);
	}

	function portFor(via: string): MessagePort | null {
		if (localVia === via && localPort) return localPort;
		try {
			localPort?.close();
		} catch {
			/* ignore */
		}
		localPort = connectCatalogPort(dbName);
		localVia = localPort ? via : null;
		if (localPort) localPort.onmessage = (ev: MessageEvent) => settle(ev.data as RpcRes);
		return localPort;
	}

	function send(
		msg: DistributiveOmit<RpcMsg, 'id' | 'session' | 'db'>,
		resolve: (v: unknown) => void,
		reject: (e: Error) => void,
		blocked: () => void
	): void {
		if (closed) {
			reject(new Error('catalog engine closed'));
			return;
		}
		const via = currentVia();
		if (!via) {
			const err = unavailable();
			if (err) reject(err);
			else {
				blocked();
				waiting.push(() => send(msg, resolve, reject, blocked));
			}
			return;
		}
		if (!via.startsWith('local:')) blocked();
		const id = next++;
		pending.set(id, { resolve, reject, via });
		try {
			if (via.startsWith('local:')) {
				const port = portFor(via);
				if (!port) throw new Error(CATALOG_LEADER_CHANGED);
				port.postMessage({ ...msg, id, session, db: dbName });
			} else {
				if (!bc) throw new Error('no BroadcastChannel to reach the catalog leader');
				bc.postMessage({ type: 'sql', to: via, ...msg, id, session, db: dbName });
			}
		} catch (err) {
			pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	/** Fail what went to a leader that no longer leads; send what was waiting. */
	function onElection(): void {
		const via = currentVia();
		for (const [id, p] of [...pending]) {
			if (p.via === via) continue;
			pending.delete(id);
			p.reject(new Error(CATALOG_LEADER_CHANGED));
		}
		if (via || unavailable()) {
			for (const run of waiting.splice(0)) run();
		}
	}
	const offElection = e.onChange(onElection);
	const onWorkerFail = () => onElection();
	workerFailHandlers.add(onWorkerFail);

	const call = (msg: DistributiveOmit<RpcMsg, 'id' | 'session' | 'db'>) =>
		sessionLock.ready.then(
			() =>
				new Promise<unknown>((resolve, reject) => {
					let token: symbol | null = null;
					const done = () => {
						if (token) blockedEnd(token);
						token = null;
					};
					send(
						msg,
						(v) => {
							done();
							resolve(v);
						},
						(err) => {
							done();
							reject(err);
						},
						() => {
							token ??= blockedStart();
						}
					);
				})
		);
	const engine = engineFromCall(call);
	return {
		...engine,
		async close() {
			if (closed) return;
			// No goodbye to the leader: waiting on one here hung when it went
			// away mid-close. Releasing the session lock (below) is what makes
			// the worker roll back anything this session left open.
			closed = true;
			offElection();
			workerFailHandlers.delete(onWorkerFail);
			for (const [, p] of pending) p.reject(new Error('catalog engine closed'));
			pending.clear();
			for (const run of waiting.splice(0)) run();
			sessionLock.release();
			try {
				localPort?.close();
			} catch {
				/* ignore */
			}
			try {
				bc?.close();
			} catch {
				/* ignore */
			}
		}
	};
}

/**
 * The live catalog engine for `dbName`. Returns null only where there is no
 * way to reach one at all (no Worker here and no BroadcastChannel to a tab
 * that has one); otherwise calls wait for a leader, as long as one is coming.
 */
export async function openWorkerEngine(dbName = 'SharedVFS'): Promise<SqlEngine | null> {
	if (inBrowserMain()) {
		if (typeof Worker === 'undefined' && typeof BroadcastChannel === 'undefined') {
			noteCatalogFailure('no Worker and no BroadcastChannel in this browser');
			return null;
		}
		// A tab that could not lead earlier (it said why) tries again on the
		// next open, rather than never.
		catalogElection().resumeAcquire();
		return routedEngine(dbName);
	}
	if (typeof BroadcastChannel === 'undefined') return null;
	return routedEngine(dbName);
}

/** Tests: forget the election so the next open starts fresh. */
export function resetCatalogElection(): void {
	election?.destroy();
	election = null;
	lastCatalogFailure = null;
}
