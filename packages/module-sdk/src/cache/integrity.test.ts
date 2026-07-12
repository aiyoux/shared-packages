import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppCache } from './store.svelte.ts';

describe('AppCache Invariants Integrity', () => {
  let cache: ReturnType<typeof createAppCache>;

  beforeEach(() => {
    cache = createAppCache();
  });

  afterEach(() => {
    cache.clear();
  });

  it('safely scrubs orphaned nodes and purges references universally', () => {
    // 1. Arrange - Setup Graph Matrix
    cache.normalizeItem({ id: 'item-del', text: 'Stale Root', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'child-1', text: 'Child node', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'linked-1', text: 'Linked node', is_temp: false, dirty: false, sync_status: 'accepted' });

    // Target Node behaves as Parent
    cache.upsert_graph_child_of_edge('edge-123', 'child-1', 'item-del', 0, false);
    cache.upsert_applies_edge('applies-123', 'item-del', 'linked-1');
    
    // Target Node behaves as Scope Member
    cache.record_scope_bucket_items('global', '2023-10-01', ['item-del', 'other-item']);

    expect(cache.itemCount).toBe(3);
    expect(cache.childrenEdgeCount).toBe(1);
    expect(cache.appliesEdgeCount).toBe(1);
    const scopeSliceBefore = cache.get_items_for_scope_bucket('global', '2023-10-01');
    expect(scopeSliceBefore.length).toBe(1); // 'other-item' doesn't exist natively inside raw cache items yet but string mapping exists.
    
    // 2. Act - Remove Root Node 
    cache.removeItem('item-del');

    // 3. Assert GC Validation
    expect(cache.itemCount).toBe(2);
    expect(cache.childrenEdges.size).toBe(0); // The dangling edge drops defensively!
    expect(cache.appliesEdges.size).toBe(0);
    
    const sliceIterAfter = cache.scopeBucketSlices;
    expect(sliceIterAfter.get('global:2023-10-01')?.item_ids.has('item-del')).toBe(false);
  });

  it('isItemInScope reports membership via bucket slices, ignoring item fields', () => {
    cache.normalizeItem({ id: 'records:item-a', text: 'Item A', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:item-b', text: 'Item B', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.record_scope_bucket_items('records:scope-x', '2026-04-10', ['records:item-a']);

    // Member: item-a lives in scope-x's bucket slice.
    expect(cache.isItemInScope('records:item-a', 'records:scope-x')).toBe(true);

    // Known non-member: slices exist for scope-x but item-b is not among them.
    expect(cache.isItemInScope('records:item-b', 'records:scope-x')).toBe(false);

    // Unknown: no slices have been recorded for scope-y at all.
    expect(cache.isItemInScope('records:item-a', 'records:scope-y')).toBeNull();

    // Prefix-insensitive: caller may pass unprefixed ids.
    expect(cache.isItemInScope('records:item-a', 'scope-x')).toBe(true);
  });

  it('isItemInScope treats cached scoped parents as scope for descendants', () => {
    cache.normalizeItem({ id: 'records:scope-x', text: 'Scope', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:parent', text: 'Parent', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:child', text: 'Child', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:grandchild', text: 'Grandchild', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:outside', text: 'Outside', is_temp: false, dirty: false, sync_status: 'accepted' });

    cache.upsert_graph_child_of_edge('groups:scope-parent', 'records:parent', 'records:scope-x', 0, false);
    cache.upsert_graph_child_of_edge('graph:parent-child', 'records:child', 'records:parent', 0, true);
    cache.upsert_graph_child_of_edge('graph:child-grandchild', 'records:grandchild', 'records:child', 0, false);
    cache.record_scope_bucket_items('records:scope-x', '2026-04-10', []);

    expect(cache.isItemInScope('records:parent', 'records:scope-x')).toBe(true);
    expect(cache.isItemInScope('records:child', 'records:scope-x')).toBe(true);
    expect(cache.isItemInScope('records:grandchild', 'scope-x')).toBe(true);
    expect(cache.isItemInScope('records:outside', 'records:scope-x')).toBe(false);
  });

  it('executes TempIdRemap effectively across maps', () => {
    cache.normalizeItem({ id: 'temp_x99', text: 'Optimistic Node', is_temp: true, dirty: true, sync_status: 'pending' });
    cache.record_scope_bucket_items('global', 'bucket_A', ['temp_x99']);
    cache.upsert_graph_child_of_edge('edge-new', 'temp_x99', 'root', 1, false);
    cache.upsert_applies_edge('applies-new', 'temp_x99', 'records:downstream');

    cache.remap_id('temp_x99', 'records:ABC');

    expect(cache.getItem('temp_x99')).toBeUndefined();
    expect(cache.getItem('records:ABC')?.text).toBe('Optimistic Node');

    const edge = cache.get_children_for_parent('root')[0];
    expect(edge.child_id).toBe('records:ABC');

    const appliesEdge = cache.get_applies_for_source('records:ABC')[0];
    expect(appliesEdge.dst_id).toBe('records:downstream');

    expect(cache.scopeBucketSlices.get('global:bucket_A')?.item_ids.has('records:ABC')).toBe(true);
    expect(cache.scopeBucketSlices.get('global:bucket_A')?.item_ids.has('temp_x99')).toBe(false);

    expect(cache.itemMeta.get('records:ABC')?.sync_status).toBe('accepted');
  });

  it('resolves applies edges bidirectionally and keeps both indexes in sync', () => {
    cache.normalizeItem({ id: 'records:src', text: 'Source', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'records:dst', text: 'Destination', is_temp: false, dirty: false, sync_status: 'accepted' });

    cache.upsert_applies_edge('applies:src-dst', 'records:src', 'records:dst');

    // Outgoing (src → dst) and incoming (dst ← src) both resolve to the same edge.
    expect(cache.get_applies_for_source('records:src')).toHaveLength(1);
    expect(cache.get_applies_for_source('records:src')[0].dst_id).toBe('records:dst');
    expect(cache.get_applies_for_dest('records:dst')).toHaveLength(1);
    expect(cache.get_applies_for_dest('records:dst')[0].src_id).toBe('records:src');

    // Reverse directions are empty — the edge is directed, just indexed both ways.
    expect(cache.get_applies_for_source('records:dst')).toHaveLength(0);
    expect(cache.get_applies_for_dest('records:src')).toHaveLength(0);

    // Remap the destination: the dest index must follow to the new id.
    cache.remap_id('records:dst', 'records:dst2');
    expect(cache.get_applies_for_dest('records:dst')).toHaveLength(0);
    expect(cache.get_applies_for_dest('records:dst2')).toHaveLength(1);
    expect(cache.get_applies_for_source('records:src')[0].dst_id).toBe('records:dst2');

    // Removing the edge cleans both indexes.
    cache.remove_applies_edge('applies:src-dst');
    expect(cache.get_applies_for_source('records:src')).toHaveLength(0);
    expect(cache.get_applies_for_dest('records:dst2')).toHaveLength(0);
  });

  it('collapses optimistic temp child edges when the durable graph edge arrives', () => {
    cache.normalizeItem({ id: 'records:parent', text: 'Parent', is_temp: false, dirty: false, sync_status: 'accepted' });
    cache.normalizeItem({ id: 'temp:child', text: 'Child', is_temp: true, dirty: true, sync_status: 'pending' });
    cache.upsert_graph_child_of_edge('temp-edge:child-parent', 'temp:child', 'records:parent', 0, true);

    cache.remap_id('temp:child', 'records:child');
    cache.upsert_graph_child_of_edge('graph_child_of:child-parent', 'records:child', 'records:parent', 0, true);

    const children = cache.get_children_for_parent('records:parent');
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      edge_id: 'graph_child_of:child-parent',
      child_id: 'records:child',
      parent_id: 'records:parent'
    });
    expect(cache.childrenEdges.get('temp-edge:child-parent')).toBeUndefined();
  });

});
