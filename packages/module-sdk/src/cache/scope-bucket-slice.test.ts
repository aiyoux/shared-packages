import { describe, it, expect } from 'vitest';
import { createAppCache } from './store.svelte.ts';
import { scope_bucket_key } from './types.ts';

/**
 * Regression guards for the calendar "new event vanishes after grace until
 * refresh" bug (handoff Bug 6). The materialized date index
 * (`scopeBucketSlices`) is keyed by `scope_bucket_key(scope, bucket)` =
 * `${scope}:${bucket}`. When the *scope is a record id* it contains a colon
 * (`records:abc`), so any code that reverse-parses the key with `split(':')`
 * mis-attributes the scope/bucket fields, and the slice becomes invisible to
 * the field-based filters in `buildMappedEvents` / `isItemInScope`.
 *
 * The store always stores the FIELDS verbatim from its args (no key
 * round-trip), so these tests lock that in and document the only correct way to
 * parse a key back: split on the LAST colon.
 */
describe('scope-bucket-slice field integrity (Bug 6)', () => {
  it('scope_bucket_key round-trips via lastIndexOf even when scope is a record id', () => {
    const scope = 'records:jomwa1234567890';
    const bucket = '2026-07-05';
    const key = scope_bucket_key(scope, bucket);

    // The correct parse: bucket (YYYY-MM-DD) has no colon, the record-id scope
    // does — so split on the LAST colon.
    const lastColon = key.lastIndexOf(':');
    expect(key.slice(0, lastColon)).toBe(scope);
    expect(key.slice(lastColon + 1)).toBe(bucket);

    // The Bug 6 mis-parse: splitting on the FIRST colon shears the record id.
    const [wrongScope, ...wrongBucketParts] = key.split(':');
    expect(wrongScope).not.toBe(scope);
    expect(wrongBucketParts.join(':')).not.toBe(bucket);
  });

  it('record_scope_bucket_items stores the exact scope/bucket FIELDS (record-id scope)', () => {
    const cache = createAppCache();
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['records:item-1']);

    const slice = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    expect(slice).toBeDefined();
    // The FIELDS — not just the key — must be the full scope and the bare date.
    expect(slice?.scope).toBe('records:abc');
    expect(slice?.bucket).toBe('2026-07-05');
    expect(slice?.item_ids.has('records:item-1')).toBe(true);
    cache.clear();
  });

  it('record_scope_bucket_items_batch stores the exact scope/bucket FIELDS', () => {
    const cache = createAppCache();
    cache.record_scope_bucket_items_batch([
      { scope: 'records:abc', bucket: '2026-07-05', itemIds: ['records:item-1'] },
      { scope: 'records:def', bucket: '2026-07-06', itemIds: ['records:item-2'] }
    ]);

    const s1 = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    const s2 = cache.scopeBucketSlices.get('records:def:2026-07-06');
    expect(s1?.scope).toBe('records:abc');
    expect(s1?.bucket).toBe('2026-07-05');
    expect(s2?.scope).toBe('records:def');
    expect(s2?.bucket).toBe('2026-07-06');
    cache.clear();
  });

  it('isItemInScope filters by the slice scope FIELD, not the key', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:item-1', text: 'A', is_temp: false, dirty: false, sync_status: 'accepted' });

    // Correct placement: field === full record-id scope.
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['records:item-1']);
    expect(cache.isItemInScope('records:item-1', 'records:abc')).toBe(true);

    // A slice stored with a mis-parsed scope FIELD ('records') is invisible to
    // a query for the real scope, even though its key collides on the prefix.
    cache.record_scope_bucket_items('records', 'abc:2026-07-06', ['records:item-1']);
    expect(cache.isItemInScope('records:item-1', 'records:def')).toBeNull();
    cache.clear();
  });

  it('removeItem keeps the slice and removes only the target id (Bug 4/6)', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'a', text: 'A', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'b', text: 'B', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'c', text: 'C', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['a', 'b', 'c']);

    cache.removeItem('b');

    const slice = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    // Slice is NOT deleted — only the removed id is purged; the others survive.
    expect(slice).toBeDefined();
    expect(slice?.item_ids.has('b')).toBe(false);
    expect(slice?.item_ids.has('a')).toBe(true);
    expect(slice?.item_ids.has('c')).toBe(true);
    cache.clear();
  });

  it('batch_upsert leaves slices untouched — placement is the reconciler\'s job', () => {
    // Load-bearing invariant: batch_upsert (used on CreateTreeBatch accept) must
    // NOT auto-place items into bucket slices. The calendar reconciler owns
    // placement via sync_item_to_buckets; if batch_upsert silently mutated
    // slices the two would fight and items would double- or mis-place.
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:existing', text: 'E', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['records:existing']);

    const before = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    const beforeIds = before ? [...before.item_ids] : [];

    // Upsert a brand-new core AND re-upsert one already in the slice.
    cache.batch_upsert([
      { id: 'records:fresh', text: 'F', is_temp: false, dirty: false, sync_status: 'accepted', additionals: [] },
      { id: 'records:existing', text: 'E2', is_temp: false, dirty: false, sync_status: 'accepted', additionals: [] }
    ] as any);

    const after = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    // Same slice, same membership — the fresh item is NOT auto-placed, the
    // existing one is neither duplicated nor dropped.
    expect(after).toBeDefined();
    expect([...(after?.item_ids ?? [])].sort()).toEqual([...beforeIds].sort());
    expect(after?.item_ids.has('records:fresh')).toBe(false);
    // No NEW slice was created for the fresh item anywhere.
    expect(cache.scopeBucketSlices.size).toBe(1);
    expect([...cache.scopeBucketSlices.values()][0]?.bucket).toBe('2026-07-05');
    cache.clear();
  });

  it('remap_id migrates the slice entry temp->real, never leaving both', () => {
    // Store-level underpinning of the C4 no-duplicate guarantee: once the swap
    // runs, the slice holds the real id and not the temp.
    const cache = createAppCache();
    cache.normalizeItem({ id: 'temp:new1', text: 'Optimistic', is_temp: true, dirty: true, sync_status: 'pending' });
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['temp:new1', 'records:other']);

    cache.remap_id('temp:new1', 'records:real1');

    const slice = cache.scopeBucketSlices.get('records:abc:2026-07-05');
    expect(slice?.item_ids.has('temp:new1')).toBe(false);
    expect(slice?.item_ids.has('records:real1')).toBe(true);
    expect(slice?.item_ids.has('records:other')).toBe(true);
    // Exactly one of {temp, real} is present — no duplicate row.
    expect(slice?.item_ids.size).toBe(2);
    cache.clear();
  });

  // C4 (handoff §5) — the *reconciler-level* race: the live server echo places
  // the real id into the slice BEFORE the local accept runs removeItem(temp) +
  // remap_id, so temp and real co-exist for a brief window and the calendar
  // renders TWO rows before collapsing. The store test above proves the swap
  // leaves one entry; the end-to-end "exactly one row at every instant, no
  // flash" guarantee needs a CalendarPage reconciler/buildMappedEvents harness
  // that interleaves the live echo and the accept (see
  // repos/module-calendar/test/calendar-reconciler.todo.test.ts).
  it.todo('C4: no temp+real double-render during the create echo/accept overlap');
});

/**
 * isItemInScope parent-walk fallback (uncaptured gap). When no scope-bucket
 * slice exists for the queried scope (edges cold / scope not yet hydrated), the
 * store falls back to walking cached graph_child_of ancestry via
 * parentsByChild/childrenEdges (store.svelte.ts:378-404). This mirrors the
 * server date-range scope helper: a scoped ancestor is enough for a dated
 * descendant to count as in-scope. These tests exercise that fallback directly
 * (multi-hop reach, cycle-break, and the false/null outcomes).
 */
describe('isItemInScope parent-walk fallback', () => {
  it('returns true when the item reaches the scope through cached graph_child_of ancestry (multi-hop)', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:child', text: 'C', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:mid', text: 'M', is_temp: false, dirty: false, sync_status: 'accepted' });

    // child -> mid -> scope. No slice is recorded for the queried scope, so the
    // only path to "true" is the parent walk.
    cache.upsert_graph_child_of_edge('graph_child_of:e1', 'records:child', 'records:mid', 0, true);
    cache.upsert_graph_child_of_edge('graph_child_of:e2', 'records:mid', 'records:scope', 0, true);

    expect(cache.isItemInScope('records:child', 'records:scope')).toBe(true);
    cache.clear();
  });

  it('terminates on an ancestry cycle (A->B->A) without looping forever', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:A', text: 'A', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:B', text: 'B', is_temp: false, dirty: false, sync_status: 'accepted' });

    // A's parent is B, B's parent is A — a cycle. The visited set must break it.
    cache.upsert_graph_child_of_edge('graph_child_of:ab', 'records:A', 'records:B', 0, true);
    cache.upsert_graph_child_of_edge('graph_child_of:ba', 'records:B', 'records:A', 0, true);

    // Neither node is under records:scope; with no slice for that scope the
    // result is null (not a hang).
    expect(cache.isItemInScope('records:A', 'records:scope')).toBeNull();
    cache.clear();
  });

  it('returns null when the item has no ancestry and no slice exists for the scope', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:lonely', text: 'L', is_temp: false, dirty: false, sync_status: 'accepted' });

    // No edges, no slice for the queried scope => unknown (null), not false.
    expect(cache.isItemInScope('records:lonely', 'records:scope')).toBeNull();
    cache.clear();
  });

  it('returns false (definitively out) when a slice exists for the scope but the item is neither in it nor under the scope', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:lonely', text: 'L', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:other', text: 'O', is_temp: false, dirty: false, sync_status: 'accepted' });

    // A slice for the scope exists (so membership is resolvable), but the item
    // is not in it and has no ancestry reaching the scope => false.
    cache.record_scope_bucket_items('records:scope', '2026-07-05', ['records:other']);
    expect(cache.isItemInScope('records:lonely', 'records:scope')).toBe(false);
    cache.clear();
  });

  it('treats the item itself as in-scope by identity (no edges/slices needed)', () => {
    const cache = createAppCache();
    cache.normalizeItem({ id: 'records:scope', text: 'S', is_temp: false, dirty: false, sync_status: 'accepted' });
    expect(cache.isItemInScope('records:scope', 'records:scope')).toBe(true);
    cache.clear();
  });
});

/**
 * getRecordKey (store.svelte.ts) reverse-parses a `scope_bucket_key` to recover
 * the {scope, bucket} for an item. The function had zero callers so the
 * first-colon split bug was latent; M8 wires the first caller, so this locks
 * the last-colon parse against regression. The same `records:<id>:YYYY-MM-DD`
 * key that broke the naive split must round-trip to the full record-id scope
 * and the bare date bucket.
 */
describe('getRecordKey last-colon parse (M2/M8)', () => {
  it('recovers the full record-id scope and bare-date bucket for a record-scoped slice', () => {
    const cache = createAppCache();
    cache.normalizeItem({
      id: 'records:item-1',
      text: 'A',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted'
    });
    cache.record_scope_bucket_items('records:abc', '2026-07-05', ['records:item-1']);

    const key = cache.getRecordKey('records:item-1');
    expect(key).toEqual({
      scope: 'records:abc',
      bucket: '2026-07-05',
      id: 'records:item-1'
    });

    // Explicitly the bug shape: the naive `key.split(':')` returned
    // { scope: 'records', bucket: 'abc' } — neither field is correct.
    expect(key?.scope).not.toBe('records');
    expect(key?.bucket).not.toBe('abc');
    cache.clear();
  });

  it('returns null for an item with no slice and for an unknown item', () => {
    const cache = createAppCache();
    cache.normalizeItem({
      id: 'records:lonely',
      text: 'L',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted'
    });
    expect(cache.getRecordKey('records:lonely')).toBeNull();
    expect(cache.getRecordKey('records:missing')).toBeNull();
    cache.clear();
  });

  it('handles a scope id whose own id part also contains no colon (plain scope)', () => {
    const cache = createAppCache();
    cache.normalizeItem({
      id: 'records:item-2',
      text: 'B',
      is_temp: false,
      dirty: false,
      sync_status: 'accepted'
    });
    // scope without a `records:` prefix — still a single trailing `:bucket`.
    cache.record_scope_bucket_items('plan', '2026-07-06', ['records:item-2']);
    expect(cache.getRecordKey('records:item-2')).toEqual({
      scope: 'plan',
      bucket: '2026-07-06',
      id: 'records:item-2'
    });
    cache.clear();
  });
});
