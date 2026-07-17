import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildScopeVariants,
  matchesScope,
  normalizeScopes,
  collectScopedRecordIds,
  collectStaleGroupingEdgeIds,
  collectStaleAppliesEdgeIds,
  computeGhostRecordIds,
  deriveOptimisticLiveMessages,
  createAppRuntime,
  normalizeRecordPermissions,
  normalizeRecordRow
} from './runtime.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime snapshot reconciliation helpers', () => {
  it('matches scopes regardless of records: prefixing', () => {
    expect(matchesScope('work', ['work'])).toBe(true);
    expect(matchesScope('records:work', ['work'])).toBe(true);
    expect(matchesScope('personal', ['work'])).toBe(false);
  });

  it('normalizes scope lists and expands them into query variants', () => {
    expect(normalizeScopes(['work', 'records:work', '', 'personal'])).toEqual(['work', 'personal']);
    expect(buildScopeVariants(['work', 'records:personal']).sort()).toEqual([
      'personal',
      'records:personal',
      'records:work',
      'work'
    ]);
  });

  it('normalizes database-shaped permissions onto fetched record rows', () => {
    expect(
      normalizeRecordPermissions([
        { r: 'editor', u: 'users:abc' },
        { role: 'viewer', user_id: 'records:def', username: 'Viewer' },
        { r: 'invalid', u: 'users:ignored' }
      ])
    ).toEqual([
      { role: 'editor', user_id: 'users:abc', username: undefined, user_icon_small: undefined },
      { role: 'viewer', user_id: 'records:def', username: 'Viewer', user_icon_small: undefined }
    ]);

    expect(
      normalizeRecordRow({
        id: 'records:1',
        permissions: [{ r: 'editor', u: 'users:abc' }]
      })?.permissions
    ).toEqual([{ role: 'editor', user_id: 'users:abc', username: undefined, user_icon_small: undefined }]);
  });

  it('collects scoped record ids from scope buckets and fetched records', () => {
    const ids = collectScopedRecordIds(
      ['work'],
      [
        { id: 'records:1' },
        { id: 'records:2' }
      ],
      [
        { scope: 'work', item_ids: ['records:3'] },
        { scope: 'personal', item_ids: ['records:4'] }
      ],
      [
        { id: 'records:5' }
      ]
    );

    expect([...ids].sort()).toEqual(['records:3', 'records:5']);
  });

  it('prunes every cached edge whose id is absent from the namespace-wide snapshot', () => {
    // Unscoped (`scoped = false`): the snapshot fetch is namespace-wide
    // (SELECT * FROM <edge_table>), so any cached edge id missing from the
    // fetched set is authoritatively stale — including edges with endpoints
    // that don't intersect the active scope, which is how ghost edges from past
    // bugs (e.g. the MoveChild in/out swap) used to survive reconcile.
    const staleGrouping = collectStaleGroupingEdgeIds(
      [
        { edge_id: 'grouping:keep', parent_id: 'records:a', child_id: 'records:b' },
        { edge_id: 'grouping:drop', parent_id: 'records:a', child_id: 'records:c' },
        { edge_id: 'grouping:ghost', parent_id: 'records:x', child_id: 'records:y' }
      ],
      false,
      [{ id: 'grouping:keep' }]
    );

    const staleApplies = collectStaleAppliesEdgeIds(
      [
        { edge_id: 'applies:keep', src_id: 'records:b', dst_id: 'records:c' },
        { edge_id: 'applies:drop', src_id: 'records:z', dst_id: 'records:a' },
        { edge_id: 'applies:ghost', src_id: 'records:x', dst_id: 'records:y' }
      ],
      false,
      [{ id: 'applies:keep' }]
    );

    expect(staleGrouping.sort()).toEqual(['grouping:drop', 'grouping:ghost']);
    expect(staleApplies.sort()).toEqual(['applies:drop', 'applies:ghost']);
  });

  it('scoped reconcile keeps cross-scope edges and drops only in-scope stale edges', () => {
    // Scoped (`scoped = true`): the fetch covers ONLY this scope's subtree, so
    // an absent edge id is not automatically stale — cross-scope edges held in
    // the persistent cache must survive (otherwise they're deleted and
    // re-fetched on every scope switch). Only edges touching this scope's
    // subtree (an endpoint among the fetched rows' endpoints) that aren't in
    // the fetched set are stale.
    const staleGrouping = collectStaleGroupingEdgeIds(
      [
        // in-scope, present -> keep
        { edge_id: 'grouping:keep', parent_id: 'records:a', child_id: 'records:b' },
        // in-scope (parent a), absent -> stale
        { edge_id: 'grouping:drop', parent_id: 'records:a', child_id: 'records:c' },
        // cross-scope (parent x, child y) -> keep
        { edge_id: 'grouping:ghost', parent_id: 'records:x', child_id: 'records:y' }
      ],
      true,
      [{ id: 'grouping:keep', in: 'records:b', out: 'records:a' }]
    );

    const staleApplies = collectStaleAppliesEdgeIds(
      [
        { edge_id: 'applies:keep', src_id: 'records:b', dst_id: 'records:c' },
        // in-scope (src b), absent -> stale
        { edge_id: 'applies:drop', src_id: 'records:b', dst_id: 'records:d' },
        // cross-scope (src x, dst y) -> keep
        { edge_id: 'applies:ghost', src_id: 'records:x', dst_id: 'records:y' }
      ],
      true,
      [{ id: 'applies:keep', in: 'records:b', out: 'records:c' }]
    );

    expect(staleGrouping.sort()).toEqual(['grouping:drop']);
    expect(staleApplies.sort()).toEqual(['applies:drop']);
  });

  it('derives optimistic live patch messages for UpdateRecord ops', () => {
    expect(
      deriveOptimisticLiveMessages('UpdateRecord', {
        id: 'records:1',
        text: 'Updated',
        additionals: [{ id: 'p1', type: 'pg', prog_type: { ch: 't' }, computed: false }],
        custom_color: 7,
        show_as_header: true,
        module_settings: { status: 'done' }
      })
    ).toEqual([
      { type: 'RecordPatchText', id: 'records:1', text: 'Updated' },
      { type: 'RecordPatchColor', id: 'records:1', color: 7 },
      { type: 'RecordPatchHeader', id: 'records:1', isHeader: true },
      {
        type: 'RecordPatchAdditionals',
        id: 'records:1',
        additionals: [{ id: 'p1', type: 'pg', prog_type: { ch: 't' }, computed: false }],
        // Merge-shaped: upserts by id + explicit removals (omission never deletes).
        removedIds: undefined,
        merge: true
      },
      { type: 'RecordPatchModuleSettings', id: 'records:1', moduleSettings: { status: 'done' } }
    ]);
  });

  it('ignores non-record or malformed optimistic ops', () => {
    expect(deriveOptimisticLiveMessages('AddChild', { parent: 'records:a', child: 'records:b' })).toEqual([]);
    expect(deriveOptimisticLiveMessages('UpdateRecord', { text: 'missing id' })).toEqual([]);
  });
});

describe('computeGhostRecordIds (M9 post-gap sweep)', () => {
  it('flags cached ids the server no longer has', () => {
    const ghosts = computeGhostRecordIds(
      ['records:a', 'records:b', 'records:c'],
      new Set(['records:a', 'records:c'])
    );
    expect(ghosts).toEqual(['records:b']);
  });

  it('flags nothing when every probed id was found', () => {
    expect(computeGhostRecordIds(['records:a', 'records:b'], new Set(['records:a', 'records:b']))).toEqual([]);
  });

  it('flags everything when the server found none of them', () => {
    expect(computeGhostRecordIds(['records:a', 'records:b'], new Set())).toEqual(['records:a', 'records:b']);
  });

  it('is a no-op over an empty probe list', () => {
    expect(computeGhostRecordIds([], new Set(['records:a']))).toEqual([]);
  });
});

describe('CloneTemplateChildren SQL', () => {
  it('joins top-level clones to a target scope without per-clone provenance lookups', async () => {
    let postedSql = '';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ result: ['records:new_child'] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      postedSql = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify([{ result: ['records:new_child'] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const runtime = createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-test'
    });

    const rows = await runtime.fetchAndCache({
      type: 'CloneTemplateChildren',
      rootId: 'records:template_root',
      targetScopeId: 'records:exec_scope',
      anchor: '2026-04-21T00:00:00.000Z'
    });

    expect(rows).toEqual(['records:new_child']);
    expect(postedSql).toContain('LET $new_rows = IF array::len($sources) > 0');
    expect(postedSql).toContain("fn::clone_from_source_array($sources, d'2026-04-21T00:00:00.000Z', NONE)");
    expect(postedSql).toContain('LET $source_group_module_data = object::from_entries');
    expect(postedSql).toContain('FOR $row IN $new_rows');
    expect(postedSql).toContain('RELATE $scope->groups->($row.new_id)');
    expect(postedSql).not.toContain('SELECT VALUE copied_from_record FROM ONLY');
    expect(postedSql).not.toContain('LIMIT 1)[0]');

    runtime.destroy();
  });
});

describe('FetchRecordsByDateRange permission normalization (regression: remove one of two -> both gone)', () => {
  it('renames stored { u, r } permissions to { user_id, role } and enriches with []', async () => {
    // This is the calendar's actual date-range fetch. Unlike the other
    // fetch cases in this file it used to return raw rows unnormalized, so
    // a record's permissions kept the stored { u, r } shape -- which fails
    // the calendar editor's user_id/role string filter and silently drops
    // every permission entry, even before any save happens.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            result: [
              {
                id: 'records:evt1',
                text: 'hi',
                permissions: [{ u: 'users:abc', r: 'editor', username: 'Alice', user_icon_small: 'img:abc' }]
              },
              { id: 'records:evt2', text: 'no perms', permissions: [] }
            ]
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const runtime = createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-test-date-range'
    });

    const rows = await runtime.fetchAndCache({
      type: 'FetchRecordsByDateRange',
      scopes: [],
      only_status: false,
      year: 2026, month: 7, day: 15,
      eyear: 2026, emonth: 7, eday: 15
    } as any);

    expect(rows).toEqual([
      {
        id: 'records:evt1',
        text: 'hi',
        permissions: [{ role: 'editor', user_id: 'users:abc', username: 'Alice', user_icon_small: 'img:abc' }]
      },
      { id: 'records:evt2', text: 'no perms', permissions: [] }
    ]);

    runtime.destroy();
  });

  it('projects [] rather than none for permission-less records in the outgoing SQL', async () => {
    let postedSql = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      postedSql = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify([{ result: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const runtime = createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-test-date-range-2'
    });

    await runtime.fetchAndCache({
      type: 'FetchRecordsByDateRange',
      scopes: [],
      only_status: false,
      year: 2026, month: 7, day: 15,
      eyear: 2026, emonth: 7, eday: 15
    } as any);

    expect(postedSql).toContain('} ELSE { [] }) AS permissions,');
    runtime.destroy();
  });
});

describe('AppRuntime pause/resume (active/warm lifecycle surface)', () => {
  // The node test env has no window/navigator.locks, so createLeaderElection
  // returns the non-browser stub whose release/resumeAcquire are no-ops. That
  // is enough to assert the API surface and the destroyed-guard / pre-start
  // no-op contracts without a full IDB + WebSocket + locks harness (which this
  // package does not have). The resume() live-connection recreate + changefeed
  // catch-up ride existing, production-tested paths exercised by the manual
  // multi-connection switch test.

  function makeRuntime() {
    return createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-pause-test'
    });
  }

  it('exposes pause and resume as functions', () => {
    const runtime = makeRuntime();
    expect(typeof runtime.pause).toBe('function');
    expect(typeof runtime.resume).toBe('function');
    runtime.destroy();
  });

  it('pause() before start() is a no-op and does not mark destroyed', () => {
    const runtime = makeRuntime();
    expect(() => runtime.pause()).not.toThrow();
    runtime.destroy();
  });

  it('pause() after destroy() is a no-op', () => {
    const runtime = makeRuntime();
    runtime.destroy();
    expect(() => runtime.pause()).not.toThrow();
  });

  it('resume() after destroy() is a no-op', () => {
    const runtime = makeRuntime();
    runtime.destroy();
    // resume() guards on `destroyed` before touching IDB / bus, so a destroyed
    // runtime must not attempt any I/O.
    expect(() => runtime.resume()).not.toThrow();
  });

  it('pause() then destroy() is clean', () => {
    const runtime = makeRuntime();
    runtime.pause();
    expect(() => runtime.destroy()).not.toThrow();
  });
});

describe('AppRuntime read-only gate (M12: expired-session offline)', () => {
  function makeRuntime() {
    return createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-readonly-test'
    });
  }

  it('defaults to writable', () => {
    const runtime = makeRuntime();
    expect(runtime.isReadOnly()).toBe(false);
    runtime.destroy();
  });

  it('setReadOnly toggles isReadOnly', () => {
    const runtime = makeRuntime();
    runtime.setReadOnly(true);
    expect(runtime.isReadOnly()).toBe(true);
    runtime.setReadOnly(false);
    expect(runtime.isReadOnly()).toBe(false);
    runtime.destroy();
  });

  it('queueAndWake is a no-op while read-only: no op is queued, no push attempted', () => {
    const runtime = makeRuntime();
    const queueOpSpy = vi.spyOn(runtime.engine, 'queueOp');
    const pushOpsSpy = vi.spyOn(runtime.engine, 'pushOps').mockResolvedValue(undefined);

    runtime.setReadOnly(true);
    runtime.queueAndWake('UpdateRecord', { id: 'records:a', text: 'blocked' });

    expect(queueOpSpy).not.toHaveBeenCalled();
    expect(pushOpsSpy).not.toHaveBeenCalled();
    runtime.destroy();
  });

  it('queueAndWake resumes queuing once read-only is cleared', () => {
    const runtime = makeRuntime();
    const queueOpSpy = vi.spyOn(runtime.engine, 'queueOp');
    vi.spyOn(runtime.engine, 'pushOps').mockResolvedValue(undefined);

    runtime.setReadOnly(true);
    runtime.queueAndWake('UpdateRecord', { id: 'records:a', text: 'blocked' });
    expect(queueOpSpy).not.toHaveBeenCalled();

    runtime.setReadOnly(false);
    runtime.queueAndWake('UpdateRecord', { id: 'records:a', text: 'allowed' });
    expect(queueOpSpy).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });
});

describe('CloneTemplateChildren opId idempotency guard', () => {
  function makeRuntime() {
    return createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-opid-test'
    });
  }

  function mockFetchCapturingBody(returnRows: any[] = ['records:new_child']) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Response(JSON.stringify([{ result: returnRows }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
  }

  it('emits the _sync_op_id guard + tag when opId is provided', async () => {
    let postedSql = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      postedSql = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify([{ result: ['records:new_child'] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const runtime = makeRuntime();
    await runtime.fetchAndCache({
      type: 'CloneTemplateChildren',
      rootId: 'records:template_root',
      opId: 'op-123',
      anchor: '2026-04-21T00:00:00.000Z'
    });
    expect(postedSql).toContain('LET $op_id = "op-123"');
    expect(postedSql).toContain('LET $existing = (SELECT VALUE id FROM records WHERE _sync_op_id = $op_id)');
    expect(postedSql).toContain('IF array::len($existing) > 0 { RETURN $existing }');
    expect(postedSql).toContain('UPDATE $new SET _sync_op_id = $op_id');
    runtime.destroy();
  });

  it('omits the guard entirely when no opId is provided (compat)', async () => {
    let postedSql = '';
    mockFetchCapturingBody();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      postedSql = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify([{ result: ['records:new_child'] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const runtime = makeRuntime();
    await runtime.fetchAndCache({
      type: 'CloneTemplateChildren',
      rootId: 'records:template_root',
      anchor: '2026-04-21T00:00:00.000Z'
    });
    expect(postedSql).not.toContain('_sync_op_id');
    runtime.destroy();
  });
});

describe('executeQuery timeout / proxy-fallback handling', () => {
  // The proxy-fallback + AbortError branches in executeQuery are browser-only
  // (the catch rethrows immediately when `typeof window === 'undefined'`). The
  // runtime is constructed in the node env (no window, so createLiveBus skips
  // its storage listener), then `window` is defined only around the
  // fetchAndCache call so executeQuery's catch takes the browser branch.
  function makeRuntime() {
    return createAppRuntime({
      url: 'http://127.0.0.1:8000',
      namespace: 'db',
      database: 'db',
      token: 'token',
      scopes: [],
      isolationKey: 'runtime-timeout-test'
    });
  }

  async function withWindow<T>(fn: () => Promise<T>): Promise<T> {
    const g = globalThis as { window?: unknown };
    const saved = g.window;
    g.window = {};
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete g.window;
      else g.window = saved;
    }
  }

  it('an AbortError (timeout) throws a timeout Error and does NOT re-POST via the proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/sql')) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      throw new Error('proxy should not be called');
    });
    const runtime = makeRuntime();
    await withWindow(() =>
      expect(
        runtime.fetchAndCache({
          type: 'CloneTemplateChildren',
          rootId: 'records:t',
          anchor: '2026-04-21T00:00:00.000Z'
        })
      ).rejects.toThrow(/timeout after 30000ms/)
    );
    const proxyCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/runtime/sql'));
    expect(proxyCalls).toHaveLength(0);
    runtime.destroy();
  });

  it('a TypeError (network failure) falls back to the /api/runtime/sql proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/api/runtime/sql')) {
        return new Response(JSON.stringify([{ result: ['records:new_child'] }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // direct /sql endpoint: genuine network failure
      throw new TypeError('fetch failed');
    });
    const runtime = makeRuntime();
    const rows = await withWindow(() =>
      runtime.fetchAndCache({
        type: 'CloneTemplateChildren',
        rootId: 'records:t',
        anchor: '2026-04-21T00:00:00.000Z'
      })
    );
    const proxyCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/runtime/sql'));
    expect(proxyCalls.length).toBeGreaterThanOrEqual(1);
    expect(rows).toEqual(['records:new_child']);
    runtime.destroy();
  });

  it('rethrows non-AbortError, non-TypeError errors without proxy fallback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/sql')) throw new Error('boom');
      throw new Error('proxy should not be called');
    });
    const runtime = makeRuntime();
    await withWindow(() =>
      expect(
        runtime.fetchAndCache({
          type: 'CloneTemplateChildren',
          rootId: 'records:t',
          anchor: '2026-04-21T00:00:00.000Z'
        })
      ).rejects.toThrow('boom')
    );
    const proxyCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/runtime/sql'));
    expect(proxyCalls).toHaveLength(0);
    runtime.destroy();
  });
});
