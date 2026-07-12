import { SvelteMap } from 'svelte/reactivity';
import type {
  CacheItem,
  ChildEdge,
  AppliesEdge,
  ScopeBucketSlice,
  ScopeBucketKey,
  EntityMeta,
  RecordKey,
  CacheMutationEvent,
  SyncStatus,
  AdditionalWithId
} from './types.ts';
import { scope_bucket_key } from './types.ts';

export interface AppCacheState {
  items: Map<string, CacheItem>;
  childrenEdges: Map<string, ChildEdge>;
  appliesEdges: Map<string, AppliesEdge>;
  scopeBucketSlices: Map<string, ScopeBucketSlice>;
  itemMeta: Map<string, EntityMeta>;
  epochs: Map<string, number>;
  scopeBucketWriteEpoch: number;
  generation: number;
}

export function createAppCache() {
  let items = new Map<string, CacheItem>();
  let childrenEdges = new Map<string, ChildEdge>();
  let appliesEdges = new Map<string, AppliesEdge>();
  // Materialized date/scope membership index used by calendar-style views.
  // It is populated by explicit range hydrators (`record_scope_bucket_items`
  // and `hydrate_scope_day`), not inferred automatically from `ItemUpsert`.
  // Consumers that render exclusively from this index must refresh/rebuild it
  // after relevant live cache mutations; otherwise a server-confirmed item can
  // be present in `items` while absent from the visible bucket slice.
  let scopeBucketSlices = new Map<string, ScopeBucketSlice>();
  let itemMeta = new Map<string, EntityMeta>();

  // ⚡ Bolt Optimization: Replace $state(new Map()) with SvelteMap
  // Using SvelteMap provides O(1) granular reactivity for specific keys
  // without triggering deep dependency recalculations on the entire map
  // whenever any single epoch value changes.
  let epochs = new SvelteMap<string, number>();

  let scopeBucketWriteEpoch = $state(0);
  let generation = $state(0);

  // Performance Indexes (non-reactive lookups, reactivity driven by epochs)
  let childrenByParent = new Map<string, Set<string>>();
  let parentsByChild = new Map<string, Set<string>>();
  let appliesBySource = new Map<string, Set<string>>();
  // Reverse index of applies edges by destination. Maintained alongside
  // appliesBySource so applies-to links can be resolved bidirectionally:
  // get_applies_for_source walks outgoing (src→dst) edges, get_applies_for_dest
  // walks incoming (dst←src) edges. Both directions are rendered in the tree.
  let appliesByDest = new Map<string, Set<string>>();

  // Children batch mode: defers epoch bumps during bulk child operations
  // to prevent O(n) reactive re-renders (ported from wisewords)
  let childrenBatchDepth = 0;
  let pendingChildrenEpochBumps = new Set<string>();
  // The two global reactive counters are deferred during a children batch
  // too: without this a bulk operation (clone, batch upsert) bumps them
  // once per edge/item, and every consumer keyed on them (e.g. exec
  // landing's projectedItems) re-runs O(n) times for one logical change.
  let pendingScopeBucketBump = false;
  let pendingGenerationBump = false;

  function bumpEpoch(key: string) {
    if (childrenBatchDepth > 0) {
      pendingChildrenEpochBumps.add(key);
      return;
    }
    const current = epochs.get(key) ?? 0;
    epochs.set(key, current + 1);
  }

  function bump_scope_bucket_write_epoch() {
    if (childrenBatchDepth > 0) {
      pendingScopeBucketBump = true;
      return;
    }
    scopeBucketWriteEpoch++;
  }

  function bump_generation() {
    if (childrenBatchDepth > 0) {
      pendingGenerationBump = true;
      return;
    }
    generation++;
  }

  function begin_children_batch() {
    childrenBatchDepth++;
  }

  function end_children_batch() {
    childrenBatchDepth--;
    if (childrenBatchDepth <= 0) {
      childrenBatchDepth = 0;
      // Flush all deferred epoch bumps as a single batch
      for (const key of pendingChildrenEpochBumps) {
        const current = epochs.get(key) ?? 0;
        epochs.set(key, current + 1);
      }
      pendingChildrenEpochBumps.clear();
      if (pendingScopeBucketBump) {
        pendingScopeBucketBump = false;
        scopeBucketWriteEpoch++;
      }
      if (pendingGenerationBump) {
        pendingGenerationBump = false;
        generation++;
      }
    }
  }

  let listeners = new Set<(event: CacheMutationEvent) => void>();

  function subscribe(onEvent: (event: CacheMutationEvent) => void) {
    listeners.add(onEvent);
    return () => listeners.delete(onEvent);
  }

  function emit(event: CacheMutationEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function add_child_index(parentId: string, edgeId: string) {
    let set = childrenByParent.get(parentId);
    if (!set) {
      set = new Set();
      childrenByParent.set(parentId, set);
    }
    set.add(edgeId);
  }

  function remove_child_index(parentId: string, edgeId: string) {
    const set = childrenByParent.get(parentId);
    if (set) {
      set.delete(edgeId);
      if (set.size === 0) childrenByParent.delete(parentId);
    }
  }

  function add_parent_index(childId: string, edgeId: string) {
    let set = parentsByChild.get(childId);
    if (!set) {
      set = new Set();
      parentsByChild.set(childId, set);
    }
    set.add(edgeId);
  }

  function remove_parent_index(childId: string, edgeId: string) {
    const set = parentsByChild.get(childId);
    if (set) {
      set.delete(edgeId);
      if (set.size === 0) parentsByChild.delete(childId);
    }
  }

  function add_applies_index(srcId: string, dstId: string, edgeId: string) {
    let srcSet = appliesBySource.get(srcId);
    if (!srcSet) {
      srcSet = new Set();
      appliesBySource.set(srcId, srcSet);
    }
    srcSet.add(edgeId);
    let dstSet = appliesByDest.get(dstId);
    if (!dstSet) {
      dstSet = new Set();
      appliesByDest.set(dstId, dstSet);
    }
    dstSet.add(edgeId);
  }

  function remove_applies_index(srcId: string, dstId: string, edgeId: string) {
    const srcSet = appliesBySource.get(srcId);
    if (srcSet) {
      srcSet.delete(edgeId);
      if (srcSet.size === 0) appliesBySource.delete(srcId);
    }
    const dstSet = appliesByDest.get(dstId);
    if (dstSet) {
      dstSet.delete(edgeId);
      if (dstSet.size === 0) appliesByDest.delete(dstId);
    }
  }

  function cloneForCache<T>(value: T): T {
    if (value === undefined || value === null) return value;
    return structuredClone($state.snapshot(value) as T);
  }

  function mergeItem(existing: CacheItem | undefined, incoming: CacheItem): CacheItem {
    const cleanIncoming = cloneForCache(incoming);
    if (!existing) return cleanIncoming;
    const merged = cloneForCache(existing) as unknown as Record<string, unknown>;
    // Delete keys the server no longer returns so optimistic phantom fields
    // (e.g. `scope`) can't leak. Preserve client-only metadata.
    const clientOnly = new Set(['is_temp', 'dirty', 'sync_status']);
    for (const key of Object.keys(merged)) {
      if (!(key in cleanIncoming) && !clientOnly.has(key)) {
        delete merged[key];
      }
    }
    for (const [key, value] of Object.entries(cleanIncoming as unknown as Record<string, unknown>)) {
      if (value !== undefined) merged[key] = value;
    }
    return merged as unknown as CacheItem;
  }

  function normalizeItem(item: CacheItem) {
    if (!item || typeof item.id !== 'string') return;
    const existing = items.get(item.id);
    const isNew = !existing;
    const nextItem = mergeItem(existing, item);
    items.set(item.id, nextItem);
    if (nextItem.is_temp) {
      const existingMeta = itemMeta.get(nextItem.id) ?? {};
      itemMeta.set(nextItem.id, { ...existingMeta, dirty: true, sync_status: 'pending' });
    }
    bumpEpoch(nextItem.id);
    if (isNew) bump_generation();
    emit({ type: 'ItemUpsert', item: nextItem });
  }

  function normalize_tree(rootItem: CacheItem) {
    normalizeItem(rootItem);
    if (rootItem.additionals) {
      bumpEpoch(rootItem.id);
    }
  }

  function upsert_graph_child_of_edge(
    edgeId: string,
    childId: string,
    parentId: string,
    order: number,
    isKeyParent: boolean,
    moduleData?: Record<string, unknown>,
    cloneSetting?: import('./types.ts').CloneSetting | null
  ) {
    const isIncomingTempEdge = edgeId.startsWith('temp-edge:');
    const duplicateEdgeIds: string[] = [];
    for (const [existingEdgeId, existingEdge] of childrenEdges.entries()) {
      if (existingEdgeId === edgeId) continue;
      if (existingEdge.parent_id !== parentId || existingEdge.child_id !== childId) continue;
      if (isIncomingTempEdge && !existingEdgeId.startsWith('temp-edge:')) {
        return;
      }
      duplicateEdgeIds.push(existingEdgeId);
    }
    for (const duplicateEdgeId of duplicateEdgeIds) {
      remove_graph_child(duplicateEdgeId);
    }

    const existing = childrenEdges.get(edgeId);
    if (existing && (existing.parent_id !== parentId || existing.child_id !== childId)) {
      remove_child_index(existing.parent_id, edgeId);
      remove_parent_index(existing.child_id, edgeId);
    }

    const edge: ChildEdge = {
      edge_id: edgeId,
      child_id: childId,
      parent_id: parentId,
      order,
      is_key_parent: isKeyParent,
      module_data: moduleData,
      clone_setting: cloneSetting ?? null
    };
    childrenEdges.set(edgeId, edge);
    add_child_index(parentId, edgeId);
    add_parent_index(childId, edgeId);
    bumpEpoch(parentId);
    bumpEpoch(childId);
    bump_scope_bucket_write_epoch();
    emit({ type: 'EdgeUpsert', edge });
  }

  function remove_graph_child(edgeId: string) {
    const edge = childrenEdges.get(edgeId);
    if (edge) {
      const parentId = edge.parent_id;
      childrenEdges.delete(edgeId);
      remove_child_index(parentId, edgeId);
      remove_parent_index(edge.child_id, edgeId);
      bumpEpoch(parentId);
      bumpEpoch(edge.child_id);
      bump_scope_bucket_write_epoch();
      emit({ type: 'EdgeDelete', edgeId });
    }
  }

  function upsert_applies_edge(
    edgeId: string,
    srcId: string,
    dstId: string,
    moduleData?: Record<string, unknown>
  ) {
    const edge: AppliesEdge = {
      edge_id: edgeId,
      src_id: srcId,
      dst_id: dstId,
      module_data: moduleData
    };
    appliesEdges.set(edgeId, edge);
    add_applies_index(srcId, dstId, edgeId);
    bumpEpoch(srcId);
    bumpEpoch(dstId);
    bump_scope_bucket_write_epoch();
    emit({ type: 'AppliesUpsert', edge });
  }

  function remove_applies_edge(edgeId: string) {
    const edge = appliesEdges.get(edgeId);
    if (edge) {
      appliesEdges.delete(edgeId);
      remove_applies_index(edge.src_id, edge.dst_id, edgeId);
      bumpEpoch(edge.src_id);
      bumpEpoch(edge.dst_id);
      bump_scope_bucket_write_epoch();
      emit({ type: 'AppliesDelete', edgeId });
    }
  }

  function record_scope_bucket_items(scope: string, bucket: string, itemIds: string[]) {
    const key = scope_bucket_key(scope, bucket);
    const newSlice: ScopeBucketSlice = {
      scope,
      bucket,
      item_ids: new Set(itemIds),
      last_write_epoch: scopeBucketWriteEpoch
    };
    scopeBucketSlices.set(key, newSlice);
    bump_scope_bucket_write_epoch();
    emit({ type: 'ScopeDayUpsert', scope, bucket, itemIds });
  }

  function record_scope_bucket_items_batch(entries: Array<{ scope: string; bucket: string; itemIds: string[] }>) {
    if (entries.length === 0) return;
    const events: CacheMutationEvent[] = [];
    for (const { scope, bucket, itemIds } of entries) {
      const key = scope_bucket_key(scope, bucket);
      scopeBucketSlices.set(key, {
        scope,
        bucket,
        item_ids: new Set(itemIds),
        last_write_epoch: scopeBucketWriteEpoch
      });
      events.push({ type: 'ScopeDayUpsert', scope, bucket, itemIds });
    }
    bump_scope_bucket_write_epoch();
    for (const ev of events) emit(ev);
  }

  /**
   * Returns `true` if the item is known to belong to the given scope via any
   * recorded scope bucket slice, `false` if slices exist for that scope but do
   * not contain the item, or `null` when no slices exist for the scope (i.e.
   * membership cannot be determined from the bucket index alone and callers
   * should fall back to a secondary check).
   *
   * This is the authoritative membership oracle shared between the calendar
   * grid (which already reads `scopeBucketSlices` directly) and any secondary
   * consumer (e.g. the day popup) so that both agree regardless of whether
   * `item.grouping` has been backfilled onto the item record.
   */
  function isItemInScope(itemId: string, scopeId: string): boolean | null {
    scopeBucketWriteEpoch; // register Svelte 5 dependency
    if (!itemId || !scopeId) return null;
    const cleanScope = scopeId.replace(/^records:/, '');
    const cleanItem = itemId.replace(/^records:/, '');

    if (itemId === scopeId || cleanItem === cleanScope) {
      return true;
    }

    // Primary: scope-bucket slices populated by date-range hydrators.
    let anySliceForScope = false;
    for (const slice of scopeBucketSlices.values()) {
      const sliceScope = slice.scope.replace(/^records:/, '');
      if (sliceScope !== cleanScope) continue;
      anySliceForScope = true;
      if (slice.item_ids.has(itemId)) return true;
    }

    // Fallback: cached parent/group ancestry also counts as membership. This
    // mirrors the server date-range scope helper, where a scoped parent is
    // enough for dated descendants to be returned.
    const visited = new Set<string>();
    const isUnderCachedScope = (cursorId: string): boolean => {
      const cleanCursor = cursorId.replace(/^records:/, '');
      if (cursorId === scopeId || cleanCursor === cleanScope) return true;
      if (visited.has(cursorId)) return false;
      visited.add(cursorId);

      epochs.get(cursorId); // register Svelte 5 dependency for parent edges
      const parentEdgeIds = parentsByChild.get(cursorId);
      if (!parentEdgeIds) return false;

      for (const edgeId of parentEdgeIds) {
        const edge = childrenEdges.get(edgeId);
        if (!edge) continue;
        if (isUnderCachedScope(edge.parent_id)) return true;
      }
      return false;
    };

    if (isUnderCachedScope(itemId)) {
      return true;
    }

    return anySliceForScope ? false : null;
  }

  function get_items_for_scope_bucket(scope: string, bucket: string): CacheItem[] {
    const key = scope_bucket_key(scope, bucket);
    const slice = scopeBucketSlices.get(key);
    if (!slice) {
      return [];
    }
    const result: CacheItem[] = [];
    for (const id of slice.item_ids) {
      const item = items.get(id);
      if (item) {
        result.push(item);
      }
    }
    return result;
  }

  function get_children_for_parent(parentId: string): ChildEdge[] {
    epochs.get(parentId); // Register Svelte 5 dependency
    const result: ChildEdge[] = [];
    const set = childrenByParent.get(parentId);
    if (set) {
      for (const edgeId of set) {
        const edge = childrenEdges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    return result.sort((a, b) => a.order - b.order);
  }

  function get_parents_for_child(childId: string): ChildEdge[] {
    epochs.get(childId); // Register Svelte 5 dependency
    const result: ChildEdge[] = [];
    const set = parentsByChild.get(childId);
    if (set) {
      for (const edgeId of set) {
        const edge = childrenEdges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    return result.sort((a, b) => a.order - b.order);
  }

  function get_applies_for_source(srcId: string): AppliesEdge[] {
    epochs.get(srcId); // Register Svelte 5 dependency
    const result: AppliesEdge[] = [];
    const set = appliesBySource.get(srcId);
    if (set) {
      for (const edgeId of set) {
        const edge = appliesEdges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    return result;
  }

  /**
   * Reverse-direction applies lookup: returns applies edges where `dstId` is the
   * destination, i.e. records that "apply to" `dstId`. Paired with
   * {@link get_applies_for_source} so applies-to links can be rendered
   * bidirectionally (outgoing "Related" + incoming "Related to this").
   */
  function get_applies_for_dest(dstId: string): AppliesEdge[] {
    epochs.get(dstId); // Register Svelte 5 dependency
    const result: AppliesEdge[] = [];
    const set = appliesByDest.get(dstId);
    if (set) {
      for (const edgeId of set) {
        const edge = appliesEdges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    return result;
  }

  function getRecordKey(itemId: string): RecordKey | null {
    const item = items.get(itemId);
    if (!item) return null;
    for (const [key, slice] of scopeBucketSlices.entries()) {
      if (slice.item_ids.has(itemId)) {
        // Slice key is `${scope}:${bucket}` where `bucket` is a YYYY-MM-DD
        // date (no colons) but `scope` is a record id like `records:<id>` that
        // DOES contain a colon. Split on the LAST ':' only — a naive
        // `key.split(':')` mis-parses `records:<id>:2026-07-04` as
        // scope=`records`, bucket=`<id>` (see the CalendarPage lastIndexOf
        // note). Nothing currently calls this, so the bug was latent; M8 wires
        // the first caller, this keeps it correct-by-construction.
        const lastColon = key.lastIndexOf(':');
        if (lastColon === -1) continue;
        return {
          scope: key.slice(0, lastColon),
          bucket: key.slice(lastColon + 1),
          id: itemId
        };
      }
    }
    return null;
  }

  function removeItem(id: string) {
    items.delete(id);
    itemMeta.delete(id);

    // Deep Referntial Integrity: Purge Graph
    for (const [edgeId, edge] of childrenEdges.entries()) {
      if (edge.child_id === id || edge.parent_id === id) {
        childrenEdges.delete(edgeId);
        remove_child_index(edge.parent_id, edgeId);
        remove_parent_index(edge.child_id, edgeId);
        emit({ type: 'EdgeDelete', edgeId });
      }
    }

    for (const [edgeId, edge] of appliesEdges.entries()) {
      if (edge.src_id === id || edge.dst_id === id) {
        appliesEdges.delete(edgeId);
        remove_applies_index(edge.src_id, edge.dst_id, edgeId);
        emit({ type: 'AppliesDelete', edgeId });
      }
    }

    // Deep Referntial Integrity: Purge Scopes
    for (const [key, slice] of scopeBucketSlices.entries()) {
      if (slice.item_ids.has(id)) {
        slice.item_ids.delete(id);
        scopeBucketSlices.set(key, slice); // Trigger Svelte Reactivity
      }
    }

    bumpEpoch(id);
    bump_generation();
    bump_scope_bucket_write_epoch();
    emit({ type: 'ItemDelete', id });
  }

  function batch_upsert(cores: CacheItem[]) {
    begin_children_batch();
    for (const core of cores) {
      normalizeItem(core);
    }
    end_children_batch();
    bump_scope_bucket_write_epoch();
    bump_generation();
  }

  function batch_delete(ids: string[]) {
    begin_children_batch();
    for (const id of ids) {
      removeItem(id);
    }
    end_children_batch();
    bump_scope_bucket_write_epoch();
    bump_generation();
  }

  function patch_item_additionals(itemId: string, additionals: AdditionalWithId[]) {
    const item = items.get(itemId);
    if (item) {
      item.additionals = cloneForCache(additionals);
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_text(itemId: string, text: string) {
    const item = items.get(itemId);
    if (item) {
      item.text = text;
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_color(itemId: string, custom_color: number) {
    const item = items.get(itemId);
    if (item) {
      item.custom_color = custom_color;
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_permissions(itemId: string, permissions: CacheItem['permissions']) {
    const item = items.get(itemId);
    if (item) {
      item.permissions = cloneForCache(permissions);
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_header(itemId: string, show_as_header: boolean) {
    const item = items.get(itemId);
    if (item) {
      item.show_as_header = show_as_header;
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_module_settings(itemId: string, module_settings: Record<string, unknown>) {
    const item = items.get(itemId);
    if (item) {
      item.module_settings = cloneForCache(module_settings);
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function patch_item_settings(itemId: string, settings: Record<string, unknown> | undefined) {
    const item = items.get(itemId);
    if (item) {
      item.settings = settings ? cloneForCache(settings) : undefined;
      items.set(itemId, { ...item });
      bumpEpoch(itemId);
      emit({ type: 'ItemUpsert', item: items.get(itemId)! });
    }
  }

  function update_sync_status(id: string, status: SyncStatus) {
    const meta = itemMeta.get(id) ?? { dirty: false };
    itemMeta.set(id, { ...meta, sync_status: status });
    bumpEpoch(id);
    emit({ type: 'RecordSyncStatus', id, status });
  }

  function remap_id(oldId: string, newId: string) {
    // 1. Core items
    const item = items.get(oldId);
    if (item) {
      items.delete(oldId);
      item.id = newId;
      item.is_temp = false;
      items.set(newId, item);
    }

    // 2. Metadata
    const meta = itemMeta.get(oldId);
    if (meta) {
      itemMeta.delete(oldId);
      meta.dirty = false;
      meta.sync_status = 'accepted';
      itemMeta.set(newId, meta);
    }

    // 3. Children Edges
    for (const [edgeId, edge] of childrenEdges.entries()) {
      let changed = false;
      if (edge.child_id === oldId) {
        remove_parent_index(oldId, edgeId);
        edge.child_id = newId;
        add_parent_index(newId, edgeId);
        changed = true;
      }
      if (edge.parent_id === oldId) {
        remove_child_index(oldId, edgeId);
        edge.parent_id = newId;
        add_child_index(newId, edgeId);
        changed = true;
      }
      if (changed) {
        childrenEdges.set(edgeId, edge); 
        emit({ type: 'EdgeUpsert', edge });
      }
    }

    for (const [edgeId, edge] of appliesEdges.entries()) {
      let changed = false;
      if (edge.src_id === oldId) {
        remove_applies_index(oldId, edge.dst_id, edgeId);
        edge.src_id = newId;
        add_applies_index(newId, edge.dst_id, edgeId);
        changed = true;
      }
      if (edge.dst_id === oldId) {
        remove_applies_index(edge.src_id, oldId, edgeId);
        edge.dst_id = newId;
        add_applies_index(edge.src_id, newId, edgeId);
        changed = true;
      }
      if (changed) {
        appliesEdges.set(edgeId, edge);
        emit({ type: 'AppliesUpsert', edge });
      }
    }

    // 4. Scope Buckets
    for (const [key, slice] of scopeBucketSlices.entries()) {
      if (slice.item_ids.has(oldId)) {
        slice.item_ids.delete(oldId);
        slice.item_ids.add(newId);
        scopeBucketSlices.set(key, slice);
        emit({ type: 'ScopeDayUpsert', scope: slice.scope, bucket: slice.bucket, itemIds: Array.from(slice.item_ids) });
      }
    }

    bumpEpoch(oldId);
    bumpEpoch(newId);
    bump_generation();
    bump_scope_bucket_write_epoch();
    
    emit({ type: 'TempIdRemap', tempId: oldId, realId: newId });
  }

  function clear() {
    items = new Map();
    childrenEdges = new Map();
    appliesEdges = new Map();
    scopeBucketSlices = new Map();
    itemMeta = new Map();
    epochs.clear();
    childrenByParent = new Map();
    appliesBySource = new Map();
    appliesByDest = new Map();
    bump_scope_bucket_write_epoch();
    bump_generation();
    emit({ type: 'Clear' });
  }

  function getItem(id: string): CacheItem | undefined {
    epochs.get(id);
    return items.get(id);
  }

  function getAllItems(): CacheItem[] {
    generation;
    for (const id of items.keys()) {
      epochs.get(id);
    }
    return Array.from(items.values());
  }

  function hydrate_meta(id: string, meta: EntityMeta) {
    itemMeta.set(id, meta);
  }

  function hydrate_scope_day(scope: string, bucket: string, itemIds: string[]) {
    const key = scope_bucket_key(scope, bucket);
    scopeBucketSlices.set(key, { scope, bucket, item_ids: new Set(itemIds), last_write_epoch: scopeBucketWriteEpoch });
  }

  function notify_sync_idle() {
    emit({ type: 'SyncIdle' });
  }

  return {
    get itemCount() { generation; return items.size; },
    get childrenEdgeCount() { generation; return childrenEdges.size; },
    get appliesEdgeCount() { generation; return appliesEdges.size; },
    get scopeBucketWriteEpoch() { return scopeBucketWriteEpoch; },
    get generation() { return generation; },

    subscribe,
    // Deep-clone a value to a plain (non-reactive) structure via
    // $state.snapshot + structuredClone. Used by the sync engine to de-proxy
    // Svelte $state payloads BEFORE they enter the op pipeline (persist to IDB
    // + broadcast over BroadcastChannel both structured-clone, which reject
    // proxies with DataCloneError and leave the op stuck pending/inflight).
    clonePlain: cloneForCache,
    normalizeItem,
    normalize_tree,
    begin_children_batch,
    end_children_batch,
    upsert_graph_child_of_edge,
    remove_graph_child,
    upsert_applies_edge,
    remove_applies_edge,
    record_scope_bucket_items,
    record_scope_bucket_items_batch,
    isItemInScope,
    get_items_for_scope_bucket,
    get_children_for_parent,
    get_parents_for_child,
    get_applies_for_source,
    get_applies_for_dest,
    getRecordKey,
    removeItem,
    batch_upsert,
    batch_delete,
    patch_item_additionals,
    patch_item_text,
    patch_item_color,
    patch_item_permissions,
    patch_item_header,
    patch_item_module_settings,
    patch_item_settings,
    update_sync_status,
    remap_id,
    hydrate_meta,
    hydrate_scope_day,
    notify_sync_idle,
    clear,
    getItem,
    getAllItems,
    items: { get size() { generation; return items.size; } },
    childrenEdges: {
      get size() { generation; return childrenEdges.size; },
      get(key: string) { generation; return childrenEdges.get(key); },
      values() { generation; return childrenEdges.values(); }
    },
    appliesEdges: {
      get size() { generation; return appliesEdges.size; },
      get(key: string) { generation; return appliesEdges.get(key); },
      values() { generation; return appliesEdges.values(); }
    },
    scopeBucketSlices: { 
      get size() { scopeBucketWriteEpoch; return scopeBucketSlices.size; },
      get(key: string) { scopeBucketWriteEpoch; return scopeBucketSlices.get(key); },
      values() { scopeBucketWriteEpoch; return scopeBucketSlices.values(); }
    },
    epochs: { get size() { return epochs.size; } },
    itemMeta: { 
      get(id: string) { epochs.get(id); return itemMeta.get(id); }
    }
  };
}

export type AppCache = ReturnType<typeof createAppCache>;
