import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CacheItem, ChildEdge, AppliesEdge } from './types.ts';
import { DAY_MS } from '@modular-app/ui/date';

interface ModularAppDB extends DBSchema {
  items: {
    key: string;
    value: CacheItem;
    indexes: { 'by-scope-bucket': [string, string] };
  };
  graphChildEdges: {
    key: string;
    value: ChildEdge;
    indexes: { 'by-parent': string };
  };
  appliesEdges: {
    key: string;
    value: AppliesEdge;
    indexes: { 'by-src': string };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
  scopeDay: {
    key: string;
    value: { key: string; scope: string; bucket: string; item_ids: string[] };
  };
  syncState: {
    key: string;
    value: {
      scope: string;
      last_synced_at: number;
      records_count: number;
      grouping_edges_count: number;
      applies_edges_count: number;
      source: string;
    };
  };
  runtimeState: {
    key: string;
    value: {
      key: string;
      value: unknown;
    };
  };
  oplog: {
    key: string;
    value: {
      id: string;
      kind: string;
      payload: unknown;
      status: string;
      created: number;
      retries: number;
      last_error?: string;
      last_error_kind?: string;
      last_attempt_at?: number;
      updated?: number;
      conflictCurrent?: Record<string, unknown> | null;
    };
    indexes: { 'by-status': string };
  };
}

const DB_PREFIX = 'modular-app-cache-';
const DB_VERSION = 8;

const dbInstances = new Map<string, IDBPDatabase<ModularAppDB>>();

async function clearDatabaseContents(db: IDBPDatabase<ModularAppDB>): Promise<void> {
  const tx = db.transaction(['items', 'graphChildEdges', 'appliesEdges', 'meta', 'scopeDay', 'syncState', 'runtimeState', 'oplog'], 'readwrite');
  await Promise.all([
    tx.objectStore('items').clear(),
    tx.objectStore('graphChildEdges').clear(),
    tx.objectStore('appliesEdges').clear(),
    tx.objectStore('meta').clear(),
    tx.objectStore('scopeDay').clear(),
    tx.objectStore('syncState').clear(),
    tx.objectStore('runtimeState').clear(),
    tx.objectStore('oplog').clear(),
    tx.done
  ]);
}

async function deleteDatabaseByName(dbName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    const timeout = setTimeout(() => resolve(false), 250);

    req.onsuccess = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    req.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    req.onblocked = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

export async function getCacheDb(namespace: string): Promise<IDBPDatabase<ModularAppDB>> {
  if (dbInstances.has(namespace)) {
    return dbInstances.get(namespace)!;
  }

  const dbName = `${DB_PREFIX}${namespace}`;
  const db = await openDB<ModularAppDB>(dbName, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (!db.objectStoreNames.contains('items')) {
        const itemsStore = db.createObjectStore('items', { keyPath: 'id' });
        itemsStore.createIndex('by-scope-bucket', ['scope', 'bucket']);
      }

      if (!db.objectStoreNames.contains('graphChildEdges')) {
        const edgesStore = db.createObjectStore('graphChildEdges', { keyPath: 'edge_id' });
        edgesStore.createIndex('by-parent', 'parent_id');
      }

      if (!db.objectStoreNames.contains('appliesEdges')) {
        const appliesStore = db.createObjectStore('appliesEdges', { keyPath: 'edge_id' });
        appliesStore.createIndex('by-src', 'src_id');
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('scopeDay')) {
        db.createObjectStore('scopeDay', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('syncState')) {
        db.createObjectStore('syncState', { keyPath: 'scope' });
      }

      if (!db.objectStoreNames.contains('runtimeState')) {
        db.createObjectStore('runtimeState', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('oplog')) {
        const oplogStore = db.createObjectStore('oplog', { keyPath: 'id' });
        oplogStore.createIndex('by-status', 'status');
      }

      // v8: oplog field rename `created_at` → `created`, `updated_at` → `updated`.
      // Walk existing rows and copy the values across so pending ops queued
      // before the upgrade keep their timestamps.
      if (oldVersion < 8 && db.objectStoreNames.contains('oplog')) {
        const store = tx.objectStore('oplog');
        store.openCursor().then(function migrate(cursor): Promise<void> | void {
          if (!cursor) return;
          const raw = cursor.value as Record<string, unknown>;
          let mutated = false;
          if (raw.created === undefined && typeof raw.created_at === 'number') {
            raw.created = raw.created_at;
            delete raw.created_at;
            mutated = true;
          }
          if (raw.updated === undefined && typeof raw.updated_at === 'number') {
            raw.updated = raw.updated_at;
            delete raw.updated_at;
            mutated = true;
          }
          if (mutated) cursor.update(raw as any);
          return cursor.continue().then(migrate);
        });
      }
    }
  });

  dbInstances.set(namespace, db);
  return db;
}

/**
 * Count pending + inflight ops in a cache DB by its full DB name, without
 * caching the connection. Used by `cleanupStaleDatabases` to refuse destroying
 * a DB that still holds unsynced work (the M4 data-loss guard). Returns 0 on
 * any open/parse failure so a corrupt or inaccessible DB still gets cleaned
 * rather than silently retained forever.
 */
async function countPendingOpsIn(rawNs: string, dbName: string): Promise<number> {
  try {
    const cached = dbInstances.get(rawNs);
    let db: IDBPDatabase<ModularAppDB>;
    let ownClose = false;
    if (cached) {
      db = cached;
    } else {
      db = await openDB<ModularAppDB>(dbName, DB_VERSION);
      ownClose = true;
    }
    try {
      const index = db.transaction('oplog').store.index('by-status');
      const [pending, inflight, conflicted] = await Promise.all([
        index.count('pending'),
        index.count('inflight'),
        index.count('conflicted')
      ]);
      return pending + inflight + conflicted;
    } finally {
      if (ownClose) db.close();
    }
  } catch {
    return 0;
  }
}

export interface CleanupSkippedDB {
  namespace: string;
  pendingCount: number;
}

export interface CleanupResult {
  /** Databases NOT deleted because they held pending/inflight ops. */
  skippedWithPendingOps: CleanupSkippedDB[];
}

export async function cleanupStaleDatabases(
  keepNamespaces: string[],
  options?: { force?: string[] }
): Promise<CleanupResult> {
  const result: CleanupResult = { skippedWithPendingOps: [] };
  if (!indexedDB.databases) return result;
  const databases = await indexedDB.databases();
  const keepSet = new Set(keepNamespaces.map(ns => `${DB_PREFIX}${ns}`));
  const forceSet = new Set((options?.force ?? []).map(ns => `${DB_PREFIX}${ns}`));

  for (const dbInfo of databases) {
    if (!dbInfo.name || !dbInfo.name.startsWith(DB_PREFIX) || keepSet.has(dbInfo.name)) {
      continue;
    }
    const rawNs = dbInfo.name.substring(DB_PREFIX.length);

    // Guard (M4 data-loss protection): never destroy a DB holding
    // pending/inflight ops unless the caller explicitly forces it (a
    // user-confirmed "Discard & sign out"). Surface skips so the app can
    // warn the user their unsynced changes were preserved.
    if (!forceSet.has(dbInfo.name)) {
      const pendingCount = await countPendingOpsIn(rawNs, dbInfo.name);
      if (pendingCount > 0) {
        result.skippedWithPendingOps.push({ namespace: rawNs, pendingCount });
        continue;
      }
    }

    if (dbInstances.has(rawNs)) {
      dbInstances.get(rawNs)!.close();
      dbInstances.delete(rawNs);
    }

    const deleted = await deleteDatabaseByName(dbInfo.name);
    if (deleted) {
      continue;
    }

    const db = await openDB<ModularAppDB>(dbInfo.name, DB_VERSION);
    await clearDatabaseContents(db);
    db.close();
  }

  return result;
}

/**
 * Close the IDB connection for a given namespace and remove it from the
 * connection cache. Call this before `cleanupStaleDatabases` when tearing
 * down a specific profile runtime so the database isn't held open.
 */
export function closeCacheDb(namespace: string): void {
  const db = dbInstances.get(namespace);
  if (db) {
    db.close();
    dbInstances.delete(namespace);
  }
}

export async function persistItem(namespace: string, item: CacheItem): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('items', item);
}

export async function persistItems(namespace: string, items: CacheItem[]): Promise<void> {
  const db = await getCacheDb(namespace);
  const tx = db.transaction('items', 'readwrite');
  await Promise.all([...items.map(item => tx.store.put(item)), tx.done]);
}

export async function persistChildEdge(namespace: string, edge: ChildEdge): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('graphChildEdges', edge);
}

export async function persistAppliesEdge(namespace: string, edge: AppliesEdge): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('appliesEdges', edge);
}

export async function persistChildEdges(namespace: string, edges: ChildEdge[]): Promise<void> {
  const db = await getCacheDb(namespace);
  const tx = db.transaction('graphChildEdges', 'readwrite');
  await Promise.all([...edges.map(edge => tx.store.put(edge)), tx.done]);
}

export async function persistAppliesEdges(namespace: string, edges: AppliesEdge[]): Promise<void> {
  const db = await getCacheDb(namespace);
  const tx = db.transaction('appliesEdges', 'readwrite');
  await Promise.all([...edges.map(edge => tx.store.put(edge)), tx.done]);
}

export async function deleteItem(namespace: string, id: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('items', id);
}

export async function deleteChildEdge(namespace: string, edgeId: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('graphChildEdges', edgeId);
}

export async function deleteAppliesEdge(namespace: string, edgeId: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('appliesEdges', edgeId);
}

export async function loadAllItems(namespace: string): Promise<CacheItem[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('items');
}

export async function loadAllChildEdges(namespace: string): Promise<ChildEdge[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('graphChildEdges');
}

export async function loadAllAppliesEdges(namespace: string): Promise<AppliesEdge[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('appliesEdges');
}

export async function loadScopeDay(namespace: string, scope: string): Promise<{ key: string; scope: string; bucket: string; item_ids: string[] } | undefined> {
  const db = await getCacheDb(namespace);
  return db.get('scopeDay', scope);
}

export async function loadAllScopeDays(namespace: string): Promise<{ key: string; scope: string; bucket: string; item_ids: string[] }[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('scopeDay');
}

export async function persistScopeDay(namespace: string, scope: string, bucket: string, itemIds: string[]): Promise<void> {
  const db = await getCacheDb(namespace);
  const key = `${scope}:${bucket}`;
  await db.put('scopeDay', { key, scope, bucket, item_ids: itemIds });
}

export async function loadScopeSyncState(namespace: string, scope: string): Promise<{
  scope: string;
  last_synced_at: number;
  records_count: number;
  grouping_edges_count: number;
  applies_edges_count: number;
  source: string;
} | undefined> {
  const db = await getCacheDb(namespace);
  return db.get('syncState', scope);
}

export async function loadAllScopeSyncStates(namespace: string): Promise<Array<{
  scope: string;
  last_synced_at: number;
  records_count: number;
  grouping_edges_count: number;
  applies_edges_count: number;
  source: string;
}>> {
  const db = await getCacheDb(namespace);
  return db.getAll('syncState');
}

export async function persistScopeSyncState(namespace: string, state: {
  scope: string;
  last_synced_at: number;
  records_count: number;
  grouping_edges_count: number;
  applies_edges_count: number;
  source: string;
}): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('syncState', state);
}

export async function deleteScopeSyncState(namespace: string, scope: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('syncState', scope);
}

export async function getRuntimeState<T = unknown>(namespace: string, key: string): Promise<T | undefined> {
  const db = await getCacheDb(namespace);
  const record = await db.get('runtimeState', key);
  return record?.value as T | undefined;
}

export async function setRuntimeState(namespace: string, key: string, value: unknown): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('runtimeState', { key, value });
}

export async function deleteRuntimeState(namespace: string, key: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('runtimeState', key);
}

export async function cleanupOldOps(namespace: string, maxAgeMs: number = 7 * DAY_MS): Promise<void> {
  const db = await getCacheDb(namespace);
  const tx = db.transaction('oplog', 'readwrite');
  const cutoff = Date.now() - maxAgeMs;
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const op = cursor.value;
    if ((op.status === 'accepted' || op.status === 'rejected') && op.created < cutoff) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function getMeta(namespace: string, key: string): Promise<unknown | undefined> {
  const db = await getCacheDb(namespace);
  const record = await db.get('meta', key);
  return record?.value;
}

export async function loadAllMeta(namespace: string): Promise<{ key: string; value: unknown }[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('meta');
}

export async function setMeta(namespace: string, key: string, value: unknown): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('meta', { key, value });
}

export async function deleteMeta(namespace: string, key: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('meta', key);
}

export async function clearAllCache(namespace: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await clearDatabaseContents(db);
}

export interface PersistedOp {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  created: number;
  retries: number;
  last_error?: string;
  last_error_kind?: string;
  last_attempt_at?: number;
  updated?: number;
  conflictCurrent?: Record<string, unknown> | null;
}

export async function getPendingOps(namespace: string): Promise<PersistedOp[]> {
  const db = await getCacheDb(namespace);
  const index = db.transaction('oplog').store.index('by-status');
  const [pending, inflight] = await Promise.all([
    index.getAll('pending'),
    index.getAll('inflight')
  ]);
  return [...pending, ...inflight];
}

/**
 * 'conflicted' ops never auto-retry (excluded from getPendingOps' drain
 * set), but they ARE unsynced local work — a sign-out or destructive
 * cleanup must treat them the same as pending/inflight ops for the M4
 * data-loss guard, or a user could lose an edit they haven't resolved yet.
 */
export async function getConflictedOps(namespace: string): Promise<PersistedOp[]> {
  const db = await getCacheDb(namespace);
  const index = db.transaction('oplog').store.index('by-status');
  return index.getAll('conflicted');
}

export async function getAllOps(namespace: string): Promise<PersistedOp[]> {
  const db = await getCacheDb(namespace);
  return db.getAll('oplog');
}

export async function persistOp(namespace: string, op: PersistedOp): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.put('oplog', op);
}

export async function deleteOp(namespace: string, id: string): Promise<void> {
  const db = await getCacheDb(namespace);
  await db.delete('oplog', id);
}

export async function updateOpStatus(namespace: string, id: string, status: string): Promise<void> {
  const db = await getCacheDb(namespace);
  const op = await db.get('oplog', id);
  if (op) {
    op.status = status;
    op.updated = Date.now();
    await db.put('oplog', op);
  }
}
