/**
 * Dedicated worker that owns the live OPFS SAH-pool SQLite catalog.
 * One SAH pool, one sqlite file per VFS dbName.
 *
 * sqlite-wasm is loaded lazily AFTER onmessage is wired. A static import
 * (or a bundled wasm fetch during module eval) delays the handler; the
 * main thread's SELECT 1 then sits on a port nobody is listening to until
 * catalog RPC times out.
 */
import { CATALOG_SCHEMA } from './catalogSchema.js';

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

type PoolUtil = {
	OpfsSAHPoolDb: new (filename: string) => Oo1Db;
	pauseVfs?: () => unknown;
};

let pool: PoolUtil | null = null;
const dbs = new Map<string, Oo1Db>();
let aliveTimer: ReturnType<typeof setInterval> | null = null;

function safeName(dbName: string): string {
	return dbName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'SharedVFS';
}

function wasmHref(): string {
	try {
		return new URL('/vendor/sqlite3.wasm', self.location.href).href;
	} catch {
		return '/vendor/sqlite3.wasm';
	}
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(msg)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});
}

async function getPool(): Promise<PoolUtil> {
	if (pool) return pool;
	const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm');
	const sqlite3 = await withTimeout(
		sqlite3InitModule({
			locateFile: (file: string) => (file.endsWith('.wasm') ? wasmHref() : file)
		}) as Promise<{
			installOpfsSAHPoolVfs: (opts: {
				name: string;
				directory: string;
			}) => Promise<PoolUtil>;
		}>,
		15_000,
		'catalog sqlite3.wasm load timed out'
	);
	pool = await withTimeout(
		sqlite3.installOpfsSAHPoolVfs({
			name: 'vfs-catalog',
			directory: 'vfs-catalog-sah'
		}),
		15_000,
		'catalog OPFS SAH pool timed out (another tab may hold the catalog lock)'
	);
	return pool;
}

async function dbFor(dbName: string): Promise<Oo1Db> {
	const key = safeName(dbName);
	const hit = dbs.get(key);
	if (hit) return hit;
	const p = await getPool();
	const db = new p.OpfsSAHPoolDb(`/c-${key}.sqlite`);
	db.exec(CATALOG_SCHEMA);
	try {
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_parent_name ON nodes(parent_id, name) WHERE deleted_at IS NULL AND parent_id IS NOT NULL`
		);
		db.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS nodes_live_root_name ON nodes(name) WHERE deleted_at IS NULL AND parent_id IS NULL`
		);
	} catch {
		/* existing dupes — uniqueness stays application-level */
	}
	dbs.set(key, db);
	return db;
}

type Incoming = {
	id: number;
	session?: string;
	db?: string;
	op: string;
	sql?: string;
	params?: unknown[];
	rows?: unknown[][];
};

async function runOp(
	dbName: string,
	msg: Incoming
): Promise<{ ok: true; rows?: unknown } | { ok: false; error: string }> {
	try {
		const d = await dbFor(dbName);
		if (msg.op === 'exec') {
			const params = msg.params ?? [];
			const rows = params.length
				? d.selectObjects(msg.sql!, params)
				: d.selectObjects(msg.sql!);
			return { ok: true, rows: rows.map((r) => ({ ...r })) };
		}
		if (msg.op === 'run') {
			const params = msg.params ?? [];
			if (params.length) d.exec({ sql: msg.sql!, bind: params });
			else d.exec(msg.sql!);
			return { ok: true };
		}
		if (msg.op === 'runMany') {
			runManyPrepared(d, msg.sql!, msg.rows ?? []);
			return { ok: true };
		}
		if (msg.op === 'begin') {
			d.exec('BEGIN');
			return { ok: true };
		}
		if (msg.op === 'commit') {
			d.exec('COMMIT');
			return { ok: true };
		}
		if (msg.op === 'rollback') {
			try {
				d.exec('ROLLBACK');
			} catch {
				/* ignore */
			}
			return { ok: true };
		}
		if (msg.op === 'wipe') {
			d.exec(`
				DROP TABLE IF EXISTS nodes;
				DROP TABLE IF EXISTS blob_refs;
				DROP TABLE IF EXISTS drafts;
				DROP TABLE IF EXISTS kv;
				DROP TABLE IF EXISTS leases;
			`);
			d.exec(CATALOG_SCHEMA);
			return { ok: true };
		}
		if (msg.op === 'close') {
			try {
				d.exec('ROLLBACK');
			} catch {
				/* no open txn */
			}
			return { ok: true };
		}
		if (msg.op === 'shutdown') {
			await shutdownPool();
			return { ok: true };
		}
		return { ok: false, error: `unknown op ${msg.op}` };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : String(e)
		};
	}
}

type Queued = {
	msg: Incoming;
	dbName: string;
	reply: (msg: unknown) => void;
};

type DbQueue = {
	items: Queued[];
	txSession: string | null;
	pumping: boolean;
};

const queues = new Map<string, DbQueue>();

function queueFor(dbName: string): DbQueue {
	let q = queues.get(dbName);
	if (!q) {
		q = { items: [], txSession: null, pumping: false };
		queues.set(dbName, q);
	}
	return q;
}

async function pump(dbName: string): Promise<void> {
	const q = queueFor(dbName);
	if (q.pumping) return;
	q.pumping = true;
	try {
		while (true) {
			const i = q.items.findIndex((it) => q.txSession == null || it.msg.session === q.txSession);
			if (i < 0) return;
			const item = q.items.splice(i, 1)[0]!;
			if (item.msg.op === 'begin') q.txSession = item.msg.session ?? 'anon';
			const result = await runOp(item.dbName, item.msg);
			if (item.msg.op === 'commit' || item.msg.op === 'rollback' || item.msg.op === 'wipe' || item.msg.op === 'close') {
				q.txSession = null;
			}
			if (!result.ok && item.msg.op === 'begin') q.txSession = null;
			item.reply({
				id: item.msg.id,
				session: item.msg.session,
				ok: result.ok,
				...(result.ok ? { rows: result.rows } : { error: result.error })
			});
		}
	} finally {
		q.pumping = false;
		if (q.items.some((it) => q.txSession == null || it.msg.session === q.txSession)) {
			void pump(dbName);
		}
	}
}

function enqueue(dbName: string, msg: Incoming, reply: (msg: unknown) => void): void {
	queueFor(dbName).items.push({ msg, dbName, reply });
	void pump(dbName);
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function shutdownPool(): Promise<void> {
	for (const d of dbs.values()) {
		try {
			d.exec('ROLLBACK');
		} catch {
			/* no open txn */
		}
		try {
			d.close();
		} catch {
			/* ignore */
		}
	}
	dbs.clear();
	queues.clear();
	if (pool && typeof pool.pauseVfs === 'function') {
		try {
			pool.pauseVfs();
		} catch {
			/* files still open — terminate will drop the SAHs */
		}
	}
	pool = null;
}

function pingAlive(): void {
	try {
		ctx.postMessage({ type: 'alive' });
	} catch {
		/* closing */
	}
}

ctx.onmessage = (ev: MessageEvent) => {
	if (ev.data?.type === 'shutdown') {
		void shutdownPool().then(() => {
			try {
				ctx.postMessage({ type: 'shutdown-ok' });
			} catch {
				/* ignore */
			}
			if (aliveTimer) {
				clearInterval(aliveTimer);
				aliveTimer = null;
			}
		});
		return;
	}
	if (ev.data?.type === 'connect' && ev.ports[0]) {
		const port = ev.ports[0];
		const bound = typeof ev.data.dbName === 'string' ? ev.data.dbName : '';
		port.onmessage = (e) => {
			const msg = e.data as Incoming;
			if (!msg || typeof msg.id !== 'number') return;
			const dbName = msg.db || bound || 'SharedVFS';
			enqueue(dbName, msg, (out) => port.postMessage(out));
		};
		port.start();
		return;
	}
	const msg = ev.data as Incoming;
	if (!msg || typeof msg.id !== 'number') return;
	enqueue(msg.db || 'SharedVFS', msg, (out) => ctx.postMessage(out));
};

pingAlive();
aliveTimer = setInterval(pingAlive, 1_000);
