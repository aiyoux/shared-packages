import { describe, expect, it, vi } from 'vitest';
import type { LiveBusMsg } from './live.ts';
import { createChangefeedDispatcher, type ChangefeedDispatchDeps } from './changefeed-dispatch.ts';

function harness(overrides: Partial<ChangefeedDispatchDeps> = {}) {
  const emitted: LiveBusMsg[] = [];
  const cursors: string[] = [];
  const selectByIds = vi.fn(async (_ids: string[]) => [] as unknown[]);
  const syncPull = vi.fn(async (_s: string | undefined, _l: number) => ({ changes: [] as unknown[] }));
  const deps: ChangefeedDispatchDeps = {
    selectByIds,
    syncPull,
    emit: (m) => emitted.push(m),
    onCursorAdvance: (c) => cursors.push(c),
    ...overrides
  };
  return {
    ...createChangefeedDispatcher(deps),
    emitted,
    cursors,
    // Return the functions ACTUALLY wired into deps (override or default).
    selectByIds: deps.selectByIds as ReturnType<typeof vi.fn>,
    syncPull: deps.syncPull as ReturnType<typeof vi.fn>
  };
}

describe('dispatchChangeRow — payload.after is the source of truth', () => {
  it('CREATE with payload.after emits without any refetch', async () => {
    const h = harness();
    await h.dispatchChangeRow({
      table_name: 'records',
      action: 'CREATE',
      record_id: 'records:r1',
      cursor_id: 'c-1',
      payload: { after: { id: 'records:r1', text: 'hello' } }
    });
    expect(h.selectByIds).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([{ type: 'RecordUpsert', core: expect.objectContaining({ id: 'records:r1', text: 'hello' }) }]);
    expect(h.cursors).toEqual(['c-1']);
  });

  it('UPDATE of a graph_child_of edge via payload.after', async () => {
    const h = harness();
    await h.dispatchChangeRow({
      table_name: 'graph_child_of',
      action: 'UPDATE',
      payload: { after: { id: 'graph_child_of:e1', in: 'records:c', out: 'records:p', order: 2 } }
    });
    expect(h.emitted[0]).toMatchObject({ type: 'GraphChildUpsert', edge: { child_id: 'records:c', parent_id: 'records:p', order: 2 } });
  });
});

describe('dispatchChangeRow — id-refetch fallback when payload absent', () => {
  it('CREATE without payload re-fetches by record_id', async () => {
    const h = harness({
      selectByIds: vi.fn(async (ids: string[]) => (ids[0] === 'records:r9' ? [{ id: 'records:r9', text: 'fetched' }] : []))
    });
    await h.dispatchChangeRow({ table_name: 'records', action: 'CREATE', record_id: 'records:r9' });
    expect(h.selectByIds).toHaveBeenCalledWith(['records:r9']);
    expect(h.emitted[0]).toMatchObject({ type: 'RecordUpsert', core: { id: 'records:r9', text: 'fetched' } });
  });

  it('gracefully emits nothing when the refetched row is missing', async () => {
    const h = harness();
    await h.dispatchChangeRow({ table_name: 'records', action: 'UPDATE', record_id: 'records:gone' });
    expect(h.emitted).toEqual([]);
  });
});

describe('dispatchChangeRow — deletes', () => {
  it('DELETE uses record_id', async () => {
    const h = harness();
    await h.dispatchChangeRow({ table_name: 'records', action: 'DELETE', record_id: 'records:d1' });
    expect(h.emitted).toEqual([{ type: 'RecordDelete', id: 'records:d1' }]);
  });
  it('DELETE falls back to payload.before.id', async () => {
    const h = harness();
    await h.dispatchChangeRow({ table_name: 'graph_child_of', action: 'DELETE', payload: { before: { id: 'graph_child_of:e2' } } });
    expect(h.emitted).toEqual([{ type: 'GraphChildDelete', edgeId: 'graph_child_of:e2' }]);
  });
});

describe('dispatchChangeRow — BATCH_CLONE fan-out', () => {
  it('embedded payload applies with NO refetch and consolidates', async () => {
    const h = harness();
    await h.dispatchChangeRow({
      table_name: 'batch_clone',
      action: 'BATCH_CLONE',
      cursor_id: 'c-batch',
      batch_record_ids: ['records:a', 'records:b'],
      payload: {
        after: {
          records: [{ id: 'records:a', text: 'A' }, { id: 'records:b', text: 'B' }],
          edges: [{ id: 'graph_child_of:e', in: 'records:b', out: 'records:a' }],
          groups: [{ id: 'groups:g', in: 'records:grp', out: 'records:a' }]
        }
      }
    });
    expect(h.selectByIds).not.toHaveBeenCalled();
    expect(h.emitted[0]).toMatchObject({ type: 'RecordBatchUpsert' });
    expect((h.emitted[0] as any).cores).toHaveLength(2);
    expect(h.emitted.some((m) => m.type === 'GraphChildBatchUpsert')).toBe(true);
    expect(h.emitted.some((m) => m.type === 'GraphChildUpsert')).toBe(true); // group
    expect(h.cursors).toEqual(['c-batch']);
  });

  it('no embedded payload → refetch by batch_*_ids', async () => {
    const h = harness({
      selectByIds: vi.fn(async () => [
        { id: 'records:a', text: 'A' },
        { id: 'graph_child_of:e', in: 'records:a', out: 'records:root' }
      ])
    });
    await h.dispatchChangeRow({
      table_name: 'batch_clone',
      action: 'BATCH_CLONE',
      batch_record_ids: ['records:a'],
      batch_edge_ids: ['graph_child_of:e'],
      payload: { after: null }
    });
    expect(h.selectByIds).toHaveBeenCalledWith(['records:a', 'graph_child_of:e']);
    expect(h.emitted.some((m) => m.type === 'RecordBatchUpsert')).toBe(true);
    expect(h.emitted.some((m) => m.type === 'GraphChildBatchUpsert')).toBe(true);
  });
});

describe('dispatchChangeRow — misc', () => {
  it('BATCH_DELETE splits records vs edges', async () => {
    const h = harness();
    await h.dispatchChangeRow({
      table_name: 'records',
      action: 'BATCH_DELETE',
      batch_ids: ['records:r1', 'graph_child_of:e1', 'groups:g1']
    });
    expect(h.emitted).toContainEqual({ type: 'RecordBatchDelete', ids: ['records:r1'] });
    expect(h.emitted).toContainEqual({ type: 'GraphChildBatchDelete', edgeIds: ['graph_child_of:e1', 'groups:g1'] });
  });
  it('unknown action is a no-op but still advances the cursor', async () => {
    const h = harness();
    await h.dispatchChangeRow({ action: 'WAT', cursor_id: 'c-x' });
    expect(h.emitted).toEqual([]);
    expect(h.cursors).toEqual(['c-x']);
  });
  it('no cursor_id → onCursorAdvance not called', async () => {
    const h = harness();
    await h.dispatchChangeRow({ table_name: 'records', action: 'CREATE', payload: { after: { id: 'records:r' } } });
    expect(h.cursors).toEqual([]);
  });
});

describe('runCatchup — paged cursor replay', () => {
  it('pages until drained, dispatches every row, returns the final cursor', async () => {
    const pages = [
      { changes: Array.from({ length: 500 }, (_, i) => ({ table_name: 'records', action: 'CREATE', cursor_id: `c${i}`, payload: { after: { id: `records:p1_${i}` } } })), new_cursor: 'cA' },
      { changes: [{ table_name: 'records', action: 'CREATE', cursor_id: 'cZ', payload: { after: { id: 'records:last' } } }], new_cursor: 'cZ' }
    ];
    let call = 0;
    const h = harness({ syncPull: vi.fn(async () => pages[call++]) });
    const final = await h.runCatchup(undefined);
    expect(h.syncPull).toHaveBeenCalledTimes(2);
    expect(final).toBe('cZ');
    expect(h.emitted).toHaveLength(501);
  });

  it('stops immediately when isStopped() is true', async () => {
    const h = harness({ isStopped: () => true, syncPull: vi.fn(async () => ({ changes: [{}], new_cursor: 'x' })) });
    const final = await h.runCatchup('start');
    expect(h.syncPull).not.toHaveBeenCalled();
    expect(final).toBe('start');
  });

  it('stops when the cursor does not advance (no progress guard)', async () => {
    const h = harness({ syncPull: vi.fn(async () => ({ changes: [{ table_name: 'records', action: 'CREATE', payload: { after: { id: 'records:x' } } }], new_cursor: 'same' })) });
    const final = await h.runCatchup('same');
    expect(h.syncPull).toHaveBeenCalledTimes(1);
    expect(final).toBe('same');
  });

  it('empty first page returns the original cursor unchanged', async () => {
    const h = harness({ syncPull: vi.fn(async () => ({ changes: [], new_cursor: 'whatever' })) });
    expect(await h.runCatchup('orig')).toBe('orig');
  });
});

describe('runCatchup — gap detection (M9)', () => {
  it('throws when the persisted cursor predates the retention floor', async () => {
    const h = harness({
      syncPull: vi.fn(async () => ({
        changes: [{ table_name: 'records', action: 'CREATE', payload: { after: { id: 'records:x' } } }],
        new_cursor: 'c2',
        oldest_cursor: 'c5' // since ('c1') < oldest_cursor ('c5') — a gap
      }))
    });
    await expect(h.runCatchup('c1')).rejects.toThrow(/changefeed gap/);
    // Nothing from the (possibly incomplete) page should have been applied —
    // the caller is expected to fall back to a full resync instead.
    expect(h.emitted).toEqual([]);
  });

  it('does NOT throw when the cursor is at or after the retention floor', async () => {
    const h = harness({
      syncPull: vi.fn(async () => ({
        changes: [],
        new_cursor: 'c5',
        oldest_cursor: 'c5' // since === oldest_cursor: still within retention
      }))
    });
    await expect(h.runCatchup('c5')).resolves.toBe('c5');
  });

  it('cold start (since=undefined) never triggers the gap check', async () => {
    // A cold start has no persisted cursor to compare — createChangefeedCatchup
    // routes that case through a full resync directly and never calls
    // runCatchup at all, but this guards runCatchup itself against a false
    // positive if ever called with since=undefined.
    const h = harness({
      syncPull: vi.fn(async () => ({ changes: [], new_cursor: undefined, oldest_cursor: 'c5' }))
    });
    await expect(h.runCatchup(undefined)).resolves.toBeUndefined();
  });

  it('only checks the gap on the FIRST page, not subsequent ones', async () => {
    // Page 1 is a FULL page (500 rows) so the paging loop continues to page 2
    // instead of treating it as the last (partial) page — matching the
    // "pages until drained" test above.
    const pages = [
      {
        changes: Array.from({ length: 500 }, (_, i) => ({ table_name: 'records', action: 'CREATE', cursor_id: `c${i}`, payload: { after: { id: `records:a_${i}` } } })),
        new_cursor: 'c2',
        oldest_cursor: 'c1'
      },
      // A later page reporting a "newer" oldest_cursor (e.g. a concurrent
      // purge) must not retroactively fail an already-in-progress replay.
      { changes: [{ table_name: 'records', action: 'CREATE', payload: { after: { id: 'records:b' } } }], new_cursor: 'c3', oldest_cursor: 'c99' }
    ];
    let call = 0;
    const h = harness({ syncPull: vi.fn(async () => pages[call++]) });
    // First page's oldest_cursor ('c1') <= since ('c1'), no gap.
    await expect(h.runCatchup('c1')).resolves.toBe('c3');
    expect(h.emitted).toHaveLength(501);
  });
});
