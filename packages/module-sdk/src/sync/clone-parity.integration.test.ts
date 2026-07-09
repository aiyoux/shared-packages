/**
 * Clone parity regression suite.
 *
 * Guards that the TWO clone paths produce structurally identical trees:
 *   1. Server: fn::clone_from_source_array (used by /module/exec).
 *   2. Client: the real applyExecTemplateAction → CreateTreeBatch op,
 *      materialised through the real sync engine.
 *
 * It seeds a template tree exercising all three clone_setting modes
 * (default / link_to_common_clone / link_to_original) against a live
 * SurrealDB at CLONE_PARITY_DB_URL (default: http://127.0.0.1:8000) and diffs the resulting records, edges and
 * group memberships (normalised by copied_from_record, ignoring ids/times).
 *
 * Requires SurrealDB on CLONE_PARITY_DB_URL / :8000 AND a modular-app
 * checkout for the surql runtime (see surql-workspace.ts). When either is
 * missing the whole suite is skipped so ordinary `npm test` / CI without a DB
 * stays green. Run explicitly with:
 *   npm run test:clone-parity
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { loadManifestRuntime, resolveSurqlWorkspaceRoot } from './surql-workspace.ts';

// Persistence is IndexedDB-backed; no-op it so the engine runs in node and
// pushes the in-memory queued op straight to the DB (mirrors engine.test.ts).
vi.mock('../cache/persist.ts', () => ({
  persistOp: vi.fn().mockResolvedValue(undefined),
  deleteOp: vi.fn().mockResolvedValue(undefined),
  updateOpStatus: vi.fn().mockResolvedValue(undefined),
  getPendingOps: vi.fn().mockResolvedValue([]),
  getAllOps: vi.fn().mockResolvedValue([])
}));

const DB_URL = process.env.CLONE_PARITY_DB_URL ?? 'http://127.0.0.1:8000';
const NS = 'db';
const DB = `clone_parity_${Date.now()}`;
const WORKSPACE_ROOT = resolveSurqlWorkspaceRoot(__dirname);

let token = '';

// Probe reachability at module load so describe.skipIf has a real value
// (beforeAll runs after describe registration).
const dbReachable: boolean = await (async () => {
  try {
    const res = await fetch(`${DB_URL}/health`, { method: 'GET' });
    if (!res.ok && res.status !== 404) return false; // 404 still means the server answered
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

function lastResult(payload: any[]): any {
  for (let i = payload.length - 1; i >= 0; i--) {
    if (payload[i]?.status === 'OK') return payload[i].result;
  }
  return null;
}

beforeAll(async () => {
  if (!dbReachable || !WORKSPACE_ROOT) return;
  token = await signin();
  await sql(`DEFINE NAMESPACE IF NOT EXISTS ${NS};`, { ns: false });
  await sql(`USE NS ${NS}; DEFINE DATABASE IF NOT EXISTS ${DB};`, { ns: false });
  await loadManifestRuntime(WORKSPACE_ROOT, sql);
}, 120_000);

afterAll(async () => {
  if (dbReachable && WORKSPACE_ROOT) {
    await sql(`REMOVE DATABASE ${DB};`).catch(() => {});
  }
});

describe.skipIf(!dbReachable || !WORKSPACE_ROOT || process.env.SKIP_CLONE_PARITY === '1')('clone parity: server vs client', () => {
  it('produces structurally identical clone trees across all three clone_setting modes', async () => {
    // ---- Seed a template tree -------------------------------------------------
    // root (container) ─ A (default, in scope GRP)
    //                   ├ C (link_to_common_clone)
    //                   └ B (default) ─ B1 (default)
    //                                  └ EXT  (link_to_original → original kept)
    // EXT is a standalone pre-existing record (not cloned, just re-linked).
    const ids = {
      root: 'records:cp_root',
      A: 'records:cp_a',
      B: 'records:cp_b',
      B1: 'records:cp_b1',
      C: 'records:cp_c',
      EXT: 'records:cp_ext',
      GRP: 'records:cp_grp',
      EXEC: 'records:cp_exec'
    };
    const mk = (id: string, text: string) =>
      `CREATE ${id} SET text='${text}', additionals=[], created=time::now(), updated=time::now();`;
    // graph_child_of: in = child, out = parent.
    const edge = (child: string, parent: string, setting: string | null) =>
      `RELATE ${child}->graph_child_of->${parent} SET key_parent=true, order=0, module_data={planner:{role:'task',schedule:'inherit_parent'}}` +
      (setting ? `, clone_setting='${setting}'` : '') + ';';

    await sql(
      [
        mk(ids.root, 'Root'), mk(ids.A, 'A'), mk(ids.B, 'B'), mk(ids.B1, 'B1'),
        mk(ids.C, 'C'), mk(ids.EXT, 'Ext'), mk(ids.GRP, 'Grp'), mk(ids.EXEC, 'Exec'),
        edge(ids.A, ids.root, null),
        edge(ids.C, ids.root, 'link_to_common_clone'),
        edge(ids.B, ids.root, null),
        edge(ids.B1, ids.B, null),
        edge(ids.EXT, ids.B, 'link_to_original'),
        `RELATE ${ids.GRP}->groups->${ids.A} SET created=time::now(), updated=time::now();`,
        `RELATE ${ids.A}->appliesto->${ids.B} SET created=time::now(), updated=time::now();`,
        `RELATE ${ids.B1}->appliesto->${ids.EXT} SET created=time::now(), updated=time::now();`
      ].join('\n')
    );

    // ---- Server path ----------------------------------------------------------
    await sql(`
      LET $root = ${ids.root};
      LET $child_ids = (SELECT VALUE id FROM $root<-graph_child_of<-records);
      LET $new_rows = IF array::len($child_ids) > 0 {
        fn::clone_from_source_array($child_ids, NONE)
      } ELSE { [] };
      LET $new = (SELECT VALUE new_id FROM $new_rows);
      LET $scope = ${ids.EXEC};
      IF array::len($new) > 0 {
        LET $source_group_edges = (SELECT in, module_data FROM graph_child_of WHERE out = $root AND in INSIDE $child_ids);
        LET $source_group_module_data = object::from_entries($source_group_edges.map(|$edge| [<string>$edge.in, $edge.module_data]));
        FOR $row IN $new_rows {
          LET $source_module_data = $source_group_module_data[<string>$row.copied_from_record];
          RELATE $scope->groups->($row.new_id) SET created=time::now(), updated=time::now(), module_data=$source_module_data;
        };
      };
      RETURN $new;
    `);
    const serverShape = await collectCloneShape();

    // Wipe clones so the client path starts from the same template state.
    await sql(`DELETE records WHERE copied_from_record != NONE;`);

    // ---- Client path (real applyExecTemplateAction + real engine) -------------
    const { createAppCache } = await import('../cache/store.svelte.ts');
    const { createSyncEngine } = await import('./engine.ts');
    // module-exec lives in the app repo, not this package — reach it through
    // the resolved workspace root (same reason as the surql manifest).
    const { applyExecTemplateAction } = await import(
      path.join(WORKSPACE_ROOT!, 'repos/module-exec/src/exec-apply-template-action.ts')
    );

    const cache = createAppCache();
    // Seed the template into the cache so traversal + clone_setting are visible.
    const tmpl = lastResult(await sql(`SELECT * FROM records WHERE copied_from_record = NONE;`)) ?? [];
    cache.batch_upsert(tmpl as any);
    const edges = lastResult(await sql(`SELECT * FROM graph_child_of;`)) ?? [];
    for (const e of edges as any[]) {
      cache.upsert_graph_child_of_edge(
        String(e.id), String(e.in), String(e.out),
        typeof e.order === 'number' ? e.order : 0,
        e.key_parent !== false, e.module_data, e.clone_setting ?? null
      );
    }
    const gedges = lastResult(await sql(`SELECT * FROM groups;`)) ?? [];
    for (const e of gedges as any[]) {
      cache.upsert_graph_child_of_edge(
        String(e.id), String(e.out), String(e.in), 0, false, undefined, null
      );
    }
    const applies = lastResult(await sql(`SELECT * FROM appliesto;`)) ?? [];
    for (const e of applies as any[]) {
      cache.upsert_applies_edge(
        String(e.id), String(e.in), String(e.out), e.module_data
      );
    }

    let captured: any = null;
    const runtimeStub: any = {
      cache,
      queueAndWake: (_kind: string, payload: any) => { captured = payload; }
    };
    const result = applyExecTemplateAction({
      runtime: runtimeStub,
      rootItemId: ids.root,
      targetAnchor: new Date(),
      targetParentId: ids.EXEC
    });
    expect(result.ok).toBe(true);
    expect(captured).toBeTruthy();

    const liveBusStub: any = {
      broadcast: vi.fn(), onMessage: () => () => {}, rejectPendingRpcs: vi.fn()
    };
    const engine = createSyncEngine(cache as any, liveBusStub, {
      url: `${DB_URL}`,
      namespace: NS,
      database: DB,
      token,
      storageNamespace: 'clone-parity',
      scopes: [],
      logLevel: 'error'
    });
    engine.queueOp('CreateTreeBatch', captured);
    await engine.pushOps();
    const clientShape = await collectCloneShape();

    // ---- Compare structural invariants ---------------------------------------
    expect(clientShape.clonedSources).toEqual(serverShape.clonedSources);
    expect(clientShape.depthBySource).toEqual(serverShape.depthBySource);
    expect(clientShape.groupsBySource).toEqual(serverShape.groupsBySource);
    expect(clientShape.groupModuleDataBySource).toEqual(serverShape.groupModuleDataBySource);
    expect(clientShape.moduleDataBySourceEdge).toEqual(serverShape.moduleDataBySourceEdge);
    // link_to_original: EXT itself must NOT be cloned by either path…
    expect(serverShape.clonedSources).not.toContain(ids.EXT);
    expect(clientShape.clonedSources).not.toContain(ids.EXT);
    // …and the original EXT must be linked under a clone of B in both.
    expect(clientShape.extLinkedUnderCloneOfB).toBe(serverShape.extLinkedUnderCloneOfB);
    expect(serverShape.extLinkedUnderCloneOfB).toBe(true);
    // original_template_id parity: both paths must use PER-NODE semantics
    // (== copied_from_record), never the container root. Guards against the
    // ba08375 client divergence regressing.
    expect(serverShape.allOriginalArePerNode).toBe(true);
    expect(clientShape.allOriginalArePerNode).toBe(true);
    expect(clientShape.originalBySource).toEqual(serverShape.originalBySource);
    expect(clientShape.appliesBySource).toEqual(serverShape.appliesBySource);
  }, 120_000);

  /** Reduce the current clone state to id-independent structural facts. */
  async function collectCloneShape() {
    const recs = (lastResult(await sql(
      `SELECT id, copied_from_record, original_template_id FROM records WHERE copied_from_record != NONE;`
    )) ?? []) as any[];
    const cloneIdToSource = new Map<string, string>();
    // original_template_id must be PER-NODE (== copied_from_record), matching
    // the original / server fn::group_for_clone — never the container root.
    const originalBySource: Record<string, string> = {};
    let allOriginalArePerNode = true;
    for (const r of recs) {
      cloneIdToSource.set(String(r.id), String(r.copied_from_record));
      const src = String(r.copied_from_record);
      const orig = r.original_template_id == null ? '' : String(r.original_template_id);
      originalBySource[src] = orig;
      if (orig !== src) allOriginalArePerNode = false;
    }
    const clonedSources = [...cloneIdToSource.values()].sort();

    const childEdges = (lastResult(await sql(`SELECT in, out, module_data FROM graph_child_of;`)) ?? []) as any[];
    // depth of a clone = number of clone ancestors via graph_child_of.
    const parentOfClone = new Map<string, string>();
    for (const e of childEdges) {
      const cin = String(e.in);
      if (cloneIdToSource.has(cin)) parentOfClone.set(cin, String(e.out));
    }
    const depthBySource: Record<string, number> = {};
    for (const [cloneId, src] of cloneIdToSource) {
      let depth = 0;
      let cur = cloneId;
      while (parentOfClone.has(cur) && cloneIdToSource.has(parentOfClone.get(cur)!)) {
        depth++;
        cur = parentOfClone.get(cur)!;
      }
      depthBySource[src] = depth;
    }

    const gedges = (lastResult(await sql(`SELECT in, out, module_data FROM groups;`)) ?? []) as any[];
    const groupsBySource: Record<string, string[]> = {};
    const groupModuleDataBySource: Record<string, Record<string, unknown>> = {};
    for (const g of gedges) {
      const member = String(g.out);
      const src = cloneIdToSource.get(member);
      if (!src) continue;
      const groupId = String(g.in);
      (groupsBySource[src] ??= []).push(groupId);
      (groupModuleDataBySource[src] ??= {})[groupId] = g.module_data ?? null;
    }
    for (const k of Object.keys(groupsBySource)) groupsBySource[k] = groupsBySource[k].sort();

    // EXT (cp_ext) linked under a clone whose source is cp_b?
    let extLinkedUnderCloneOfB = false;
    const moduleDataBySourceEdge: Record<string, unknown> = {};
    for (const e of childEdges) {
      if (String(e.in) === 'records:cp_ext') {
        const parent = String(e.out);
        if (cloneIdToSource.get(parent) === 'records:cp_b') {
          extLinkedUnderCloneOfB = true;
          moduleDataBySourceEdge['records:cp_ext->records:cp_b'] = e.module_data ?? null;
        }
        continue;
      }

      const childSource = cloneIdToSource.get(String(e.in));
      const parentSource = cloneIdToSource.get(String(e.out));
      if (childSource && parentSource) {
        moduleDataBySourceEdge[`${childSource}->${parentSource}`] = e.module_data ?? null;
      }
    }

    const appliesEdges = (lastResult(await sql(`SELECT in, out, module_data FROM appliesto;`)) ?? []) as any[];
    const appliesBySource: { src: string; dst: string; module_data?: any }[] = [];
    for (const app of appliesEdges) {
      const srcId = String(app.in);
      const dstId = String(app.out);
      const srcKey = cloneIdToSource.get(srcId) ?? srcId;
      const dstKey = cloneIdToSource.get(dstId) ?? dstId;
      if (cloneIdToSource.has(srcId) || cloneIdToSource.has(dstId)) {
        appliesBySource.push({
          src: srcKey,
          dst: dstKey,
          module_data: app.module_data ?? null
        });
      }
    }
    appliesBySource.sort((a, b) => `${a.src}->${a.dst}`.localeCompare(`${b.src}->${b.dst}`));

    return {
      clonedSources,
      depthBySource,
      groupsBySource,
      groupModuleDataBySource,
      extLinkedUnderCloneOfB,
      originalBySource,
      allOriginalArePerNode,
      moduleDataBySourceEdge,
      appliesBySource
    };
  }
});
