/**
 * Batch-envelope (M10) real-DB integration test.
 *
 * The unit tests in engine.test.ts mock fetch and only inspect the generated
 * SQL string. This test materialises SEVERAL independent ops through the
 * real sync engine's scheduler against a live SurrealDB (default
 * http://127.0.0.1:8000), which de-risks the part that only a real server
 * can validate: that `build_op_sql`/`build_op_vars`'s UNMODIFIED output,
 * wrapped in a `{ }` block with a namespaced LET-rebinding preamble and
 * concatenated with other ops' blocks in ONE request, actually parses and
 * executes correctly — and that one op's failure inside that combined
 * request does not affect its batch-mates (block-level isolation).
 *
 * Requires SurrealDB on BATCH_ENVELOPE_DB_URL / :8000. When unreachable the
 * suite is skipped so ordinary `npm test` / CI without a DB stays green.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../cache/persist.ts', () => ({
  persistOp: vi.fn().mockResolvedValue(undefined),
  deleteOp: vi.fn().mockResolvedValue(undefined),
  updateOpStatus: vi.fn().mockResolvedValue(undefined),
  getPendingOps: vi.fn().mockResolvedValue([]),
  getAllOps: vi.fn().mockResolvedValue([])
}));

const DB_URL = process.env.BATCH_ENVELOPE_DB_URL ?? 'http://127.0.0.1:8000';
const NS = 'db';
const DB = `batch_envelope_${Date.now()}`;

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
  const attempts = [
    { user: 'root', pass: 'root' },
    { NS, DB, user: 'root', pass: 'root' }
  ];
  let lastStatus = 0;
  for (const body of attempts) {
    const res = await fetch(`${DB_URL}/signin`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    lastStatus = res.status;
    if (!res.ok) continue;
    const json: any = await res.json();
    const nextToken = json.token ?? json[0]?.result ?? '';
    if (nextToken) return nextToken;
  }
  throw new Error(`signin ${lastStatus}`);
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

describe.skipIf(!dbReachable || process.env.SKIP_BATCH_ENVELOPE === '1')('batch envelope (real DB)', () => {
  it('applies several independent UpdateRecord ops via ONE combined request', async () => {
    const a = 'records:be_a';
    const b = 'records:be_b';
    const c = 'records:be_c';
    await sql(
      [
        `CREATE ${a} SET text='before-a', additionals=[];`,
        `CREATE ${b} SET text='before-b', additionals=[];`,
        `CREATE ${c} SET text='before-c', additionals=[];`
      ].join('\n')
    );

    const { createAppCache } = await import('../cache/store.svelte.ts');
    const { createSyncEngine } = await import('./engine.ts');
    const cache = createAppCache();
    const fetchCalls: string[] = [];
    const realFetch = fetch;
    const spiedFetch = vi.fn(async (url: any, init: any) => {
      if (typeof init?.body === 'string') fetchCalls.push(init.body);
      return realFetch(url, init);
    });
    vi.stubGlobal('fetch', spiedFetch);

    try {
      const liveBusStub = { broadcast: vi.fn(), onMessage: () => () => {}, rejectPendingRpcs: vi.fn() };
      const engine = createSyncEngine(cache as any, liveBusStub as any, {
        url: DB_URL,
        namespace: NS,
        database: DB,
        token,
        storageNamespace: 'batch-envelope-independent',
        scopes: [],
        logLevel: 'error'
      });

      engine.queueOp('UpdateRecord', { id: a, text: 'after-a' });
      engine.queueOp('UpdateRecord', { id: b, text: 'after-b' });
      engine.queueOp('UpdateRecord', { id: c, text: 'after-c' });
      await engine.pushOps();

      expect(engine.getPendingOps()).toHaveLength(0);

      // The 3 independent ops landed in ONE request (a `{ }`-wrapped block per
      // op, each preceded by its own namespaced LET-rebinding preamble) —
      // NOT 3 separate requests. cleanupSyncMarkers is a 2nd, later call.
      const opRequests = fetchCalls.filter((body) => body.includes('after-a') || body.includes('after-b') || body.includes('after-c'));
      expect(opRequests).toHaveLength(1);
      expect(opRequests[0]).toContain('LET $id = $b0_id;');
      expect(opRequests[0]).toContain('LET $id = $b1_id;');
      expect(opRequests[0]).toContain('LET $id = $b2_id;');

      const rows = await sql(`SELECT text FROM [${a}, ${b}, ${c}];`);
      const texts = (rows[rows.length - 1]?.result ?? []).map((r: any) => r.text).sort();
      expect(texts).toEqual(['after-a', 'after-b', 'after-c']);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('one batch-mate erroring does not affect the others (block isolation)', async () => {
    const ok1 = 'records:be_ok1';
    const ok2 = 'records:be_ok2';
    await sql(
      [
        `CREATE ${ok1} SET text='before-ok1', additionals=[];`,
        `CREATE ${ok2} SET text='before-ok2', additionals=[];`
      ].join('\n')
    );

    const { createAppCache } = await import('../cache/store.svelte.ts');
    const { createSyncEngine } = await import('./engine.ts');
    const cache = createAppCache();

    const liveBusStub = { broadcast: vi.fn(), onMessage: () => () => {}, rejectPendingRpcs: vi.fn() };
    const engine = createSyncEngine(cache as any, liveBusStub as any, {
      url: DB_URL,
      namespace: NS,
      database: DB,
      token,
      storageNamespace: 'batch-envelope-isolation',
      scopes: [],
      logLevel: 'error'
    });

    engine.queueOp('UpdateRecord', { id: ok1, text: 'after-ok1' });
    // A malformed record id makes `type::record($id)` genuinely throw
    // server-side (verified directly against SurrealDB: "Could not cast into
    // `record` using input …") — a real, non-network failure for THIS op's
    // block only, confirming block-level isolation with the engine's actual
    // generated SQL rather than a synthetic mocked error.
    engine.queueOp('UpdateRecord', { id: 'not-a-valid-record-id', text: 'never-applied' });
    engine.queueOp('UpdateRecord', { id: ok2, text: 'after-ok2' });
    await engine.pushOps();

    // The two healthy ops accepted; only the bad one is left pending (finite
    // server-error retry cap — never reaches 'rejected' within one pushOps()
    // call, but critically it must NOT have blocked/failed its batch-mates).
    const pending = engine.getPendingOps();
    expect(pending.map((p) => (p.payload as any).id)).toEqual(['not-a-valid-record-id']);

    const rows = await sql(`SELECT text FROM [${ok1}, ${ok2}];`);
    const texts = (rows[rows.length - 1]?.result ?? []).map((r: any) => r.text).sort();
    expect(texts).toEqual(['after-ok1', 'after-ok2']);
  }, 30_000);
});
