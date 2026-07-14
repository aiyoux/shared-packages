/**
 * Field-stamps CAS conflict detection (M10b) real-DB integration test.
 *
 * engine.test.ts's mocked-fetch unit tests only exercise the ENGINE's own
 * dispatch/response-handling logic with a synthetic `{conflict:true,...}`
 * response body. This test materialises the actual generated SQL against a
 * live SurrealDB to verify the server-side CAS check itself: that a stale
 * `base_updated` genuinely blocks the write (record unchanged in the DB,
 * not just "the client thinks it was blocked"), that a fresh baseline lets
 * the write through and refreshes `field_stamps`, and that both
 * `resolveConflict` resolutions (`take-theirs` / `keep-mine`) round-trip
 * correctly against the real server.
 *
 * Requires SurrealDB on CONFLICT_DETECTION_DB_URL / :8000. When unreachable
 * the suite is skipped so ordinary `npm test` / CI without a DB stays green.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../cache/persist.ts', () => ({
  persistOp: vi.fn().mockResolvedValue(undefined),
  deleteOp: vi.fn().mockResolvedValue(undefined),
  updateOpStatus: vi.fn().mockResolvedValue(undefined),
  getPendingOps: vi.fn().mockResolvedValue([]),
  getAllOps: vi.fn().mockResolvedValue([])
}));

const DB_URL = process.env.CONFLICT_DETECTION_DB_URL ?? 'http://127.0.0.1:8000';
const NS = 'db';
const DB = `conflict_detection_${Date.now()}`;

let token = '';

const dbReachable: boolean = await (async () => {
  try {
    const res = await fetch(`${DB_URL}/health`, { method: 'GET' });
    if (!res.ok && res.status !== 404) return false;
    return await canSignin();
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
  const nextToken = json.token ?? json[0]?.result ?? '';
  if (!nextToken) throw new Error('signin: no token');
  return nextToken;
}

async function canSignin(): Promise<boolean> {
  try {
    await signin();
    return true;
  } catch {
    return false;
  }
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

beforeAll(async () => {
  if (!dbReachable) return;
  token = await signin();
  await sql(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`, { ns: false });
  await sql(`USE NS ${NS}; DEFINE DATABASE IF NOT EXISTS ${DB};`, { ns: false });
}, 120_000);

afterAll(async () => {
  if (dbReachable) {
    await sql(`REMOVE DATABASE ${DB};`).catch(() => {});
  }
});

async function makeEngine() {
  const { createAppCache } = await import('../cache/store.svelte.ts');
  const { createSyncEngine } = await import('./engine.ts');
  const cache = createAppCache();
  const liveBusStub = { broadcast: vi.fn(), onMessage: () => () => {}, rejectPendingRpcs: vi.fn() };
  const engine = createSyncEngine(cache as any, liveBusStub as any, {
    url: DB_URL,
    namespace: NS,
    database: DB,
    token,
    storageNamespace: `conflict-detection-${Math.random().toString(36).slice(2)}`,
    scopes: [],
    logLevel: 'error'
  });
  return { cache, engine };
}

describe.skipIf(!dbReachable || process.env.SKIP_CONFLICT_DETECTION === '1')('field-stamps CAS conflict detection (real DB)', () => {
  it('a stale base_updated blocks an UpdateRecord write and marks the op conflicted', async () => {
    const id = 'records:cd_a';
    await sql(`CREATE ${id} SET text='before', additionals=[], field_stamps={text: time::now()}, updated=time::now();`);

    const { engine } = await makeEngine();
    engine.queueOp('UpdateRecord', { id, text: 'client-edit', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();

    expect(engine.getPendingOps()).toHaveLength(0);
    const conflicted = engine.getConflictedOps();
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].conflictCurrent?.text).toBe('before');

    const rows = await sql(`SELECT text FROM ONLY ${id};`);
    expect(rows[rows.length - 1]?.result?.text).toBe('before');
  }, 30_000);

  it('a fresh base_updated lets the write through and refreshes field_stamps', async () => {
    const id = 'records:cd_b';
    await sql(`CREATE ${id} SET text='before', additionals=[], field_stamps={text: time::now()}, updated=time::now();`);
    const rows = await sql(`SELECT VALUE updated FROM ONLY ${id};`);
    const currentUpdated = rows[rows.length - 1]?.result;
    expect(typeof currentUpdated).toBe('string');

    const { engine } = await makeEngine();
    engine.queueOp('UpdateRecord', { id, text: 'good-update', _base_updated: currentUpdated });
    await engine.pushOps();

    expect(engine.getPendingOps()).toHaveLength(0);
    expect(engine.getConflictedOps()).toHaveLength(0);

    const after = await sql(`SELECT text, field_stamps FROM ONLY ${id};`);
    const result = after[after.length - 1]?.result;
    expect(result.text).toBe('good-update');
    expect(result.field_stamps.text).not.toBe(currentUpdated);
  }, 30_000);

  it('an UpdateRecord targeting an already-deleted row conflicts with deleted:true', async () => {
    const id = 'records:cd_c';
    await sql(`CREATE ${id} SET text='will-be-gone', additionals=[], updated=time::now();`);
    await sql(`DELETE ${id};`);

    const { engine } = await makeEngine();
    engine.queueOp('UpdateRecord', { id, text: 'too-late', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();

    const conflicted = engine.getConflictedOps();
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0].conflictCurrent).toBeFalsy();
  }, 30_000);

  it('DeleteTree with a stale base_updated conflicts and does NOT delete the row', async () => {
    const id = 'records:cd_d';
    await sql(`CREATE ${id} SET text='dont-delete-me', additionals=[], updated=time::now();`);

    const { engine } = await makeEngine();
    engine.queueOp('DeleteTree', { id, _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();

    expect(engine.getConflictedOps()).toHaveLength(1);
    const rows = await sql(`SELECT text FROM ONLY ${id};`);
    expect(rows[rows.length - 1]?.result?.text).toBe('dont-delete-me');
  }, 30_000);

  it('resolveConflict(take-theirs) adopts the server row, drops the op, and updates the cache', async () => {
    const id = 'records:cd_e';
    await sql(`CREATE ${id} SET text='server-wins', additionals=[], field_stamps={text: time::now()}, updated=time::now();`);

    const { engine, cache } = await makeEngine();
    engine.queueOp('UpdateRecord', { id, text: 'client-loses', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();
    const [conflictOp] = engine.getConflictedOps();
    expect(conflictOp).toBeDefined();

    const resolved = await engine.resolveConflict(conflictOp.id, 'take-theirs');
    expect(resolved).toBe(true);
    expect(engine.getConflictedOps()).toHaveLength(0);
    expect((cache as any).getItem(id)?.text).toBe('server-wins');

    const rows = await sql(`SELECT text FROM ONLY ${id};`);
    expect(rows[rows.length - 1]?.result?.text).toBe('server-wins');
  }, 30_000);

  it('resolveConflict(keep-mine) re-baselines and re-queues, and the retry then succeeds', async () => {
    const id = 'records:cd_f';
    await sql(`CREATE ${id} SET text='server-value', additionals=[], field_stamps={text: time::now()}, updated=time::now();`);

    const { engine } = await makeEngine();
    engine.queueOp('UpdateRecord', { id, text: 'client-wins', _base_updated: '2020-01-01T00:00:00.000Z' });
    await engine.pushOps();
    const [conflictOp] = engine.getConflictedOps();
    expect(conflictOp).toBeDefined();

    const resolved = await engine.resolveConflict(conflictOp.id, 'keep-mine');
    expect(resolved).toBe(true);
    // resolveConflict fires its own pushOps() in the background; wait for it
    // to settle by polling pending/inflight/conflicted (a mid-flight op is
    // 'inflight', not 'pending' — must poll all three or this races the
    // still-in-flight request).
    for (let i = 0; i < 50; i++) {
      if (
        engine.getPendingOps().length === 0 &&
        engine.getInflightOps().length === 0 &&
        engine.getConflictedOps().length === 0
      ) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(engine.getPendingOps()).toHaveLength(0);
    expect(engine.getInflightOps()).toHaveLength(0);
    expect(engine.getConflictedOps()).toHaveLength(0);

    const rows = await sql(`SELECT text FROM ONLY ${id};`);
    expect(rows[rows.length - 1]?.result?.text).toBe('client-wins');
  }, 30_000);
});
