import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScopeVariants,
  matchesScope,
  normalizeScopes,
  collectScopedRecordIds,
  collectStaleGroupingEdgeIds,
  collectStaleAppliesEdgeIds,
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
    // The snapshot fetch is namespace-wide (SELECT * FROM <edge_table>), so
    // any cached edge id missing from the fetched set is authoritatively
    // stale — including edges with endpoints that don't intersect the active
    // scope, which is how ghost edges from past bugs (e.g. the MoveChild
    // in/out swap) used to survive reconcile.
    const scopedRecordIds = new Set(['records:a', 'records:b']);

    const staleGrouping = collectStaleGroupingEdgeIds(
      [
        { edge_id: 'grouping:keep', parent_id: 'records:a', child_id: 'records:b' },
        { edge_id: 'grouping:drop', parent_id: 'records:a', child_id: 'records:c' },
        { edge_id: 'grouping:ghost', parent_id: 'records:x', child_id: 'records:y' }
      ],
      scopedRecordIds,
      [{ id: 'grouping:keep' }]
    );

    const staleApplies = collectStaleAppliesEdgeIds(
      [
        { edge_id: 'applies:keep', src_id: 'records:b', dst_id: 'records:c' },
        { edge_id: 'applies:drop', src_id: 'records:z', dst_id: 'records:a' },
        { edge_id: 'applies:ghost', src_id: 'records:x', dst_id: 'records:y' }
      ],
      scopedRecordIds,
      [{ id: 'applies:keep' }]
    );

    expect(staleGrouping.sort()).toEqual(['grouping:drop', 'grouping:ghost']);
    expect(staleApplies.sort()).toEqual(['applies:drop', 'applies:ghost']);
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
