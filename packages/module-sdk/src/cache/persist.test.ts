import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { persistItem, loadAllItems, persistAppliesEdge, loadScopeSyncState, persistScopeSyncState, cleanupStaleDatabases, persistOp, getPendingOps, deleteRuntimeState, getMeta, getRuntimeState, loadAllMeta, setRuntimeState } from './persist.ts';
import { createAppCache } from './store.svelte.ts';
import { hydrateCache, createCachePersistence } from './hydration.ts';
import type { CacheItem } from './types.ts';

function createDummyItem(id: string): CacheItem {
  return {
    id,
    text: `Test Item ${id}`,
    is_temp: false,
    dirty: false,
    sync_status: 'accepted'
  };
}

describe('Cache Persistence & Isolation', () => {
  beforeEach(async () => {
    // We can clear DBs or rely on separate namespaces
  });

  afterEach(async () => {
    // Restore spies so mocked `indexedDB.databases`/`deleteDatabase` from one
    // test don't leak into the next (several tests below spy on these).
    vi.restoreAllMocks();
  });

  it('namespaces IndexedDB correctly (cross-account isolation)', async () => {
    const userA = 'alice';
    const userB = 'bob';

    await persistItem(userA, createDummyItem('item-1'));
    await persistItem(userB, createDummyItem('item-2'));

    const itemsA = await loadAllItems(userA);
    const itemsB = await loadAllItems(userB);

    expect(itemsA).toHaveLength(1);
    expect(itemsA[0].id).toBe('item-1');

    expect(itemsB).toHaveLength(1);
    expect(itemsB[0].id).toBe('item-2');
  });

  it('hydrates Svelte API cache from IDB (reload scenario)', async () => {
    const ns = 'test-reload';
    
    // 1. Simulate previous session saving to IDB
    await persistItem(ns, createDummyItem('reload-1'));
    await persistAppliesEdge(ns, { edge_id: 'applies-1', src_id: 'reload-1', dst_id: 'records:linked' });
    
    // 2. Simulate fresh app start
    const cache = createAppCache();
    await hydrateCache(cache, ns);
    
    expect(cache.itemCount).toBe(1);
    expect(cache.appliesEdgeCount).toBe(1);
    expect(cache.getItem('reload-1')?.text).toBe('Test Item reload-1');
    expect(cache.get_applies_for_source('reload-1')).toEqual([
      {
        edge_id: 'applies-1',
        src_id: 'reload-1',
        dst_id: 'records:linked',
        module_data: undefined
      }
    ]);
  });

  it('syncs in-memory Svelte changes to IDB (snapshot path)', async () => {
    const ns = 'test-snapshot';
    const cache = createAppCache();
    
    // Bind persistence
    const unsubscribe = createCachePersistence(cache, ns);
    
    // Simulate user editing UI -> Svelte cache normalizes
    cache.normalizeItem(createDummyItem('snap-1'));
    
    // Give IDB async promise a tiny tick to resolve
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Check IDB directly
    const items = await loadAllItems(ns);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('snap-1');
    
    unsubscribe();
  });

  it('removes stale metadata when records are deleted or the cache is cleared', async () => {
    const ns = 'test-meta-cleanup';
    const cache = createAppCache();
    const unsubscribe = createCachePersistence(cache, ns);

    cache.normalizeItem(createDummyItem('meta-1'));
    cache.update_sync_status('meta-1', 'pending');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await getMeta(ns, 'meta-1')).toEqual(expect.objectContaining({ sync_status: 'pending' }));

    cache.removeItem('meta-1');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await getMeta(ns, 'meta-1')).toBeUndefined();

    cache.normalizeItem(createDummyItem('meta-2'));
    cache.update_sync_status('meta-2', 'accepted');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await loadAllMeta(ns)).toHaveLength(1);

    cache.clear();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(await loadAllMeta(ns)).toHaveLength(0);

    unsubscribe();
  });

  it('persists scope sync markers durably across reloads', async () => {
    const ns = 'test-sync-markers';

    await persistScopeSyncState(ns, {
      scope: 'work',
      last_synced_at: 123456,
      records_count: 5,
      grouping_edges_count: 2,
      applies_edges_count: 1,
      source: 'leader'
    });

    const state = await loadScopeSyncState(ns, 'work');

    expect(state).toEqual({
      scope: 'work',
      last_synced_at: 123456,
      records_count: 5,
      grouping_edges_count: 2,
      applies_edges_count: 1,
      source: 'leader'
    });
  });

  it('persists runtime catch-up flags durably across reloads', async () => {
    const ns = 'test-runtime-state';

    await setRuntimeState(ns, 'live.catchup.required', true);
    expect(await getRuntimeState<boolean>(ns, 'live.catchup.required')).toBe(true);

    await deleteRuntimeState(ns, 'live.catchup.required');
    expect(await getRuntimeState(ns, 'live.catchup.required')).toBeUndefined();
  });

  it('handles profile switching cleanly', async () => {
    const cache = createAppCache();
    
    // Profile 1
    const p1 = 'profile-1';
    await hydrateCache(cache, p1);
    const unsub1 = createCachePersistence(cache, p1);
    cache.normalizeItem(createDummyItem('belong-to-p1'));
    await new Promise(r => setTimeout(r, 10)); // let persist finish

    // Simulate Profile Switch
    unsub1(); // Detach p1 writer
    const p2 = 'profile-2';
    await hydrateCache(cache, p2); // This clears AppCache and loads p2 state!
    const unsub2 = createCachePersistence(cache, p2);
    
    expect(cache.itemCount).toBe(0); // P2 has nothing yet
    
    cache.normalizeItem(createDummyItem('belong-to-p2'));
    await new Promise(r => setTimeout(r, 10));
    
    expect(cache.itemCount).toBe(1);
    expect(cache.getItem('belong-to-p2')).toBeDefined();

    // Verify IDB directly
    const items1 = await loadAllItems(p1);
    expect(items1).toHaveLength(1);
    expect(items1[0].id).toBe('belong-to-p1');

    const items2 = await loadAllItems(p2);
    expect(items2).toHaveLength(1);
    expect(items2[0].id).toBe('belong-to-p2');

    unsub2();
  });

  it('cleans up only stale databases', async () => {
    const databasesSpy = vi.spyOn(indexedDB, 'databases').mockResolvedValue([
      { name: 'modular-app-cache-keep-1' },
      { name: 'modular-app-cache-stale-1' }
    ] as IDBDatabaseInfo[]);

    const deleteDatabaseSpy = vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation((name: string) => {
      const request = {
        onsuccess: null,
        onerror: null,
        onblocked: null
      } as unknown as IDBOpenDBRequest;

      queueMicrotask(() => {
        request.onsuccess?.(new Event('success'));
      });

      return request;
    });

    await cleanupStaleDatabases(['keep-1']);

    expect(databasesSpy).toHaveBeenCalledTimes(1);
    expect(deleteDatabaseSpy).toHaveBeenCalledTimes(1);
    expect(deleteDatabaseSpy).toHaveBeenCalledWith('modular-app-cache-stale-1');
  });

  it('skips databases with pending ops and reports them (M4 data-loss guard)', async () => {
    const ns = 'm2-skip';
    // Seed a pending op so the namespace is "dirty" (unsynced work in flight).
    await persistOp(ns, {
      id: 'op-pending-1',
      kind: 'UpdateRecord',
      payload: {},
      status: 'pending',
      created: Date.now(),
      retries: 0
    });

    const databasesSpy = vi
      .spyOn(indexedDB, 'databases')
      .mockResolvedValue([{ name: `modular-app-cache-${ns}` }] as IDBDatabaseInfo[]);
    const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');

    const result = await cleanupStaleDatabases([]);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.skippedWithPendingOps).toEqual([
      { namespace: ns, pendingCount: 1 }
    ]);

    databasesSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it('forces deletion of databases with pending ops when forced', async () => {
    const ns = 'm2-force';
    await persistOp(ns, {
      id: 'op-pending-2',
      kind: 'UpdateRecord',
      payload: {},
      status: 'inflight',
      created: Date.now(),
      retries: 0
    });

    const databasesSpy = vi
      .spyOn(indexedDB, 'databases')
      .mockResolvedValue([{ name: `modular-app-cache-${ns}` }] as IDBDatabaseInfo[]);
    const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');

    const result = await cleanupStaleDatabases([], { force: [ns] });

    expect(deleteSpy).toHaveBeenCalledWith(`modular-app-cache-${ns}`);
    expect(result.skippedWithPendingOps).toEqual([]);

    databasesSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it('deletes databases whose ops are all settled (no pending/inflight)', async () => {
    const ns = 'm2-clean';
    await persistOp(ns, {
      id: 'op-accepted-1',
      kind: 'UpdateRecord',
      payload: {},
      status: 'accepted',
      created: Date.now(),
      retries: 0
    });
    // Sanity: getPendingOps sees only pending+inflight, so accepted ops don't count.
    expect(await getPendingOps(ns)).toHaveLength(0);

    const databasesSpy = vi
      .spyOn(indexedDB, 'databases')
      .mockResolvedValue([{ name: `modular-app-cache-${ns}` }] as IDBDatabaseInfo[]);
    const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');

    const result = await cleanupStaleDatabases([]);

    expect(deleteSpy).toHaveBeenCalledWith(`modular-app-cache-${ns}`);
    expect(result.skippedWithPendingOps).toEqual([]);

    databasesSpy.mockRestore();
    deleteSpy.mockRestore();
  });
});
