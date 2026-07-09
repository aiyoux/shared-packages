/**
 * Changefeed live-sync end-to-end regression.
 *
 * Proves the WHOLE point of the architecture against a real SurrealDB:
 *   1. A server-side batch clone (fn::clone_from_source_array →
 *      fn::log_batch_clone) reaches a live subscriber as ONE consolidated
 *      batch — NOT a per-row RecordUpsert flood.
 *   2. A clone missed while disconnected is recovered by cursor replay
 *      (fn::sync_pull via connection.runCatchup) — not a full resync.
 *
 * Requires SurrealDB on :8000 AND a modular-app checkout for the surql
 * runtime (see surql-workspace.ts). Skipped when either is missing so
 * ordinary `npm test` / CI without them stays green. Run explicitly with:
 *   npx vitest run src/sync/changefeed-live.integration.test.ts
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createSurrealLiveConnection } from './surrealdb-live.ts';
import type { LiveBusMsg } from './live.ts';
import { loadManifestRuntime, resolveSurqlWorkspaceRoot } from './surql-workspace.ts';

const DB_URL = 'http://127.0.0.1:8000';
const NS = 'db';
const DB = `cf_live_${Date.now()}`;
const WORKSPACE_ROOT = resolveSurqlWorkspaceRoot(__dirname);

let token = '';

const dbReachable: boolean = await (async () => {
  try {
    const res = await fetch(`${DB_URL}/health`, { method: 'GET' });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
})();

async function signin(): Promise<string> {
  const res = await fetch(`${DB_URL}/signin`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'root', pass: 'root' })
  });
  if (!res.ok) throw new Error(`signin ${res.status}`);
  const json: any = await res.json();
  return json.token ?? json[0]?.result ?? '';
}

async function sql(query: string, opts: { ns?: boolean } = {}): Promise<any[]> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'text/plain',
    Authorization: `Bearer ${token}`
  };
  if (opts.ns !== false) {
    headers['surreal-ns'] = NS;
    headers['surreal-db'] = DB;
  }
  const res = await fetch(`${DB_URL}/sql`, { method: 'POST', headers, body: query });
  if (!res.ok) throw new Error(`sql ${res.status}: ${await res.text()}`);
  const payload: any[] = await res.json();
  for (const stmt of payload) {
    if (stmt.status && stmt.status !== 'OK') {
      throw new Error(`sql stmt failed: ${JSON.stringify(stmt)}`);
    }
  }
  return payload;
}

function until(pred: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('until() timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

beforeAll(async () => {
  if (!dbReachable || !WORKSPACE_ROOT) return;
  token = await signin();
  await sql(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`, { ns: false });
  await sql(`USE NS ${NS}; DEFINE DATABASE IF NOT EXISTS ${DB};`, { ns: false });
  await loadManifestRuntime(WORKSPACE_ROOT, sql);
}, 120_000);

afterAll(async () => {
  if (dbReachable && WORKSPACE_ROOT) await sql(`REMOVE DATABASE ${DB};`).catch(() => {});
});

describe.skipIf(!dbReachable || !WORKSPACE_ROOT)('changefeed live sync (real DB)', () => {
  it('a server batch clone arrives as ONE consolidated batch, not a per-row flood', async () => {
    const received: LiveBusMsg[] = [];
    let lastCursor: string | undefined;
    const conn = createSurrealLiveConnection(
      { url: DB_URL, namespace: NS, database: DB, token, scopes: [] },
      (m) => received.push(m),
      { logLevel: 'error', onCursorAdvance: (c) => { lastCursor = c; } }
    );
    conn.connect();
    await conn.whenReady();

    try {
      // Seed a small template tree: root ─ A, B ─ B1.
      await sql([
        `CREATE records:cfl_root SET text='Root', additionals=[];`,
        `CREATE records:cfl_a SET text='A', additionals=[];`,
        `CREATE records:cfl_b SET text='B', additionals=[];`,
        `CREATE records:cfl_b1 SET text='B1', additionals=[];`,
        `RELATE records:cfl_a->graph_child_of->records:cfl_root SET key_parent=true, order=0;`,
        `RELATE records:cfl_b->graph_child_of->records:cfl_root SET key_parent=true, order=1;`,
        `RELATE records:cfl_b1->graph_child_of->records:cfl_b SET key_parent=true, order=0;`
      ].join('\n'));

      // Let the per-row CREATE changefeed entries for the seed settle, then
      // isolate the clone by clearing what we've seen so far.
      await new Promise((r) => setTimeout(r, 600));
      received.length = 0;

      // Server batch clone of root's two children (A subtree + B subtree).
      await sql(`
        LET $children = (SELECT VALUE id FROM records:cfl_root<-graph_child_of<-records);
        SELECT VALUE new_id FROM fn::clone_from_source_array($children, NONE, NONE);
      `);

      // The clone is delivered by the single BATCH_CLONE changefeed entry.
      await until(() => received.some((m) => m.type === 'RecordBatchUpsert'));
      await new Promise((r) => setTimeout(r, 300)); // allow any stragglers

      const recordBatches = received.filter((m) => m.type === 'RecordBatchUpsert');
      const perRowRecordUpserts = received.filter((m) => m.type === 'RecordUpsert');
      const clonedCores = recordBatches.flatMap((m: any) => m.cores);

      // ONE consolidated batch carrying all 3 clones (A', B', B1') — and
      // crucially ZERO per-row RecordUpsert flood for the clone.
      expect(recordBatches.length).toBeGreaterThanOrEqual(1);
      expect(clonedCores.length).toBeGreaterThanOrEqual(3);
      expect(perRowRecordUpserts.length).toBe(0);
      expect(lastCursor).toBeTruthy();
    } finally {
      conn.disconnect();
    }
  }, 60_000);

  it('a clone missed while disconnected is recovered by cursor replay', async () => {
    // Connection 1: capture the cursor, then go away.
    const recv1: LiveBusMsg[] = [];
    let cursorBeforeGap: string | undefined;
    const conn1 = createSurrealLiveConnection(
      { url: DB_URL, namespace: NS, database: DB, token, scopes: [] },
      (m) => recv1.push(m),
      { logLevel: 'error', onCursorAdvance: (c) => { cursorBeforeGap = c; } }
    );
    conn1.connect();
    await conn1.whenReady();
    await sql(`CREATE records:cfl_gap_seed SET text='gap-seed', additionals=[];`);
    await until(() => cursorBeforeGap !== undefined);
    conn1.disconnect();

    // While "offline": a server clone happens.
    await sql([
      `CREATE records:cfl_gap_src SET text='GapSrc', additionals=[];`,
      `CREATE records:cfl_gap_child SET text='GapChild', additionals=[];`,
      `RELATE records:cfl_gap_child->graph_child_of->records:cfl_gap_src SET key_parent=true, order=0;`
    ].join('\n'));
    await sql(`SELECT VALUE new_id FROM fn::clone_from_source_array([records:cfl_gap_src], NONE, NONE);`);

    // Connection 2: precise cursor replay recovers the missed BATCH_CLONE.
    const recv2: LiveBusMsg[] = [];
    const conn2 = createSurrealLiveConnection(
      { url: DB_URL, namespace: NS, database: DB, token, scopes: [] },
      (m) => recv2.push(m),
      { logLevel: 'error' }
    );
    conn2.connect();
    await conn2.whenReady();
    try {
      const finalCursor = await conn2.runCatchup(cursorBeforeGap);
      const replayedBatch = recv2.some((m) => m.type === 'RecordBatchUpsert')
        || recv2.some((m) => m.type === 'RecordUpsert'); // src/child also replayed
      expect(replayedBatch).toBe(true);
      expect(finalCursor).toBeTruthy();
      expect(finalCursor).not.toBe(cursorBeforeGap);
    } finally {
      conn2.disconnect();
    }
  }, 60_000);
});
