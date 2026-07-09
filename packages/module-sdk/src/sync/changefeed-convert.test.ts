import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeLiveThing,
  parseSelectResult,
  recordCoreFromRow,
  childEdgeFromRow,
  rowToUpsertMsg,
  deleteMsgForId,
  batchRowsToMsgs
} from './changefeed-convert.ts';

describe('normalizeLiveThing', () => {
  it('passes through a tb:id string', () => {
    expect(normalizeLiveThing('records:abc')).toBe('records:abc');
  });
  it('joins a {tb,id} object form', () => {
    expect(normalizeLiveThing({ tb: 'records', id: 'abc' })).toBe('records:abc');
  });
  it('returns undefined for empty/absent', () => {
    expect(normalizeLiveThing('')).toBeUndefined();
    expect(normalizeLiveThing(undefined)).toBeUndefined();
    expect(normalizeLiveThing(null)).toBeUndefined();
  });
});

describe('parseSelectResult', () => {
  it('extracts per-statement result arrays', () => {
    expect(parseSelectResult([{ status: 'OK', result: [1, 2] }, { result: [3] }])).toEqual([[1, 2], [3]]);
  });
  it('handles bare arrays and non-arrays', () => {
    expect(parseSelectResult([[9]])).toEqual([[9]]);
    expect(parseSelectResult(null)).toEqual([]);
  });
});

describe('recordCoreFromRow', () => {
  it('maps an accepted, non-temp record core and carries lineage', () => {
    const core = recordCoreFromRow({
      id: 'records:r1',
      text: 'hi',
      copied_from_record: 'records:tmpl',
      original_template_id: 'records:root',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-02T00:00:00Z'
    });
    expect(core).toMatchObject({
      id: 'records:r1',
      text: 'hi',
      copied_from_record: 'records:tmpl',
      original_template_id: 'records:root',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted'
    });
  });
  it('rejects non-records ids', () => {
    expect(recordCoreFromRow({ id: 'graph_child_of:x' })).toBeNull();
  });
  it('carries computed_additionals (mergeItem strips absent keys — same hazard as lineage)', () => {
    const value = [{ id: 'c1', type: 'pg', prog_type: { ch: 't' }, computed: true }];
    const core = recordCoreFromRow({ id: 'records:r1', text: 'hi', computed_additionals: value });
    expect(core?.computed_additionals).toEqual(value);
    // Non-array garbage is dropped rather than poisoning the cache shape.
    const junk = recordCoreFromRow({ id: 'records:r2', text: 'x', computed_additionals: 'nope' });
    expect(junk?.computed_additionals).toBeUndefined();
  });
  it('omits absent timestamps so mergeItem preserves cached values', () => {
    const core = recordCoreFromRow({ id: 'records:r1', text: 't' });
    expect(core?.created).toBeUndefined();
    expect(core?.updated).toBeUndefined();
  });
});

describe('childEdgeFromRow', () => {
  it('maps in=child / out=parent with defaults', () => {
    expect(childEdgeFromRow({ id: 'graph_child_of:e1', in: 'records:c', out: 'records:p', order: 3 })).toEqual({
      edge_id: 'graph_child_of:e1',
      child_id: 'records:c',
      parent_id: 'records:p',
      order: 3,
      is_key_parent: true,
      module_data: undefined,
      clone_setting: null
    });
  });
  it('returns null when endpoints missing', () => {
    expect(childEdgeFromRow({ id: 'graph_child_of:e1', in: 'records:c' })).toBeNull();
  });
});

describe('rowToUpsertMsg', () => {
  it('records -> RecordUpsert', () => {
    expect(rowToUpsertMsg({ id: 'records:r', text: 'x' })?.type).toBe('RecordUpsert');
  });
  it('graph_child_of -> GraphChildUpsert (in=child,out=parent)', () => {
    const m = rowToUpsertMsg({ id: 'graph_child_of:e', in: 'records:c', out: 'records:p' });
    expect(m).toMatchObject({ type: 'GraphChildUpsert', edge: { child_id: 'records:c', parent_id: 'records:p' } });
  });
  it('groups -> GraphChildUpsert with in=group(parent)/out=member(child)', () => {
    const m = rowToUpsertMsg({ id: 'groups:g', in: 'records:grp', out: 'records:mem' });
    expect(m).toMatchObject({
      type: 'GraphChildUpsert',
      edge: { edge_id: 'groups:g', parent_id: 'records:grp', child_id: 'records:mem', is_key_parent: false }
    });
  });
  it('appliesto -> AppliesUpsert', () => {
    expect(rowToUpsertMsg({ id: 'appliesto:a', in: 'records:s', out: 'records:d' })).toMatchObject({
      type: 'AppliesUpsert', edgeId: 'appliesto:a', srcId: 'records:s', dstId: 'records:d'
    });
  });
  it('unknown table -> null', () => {
    expect(rowToUpsertMsg({ id: 'whatever:1' })).toBeNull();
  });
});

describe('deleteMsgForId', () => {
  it('dispatches delete by id prefix', () => {
    expect(deleteMsgForId('records:r')).toEqual({ type: 'RecordDelete', id: 'records:r' });
    expect(deleteMsgForId('graph_child_of:e')).toEqual({ type: 'GraphChildDelete', edgeId: 'graph_child_of:e' });
    expect(deleteMsgForId('groups:g')).toEqual({ type: 'GraphChildDelete', edgeId: 'groups:g' });
    expect(deleteMsgForId('appliesto:a')).toEqual({ type: 'AppliesDelete', edgeId: 'appliesto:a' });
    expect(deleteMsgForId(undefined)).toBeNull();
  });
});

describe('batchRowsToMsgs (BATCH_CLONE fan-out)', () => {
  it('coalesces records + edges and emits one batch each, groups individually', () => {
    const msgs = batchRowsToMsgs([
      { id: 'records:r1', text: 'a' },
      { id: 'records:r2', text: 'b' },
      { id: 'graph_child_of:e1', in: 'records:r2', out: 'records:r1' },
      { id: 'groups:g1', in: 'records:grp', out: 'records:r1' },
      'not-an-object'
    ]);
    const record = msgs.find((m) => m.type === 'RecordBatchUpsert');
    const edge = msgs.find((m) => m.type === 'GraphChildBatchUpsert');
    const group = msgs.find((m) => m.type === 'GraphChildUpsert');
    expect(record).toBeDefined();
    expect((record as any).cores).toHaveLength(2);
    expect((edge as any).edges).toHaveLength(1);
    expect((group as any).edge.edge_id).toBe('groups:g1');
    // The consolidated record batch must be applied first.
    expect(msgs[0].type).toBe('RecordBatchUpsert');
  });
  it('returns nothing for an empty / junk batch', () => {
    expect(batchRowsToMsgs([])).toEqual([]);
    expect(batchRowsToMsgs([null, 42, {}])).toEqual([]);
  });
});

/**
 * REGRESSION GUARD. The whole point of this architecture is that the client
 * subscribes ONLY to the server changefeed. If someone reintroduces a raw
 * base-table LIVE query, the per-row firehose / batch-clone flood comes back.
 * This test fails loudly if that happens.
 */
describe('LIVE SYNC architecture guard', () => {
  const raw = readFileSync(new URL('./surrealdb-live.ts', import.meta.url), 'utf8');
  // Strip block + line comments so the architecture doc/warning prose (which
  // intentionally quotes the forbidden patterns) does not trip the guard —
  // we assert on actual CODE only.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('subscribes to the changefeed `changes` table', () => {
    expect(code).toMatch(/LIVE SELECT[^;]*FROM changes/);
  });

  it('contains NO raw base-table LIVE subscription in code', () => {
    for (const table of ['records', 'graph_child_of', 'groups', 'appliesto']) {
      expect(code).not.toMatch(new RegExp(`LIVE\\s+SELECT\\s+\\*\\s+FROM\\s+${table}\\b`));
    }
  });

  it('does not reintroduce client self-echo op tracking in code', () => {
    expect(code).not.toMatch(/isSelfSyncOp|ownSyncOpIds|markOwnSyncOp/);
  });
});
