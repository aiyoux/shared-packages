/**
 * UpdateRelationsBatch real-DB integration test.
 *
 * The unit test in engine.test.ts only inspects the generated SQL string and a
 * mocked response. This test materialises a real `UpdateRelationsBatch` op
 * through the real sync engine against a live SurrealDB (default
 * http://127.0.0.1:8000), which de-risks the parts that only SurrealDB 3.x can
 * validate:
 *  - the `LET $x = IF $ex != NONE { $ex } ELSE { (RELATE …)[0] }` idempotency
 *    expression actually parses + executes and returns the edge row,
 *  - the `RETURN { addedGroups: […], addedApplies: […] }` shape round-trips and
 *    `extractRelationsBatchResult` finds it,
 *  - edges land in the `groups` / `appliesto` tables (never a phantom `applies`
 *    table),
 *  - re-running the same op creates no duplicate edges,
 *  - removals `DELETE type::record($id)` the concrete edge ids.
 *
 * Requires SurrealDB on RELATIONS_DB_URL / :8000. When unreachable the suite is
 * skipped so ordinary `npm test` / CI without a DB stays green.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

// Persistence is IndexedDB-backed; no-op it so the engine runs in node and
// pushes the in-memory queued op straight to the DB (mirrors engine.test.ts).
vi.mock('../cache/persist.ts', () => ({
  persistOp: vi.fn().mockResolvedValue(undefined),
  deleteOp: vi.fn().mockResolvedValue(undefined),
  updateOpStatus: vi.fn().mockResolvedValue(undefined),
  getPendingOps: vi.fn().mockResolvedValue([]),
  getAllOps: vi.fn().mockResolvedValue([])
}));

const DB_URL = process.env.RELATIONS_DB_URL ?? 'http://127.0.0.1:8000';
const NS = 'db';
const DB = `relations_batch_${Date.now()}`;

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

function rowsOf(payload: any[]): any[] {
  for (let i = payload.length - 1; i >= 0; i--) {
    if (payload[i]?.status === 'OK' && Array.isArray(payload[i].result)) return payload[i].result;
  }
  return [];
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

describe.skipIf(!dbReachable || process.env.SKIP_RELATIONS_BATCH === '1')('UpdateRelationsBatch (real DB)', () => {
  it('adds groups/applies edges idempotently and removes them, in one op each', async () => {
    const member = 'records:rb_member';
    const grp1 = 'records:rb_grp1';
    const grp2 = 'records:rb_grp2';
    const conn1 = 'records:rb_conn1';

    // Seed records. Define the relation tables explicitly (the real app defines
    // them via the surql manifest with PERMISSIONS + a changefeed); the
    // idempotency guard `SELECT * FROM appliesto WHERE …` runs before any
    // RELATE would implicitly create the table, so the table must pre-exist.
    await sql(
      [
        `DEFINE TABLE groups SCHEMALESS;`,
        `DEFINE TABLE appliesto SCHEMALESS;`,
        `CREATE ${member} SET text='Member', additionals=[];`,
        `CREATE ${grp1} SET text='Group 1', additionals=[];`,
        `CREATE ${grp2} SET text='Group 2', additionals=[];`,
        `CREATE ${conn1} SET text='Connection 1', additionals=[];`,
        // Pre-existing grp1 -> member edge: addGroups with grp1 must be a no-op
        // (idempotency), grp2 is a fresh add.
        `RELATE ${grp1}->groups->${member};`
      ].join('\n')
    );

    const { createAppCache } = await import('../cache/store.svelte.ts');
    const { createSyncEngine } = await import('./engine.ts');
    const cache = createAppCache();
    const liveBusStub = {
      broadcast: vi.fn(), onMessage: () => () => {}, rejectPendingRpcs: vi.fn()
    };
    const engine = createSyncEngine(cache as any, liveBusStub as any, {
      url: DB_URL,
      namespace: NS,
      database: DB,
      token,
      storageNamespace: 'relations-batch',
      scopes: [],
      logLevel: 'error'
    });

    // ---- 1. Add grp1 (dup, idempotent) + grp2 (new) + member->conn1 (new) ----
    engine.queueOp('UpdateRelationsBatch', {
      addGroups: [
        { src: grp1, dst: member },
        { src: grp2, dst: member }
      ],
      removeGroups: [],
      addApplies: [{ src: member, dst: conn1 }],
      removeApplies: []
    });
    await engine.pushOps();
    if (engine.getPendingOps().length) {
      throw new Error(`op not accepted: ${JSON.stringify(engine.getPendingOps()[0], null, 2)}`);
    }
    expect(engine.getPendingOps()).toHaveLength(0);

    let groupEdges = rowsOf(await sql(`SELECT in, out FROM groups WHERE out = ${member};`));
    expect(groupEdges).toHaveLength(2);
    expect(new Set(groupEdges.map((e: any) => String(e.in)))).toEqual(new Set([grp1, grp2]));

    let appliestoEdges = rowsOf(await sql(`SELECT in, out FROM appliesto WHERE in = ${member};`));
    expect(appliestoEdges).toHaveLength(1);
    expect(String(appliestoEdges[0].out)).toBe(conn1);

    // No phantom `applies` table should ever have been written.
    const phantom = rowsOf(await sql(`SELECT count() FROM applies GROUP ALL;`).catch(() => []));
    expect(phantom).toHaveLength(0);

    // ---- 2. Idempotency: re-run the identical add op → no duplicate edges ----
    engine.queueOp('UpdateRelationsBatch', {
      addGroups: [
        { src: grp1, dst: member },
        { src: grp2, dst: member }
      ],
      removeGroups: [],
      addApplies: [{ src: member, dst: conn1 }],
      removeApplies: []
    });
    await engine.pushOps();
    expect(engine.getPendingOps()).toHaveLength(0);

    groupEdges = rowsOf(await sql(`SELECT in, out FROM groups WHERE out = ${member};`));
    expect(groupEdges).toHaveLength(2);
    appliestoEdges = rowsOf(await sql(`SELECT in, out FROM appliesto WHERE in = ${member};`));
    expect(appliestoEdges).toHaveLength(1);

    // ---- 3. Remove grp2 and the member->conn1 edge (grp1 stays) -------------
    const grp2Edge = rowsOf(await sql(`SELECT id FROM groups WHERE in = ${grp2} AND out = ${member};`))[0];
    const appliesEdge = rowsOf(await sql(`SELECT id FROM appliesto WHERE in = ${member} AND out = ${conn1};`))[0];
    expect(grp2Edge).toBeTruthy();
    expect(appliesEdge).toBeTruthy();

    engine.queueOp('UpdateRelationsBatch', {
      addGroups: [],
      removeGroups: [{ id: String(grp2Edge.id) }],
      addApplies: [],
      removeApplies: [{ id: String(appliesEdge.id) }]
    });
    await engine.pushOps();
    expect(engine.getPendingOps()).toHaveLength(0);

    groupEdges = rowsOf(await sql(`SELECT in, out FROM groups WHERE out = ${member};`));
    expect(groupEdges).toHaveLength(1);
    expect(String(groupEdges[0].in)).toBe(grp1);

    appliestoEdges = rowsOf(await sql(`SELECT in, out FROM appliesto WHERE in = ${member};`));
    expect(appliestoEdges).toHaveLength(0);
  }, 60_000);
});