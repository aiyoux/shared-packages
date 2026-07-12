import { createAppCache, type AppCache } from '../cache/store.svelte.ts';
import { hydrateCache, createCachePersistence } from '../cache/hydration.ts';
import { deleteRuntimeState, getRuntimeState, loadScopeSyncState, persistScopeSyncState, setRuntimeState, getPendingOps as loadPendingOps, type PersistedOp } from '../cache/persist.ts';
import { createLeaderElection, type LeaderElection } from './leader.svelte.ts';
import { createLiveBus, type LiveBus, type LeaderRpcCall, type LiveBusMsg } from './live.ts';
import { createSyncEngine, type SyncEngine, fetchWithTimeout } from './engine.ts';
import { createSurrealLiveConnection, type SurrealLiveConnection, type SurrealDbLiveConfig } from './surrealdb-live.ts';
import { createChangefeedCatchup } from './changefeed-catchup.ts';
import type { OpKind } from '../cache/types.ts';
import type { LogLevel } from './logger.ts';
import { createLogger } from './logger.ts';
import { buildSurrealStatement, extractQueryRows } from './surrealql.ts';
import { emitSyncTrace } from './trace.ts';
import { startFetch, endFetch } from './fetch-store.svelte.ts';
import type { AdditionalWithId } from '../types.ts';

export interface RuntimeSchemaIssue {
  /** Stable identifier so the host can dedupe / route. */
  code: 'records_no_select_permission' | 'records_table_missing';
  /** Short human-readable summary suitable for an error banner. */
  message: string;
  /** Optional longer detail (e.g. a remediation command). */
  detail?: string;
}

export interface RuntimeConfig extends SurrealDbLiveConfig {
  isolationKey: string;
  logLevel?: LogLevel;
  /** When provided, the runtime uses this shared leader election instead of creating its own. */
  leaderElection?: LeaderElection;
  /** Lazy token provider. When set, takes precedence over the static `token` field. */
  getToken?: () => Promise<string>;
  /**
   * Invoked when the runtime detects that the database schema is missing
   * something critical for the signed-in user (e.g. the `records` table has
   * `PERMISSIONS NONE`, which silently hides every row from a RECORD-auth
   * session). The host is expected to surface this in the UI rather than
   * letting the user stare at a permanently-empty list.
   */
  onSchemaIssue?: (issue: RuntimeSchemaIssue) => void;
  /**
   * Optional override for the push-scheduler concurrency cap (default 4).
   * Escape hatch only — the default is deliberately conservative. Under the
   * active/warm runtime lifecycle the number of LIVE runtimes is small, so the
   * aggregate push load stays bounded without a global semaphore.
   */
  pushConcurrency?: number;
}

export interface AppRuntime {
  cache: AppCache;
  liveBus: LiveBus;
  engine: SyncEngine;
  leaderElection: LeaderElection;
  isolationKey: string;
  start: () => Promise<void>;
  destroy: () => void;
  /**
   * Transition this runtime to WARM: release leadership for this DB (another
   * tab may take it), stop the sync loop, and disconnect the live WebSocket.
   * The cache, cache persistence, live bus, leader listener, and visibility/
   * focus listeners all stay alive — so resuming is cheap (no re-hydration).
   * Implemented by delegating to the existing leader-transition orchestrator:
   * `release()` fires the `onChange` follower-branch which tears down the live
   * connection and sync loop. Idempotent; no-op if destroyed.
   */
  pause: () => void;
  /**
   * Transition this runtime back to LIVE: re-acquire leadership; the existing
   * `onChange` leader-branch recreates the live connection, restarts the sync
   * loop, and (via `onReady`) runs changefeed catch-up to replay any changes
   * that landed while warm. Idempotent; no-op if destroyed. If another tab
   * holds this DB's lock, this runtime stays a follower and broadcasts
   * `RequestLeadership` to nudge a backgrounded leader to yield.
   */
  resume: () => void;
  queueAndWake: (kind: OpKind, payload: unknown) => void;
  /** Cancel a QUEUED (pending) sync op; returns false for inflight/unknown ops. */
  cancelOp: (opId: string) => boolean;
  updateScopes: (scopes: string[]) => void;
  getActiveScopes: () => string[];
  fetchAndCache: (call: LeaderRpcCall, timeoutMs?: number) => Promise<any[]>;
  // True while a namespace-scope resync (coarse snapshot + edge catch-up) is
  // in flight. Subscribers skip corrective slice mutations on coarse upserts.
  isResyncing: () => boolean;
  /**
   * Persisted pending + inflight ops for this runtime's IDB namespace. This is
   * the source of truth for data-loss guards (M4): it works for BOTH live and
   * warm/stopped runtimes, unlike the in-memory `engine.getPendingOps()` which
   * is only populated while the engine is running and excludes inflight ops.
   */
  getPendingOps: () => Promise<PersistedOp[]>;
}

const LIVE_CATCHUP_REQUIRED_KEY = 'live.catchup.required';
/**
 * Persisted high-water mark into the server `changes` table. On (re)connect we
 * replay only entries newer than this via `fn::sync_pull` instead of a full
 * resync. See the LIVE SYNC ARCHITECTURE note in surrealdb-live.ts.
 */
const CHANGEFEED_CURSOR_KEY = 'changefeed.cursor';

function normalizeScopeValue(scopeValue: unknown): string | null {
  if (typeof scopeValue !== 'string' || scopeValue.length === 0) {
    return null;
  }

  return scopeValue.replace(/^records:/, '');
}

function normalizeThingLike(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const thing = value as { tb?: unknown; table?: unknown; id?: unknown };
  const table = typeof thing.tb === 'string' ? thing.tb : typeof thing.table === 'string' ? thing.table : null;

  if (table && thing.id !== undefined && thing.id !== null) {
    const rawId =
      typeof thing.id === 'string' || typeof thing.id === 'number' || typeof thing.id === 'bigint'
        ? String(thing.id)
        : null;
    if (rawId) {
      return `${table}:${rawId}`;
    }
  }

  if (typeof (value as { toString?: () => string }).toString === 'function') {
    const stringified = (value as { toString: () => string }).toString();
    if (stringified && stringified !== '[object Object]') {
      return stringified;
    }
  }

  return null;
}

type NormalizedPermission = {
  role: 'owner' | 'editor-adv' | 'editor' | 'viewer';
  user_id: string;
  username?: string;
  user_icon_small?: string;
};

function normalizePermissionRole(value: unknown): NormalizedPermission['role'] | null {
  if (value === 'owner' || value === 'editor-adv' || value === 'editor' || value === 'viewer') {
    return value;
  }
  return null;
}

export function normalizeRecordPermissions(value: unknown): NormalizedPermission[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const permissions: NormalizedPermission[] = [];
  for (const rawPermission of value) {
    if (!rawPermission || typeof rawPermission !== 'object') continue;
    const source = rawPermission as Record<string, unknown>;
    const role = normalizePermissionRole(source.role ?? source.r);
    const userId = normalizeThingLike(source.user_id ?? source.u);
    if (!role || !userId) continue;
    permissions.push({
      role,
      user_id: userId,
      username: typeof source.username === 'string' ? source.username : undefined,
      user_icon_small: typeof source.user_icon_small === 'string' ? source.user_icon_small : undefined
    });
  }
  return permissions;
}

export function normalizeRecordRow<T extends Record<string, unknown>>(row: T | null | undefined): T | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const id = normalizeThingLike(row.id);
  if (!id) {
    return null;
  }

  return {
    ...row,
    id,
    permissions: normalizeRecordPermissions(row.permissions) ?? row.permissions
  };
}

function normalizeGraphEdgeRow<T extends Record<string, unknown>>(row: T | null | undefined) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const edgeId = normalizeThingLike(row.id);
  const childId = normalizeThingLike(row.in);
  const parentId = normalizeThingLike(row.out);

  if (!edgeId || !childId || !parentId) {
    return null;
  }

  return {
    ...row,
    id: edgeId,
    in: childId,
    out: parentId
  };
}

export function normalizeScopes(scopes: string[]): string[] {
  const normalized = new Set<string>();
  for (const scope of scopes) {
    const value = normalizeScopeValue(scope);
    if (value) {
      normalized.add(value);
    }
  }

  return [...normalized];
}

export function buildScopeVariants(scopes: string[]): string[] {
  const variants = new Set<string>();
  for (const scope of normalizeScopes(scopes)) {
    variants.add(scope);
    variants.add(`records:${scope}`);
  }

  return [...variants];
}

export function matchesScope(scopeValue: unknown, scopes: string[]): boolean {
  const normalized = normalizeScopeValue(scopeValue);
  if (!normalized) {
    return false;
  }

  return normalizeScopes(scopes).includes(normalized);
}

export function collectScopedRecordIds(
  scopes: string[],
  _localItems: Iterable<{ id: string }>,
  scopeSlices: Iterable<{ scope: string; item_ids: Iterable<string> }>,
  fetchedRecords: Array<{ id?: unknown }>
): Set<string> {
  const ids = new Set<string>();
  const normalizedScopes = new Set(normalizeScopes(scopes));

  // Authoritative source: scope bucket slices populated by the server
  for (const slice of scopeSlices) {
    const normalizedScope = normalizeScopeValue(slice.scope);
    if (!normalizedScope || !normalizedScopes.has(normalizedScope)) continue;
    for (const id of slice.item_ids) {
      ids.add(id);
    }
  }

  // Fetched records were already scoped by the server query
  for (const record of fetchedRecords) {
    if (typeof record?.id === 'string') {
      ids.add(record.id);
    }
  }

  return ids;
}

// Edge snapshots are namespace-wide (see fetchGroupingEdgesForScopes /
// fetchAppliesEdgesForScopes — they `SELECT * FROM <edge_table>` without a
// scope filter). Any locally cached edge whose id isn't in the fetched set is
// authoritative-stale and must be evicted, regardless of where its endpoints
// point: dangling edges left behind by past bugs (e.g. the MoveChild in/out
// swap that overwrote child_id with the parent id) and broken endpoint
// references would otherwise survive every reconcile forever. The
// `scopedRecordIds` argument is retained for API stability — callers still
// pass it — but is no longer consulted.
export function collectStaleGroupingEdgeIds(
  localEdges: Iterable<{ edge_id: string; parent_id: string; child_id: string }>,
  _scopedRecordIds: ReadonlySet<string>,
  fetchedRows: Array<{ id?: unknown }>
): string[] {
  const fetchedIds = new Set(
    fetchedRows
      .map((row) => (typeof row?.id === 'string' ? row.id : null))
      .filter((id): id is string => Boolean(id))
  );

  const staleIds: string[] = [];
  for (const edge of localEdges) {
    if (!fetchedIds.has(edge.edge_id)) {
      staleIds.push(edge.edge_id);
    }
  }

  return staleIds;
}

export function collectStaleAppliesEdgeIds(
  localEdges: Iterable<{ edge_id: string; src_id: string; dst_id: string }>,
  _scopedRecordIds: ReadonlySet<string>,
  fetchedRows: Array<{ id?: unknown }>
): string[] {
  const fetchedIds = new Set(
    fetchedRows
      .map((row) => (typeof row?.id === 'string' ? row.id : null))
      .filter((id): id is string => Boolean(id))
  );

  const staleIds: string[] = [];
  for (const edge of localEdges) {
    if (!fetchedIds.has(edge.edge_id)) {
      staleIds.push(edge.edge_id);
    }
  }

  return staleIds;
}

export function deriveOptimisticLiveMessages(kind: OpKind, payload: unknown): LiveBusMsg[] {
  // A batched multi-record update fans out to the same per-record optimistic
  // patches a single UpdateRecord would, so sibling tabs reflect the change
  // immediately without waiting for backend acceptance (the local tab patched
  // its own cache directly at the call site).
  if (kind === 'UpdateRecordsBatch') {
    if (!payload || typeof payload !== 'object') return [];
    const records = (payload as { records?: unknown }).records;
    if (!Array.isArray(records)) return [];
    return records.flatMap((record) => deriveOptimisticLiveMessages('UpdateRecord', record));
  }

  if (kind !== 'UpdateRecord' || !payload || typeof payload !== 'object') {
    return [];
  }

  const update = payload as {
    id?: unknown;
    text?: unknown;
    additionals?: unknown;
    removed_additional_ids?: unknown;
    custom_color?: unknown;
    show_as_header?: unknown;
    module_settings?: unknown;
  };
  const id = normalizeThingLike(update.id);
  if (!id) {
    return [];
  }

  const messages: LiveBusMsg[] = [];

  if (typeof update.text === 'string') {
    messages.push({ type: 'RecordPatchText', id, text: update.text });
  }
  if (typeof update.custom_color === 'number') {
    messages.push({ type: 'RecordPatchColor', id, color: update.custom_color });
  }
  if (typeof update.show_as_header === 'boolean') {
    messages.push({ type: 'RecordPatchHeader', id, isHeader: update.show_as_header });
  }
  if (Array.isArray(update.additionals) || Array.isArray(update.removed_additional_ids)) {
    // UpdateRecord payloads are merge-shaped (upserts + explicit removals) —
    // the applier merges into the cached array rather than replacing it, so
    // replaying queued ops (late-joining tabs, reload) can't resurrect the
    // old whole-array semantics.
    messages.push({
      type: 'RecordPatchAdditionals',
      id,
      additionals: (Array.isArray(update.additionals) ? update.additionals : []) as AdditionalWithId[],
      removedIds: Array.isArray(update.removed_additional_ids)
        ? (update.removed_additional_ids as unknown[]).map(String)
        : undefined,
      merge: true
    });
  }
  if (update.module_settings && typeof update.module_settings === 'object') {
    messages.push({
      type: 'RecordPatchModuleSettings',
      id,
      moduleSettings: update.module_settings as Record<string, unknown>
    });
  }

  return messages;
}

async function resolveToken(config: RuntimeConfig): Promise<string> {
  if (config.getToken) return config.getToken();
  return config.token;
}

/**
 * Applies a coarse namespace-scope record snapshot (`SELECT * FROM records`)
 * to the cache as a catch-up batch of upserts. Pure/exported so the
 * no-eviction contract is unit-testable without a live DB.
 *
 * NOTE: we deliberately do NOT reconcile deletes from this snapshot.
 * The namespace snapshot is a COARSE, permission-narrowed authority: under
 * record-auth a plain full-table select returns FEWER rows than the richer
 * view-specific queries that populate the cache (the calendar's date-range
 * fetch, FetchRecordGraph, …) — group/shared-visible rows are dropped by the
 * per-row permission scan. Treating "absent from this coarse snapshot" as
 * "deleted" therefore evicts records that genuinely exist. An earlier
 * exemption-by-slice-referenced-id only protected the *visible* month;
 * cached-but-off-screen records (e.g. a month you swiped away from) were
 * still evicted with no refetch to recover them, so they silently vanished
 * until a manual refresh. Genuine server deletes are already delivered
 * reliably by the live `RecordDelete`/`RecordBatchDelete` changefeed events +
 * changefeed catchup (changefeed-convert.ts, changefeed-dispatch.ts,
 * engine.ts RecordDelete handler) — that is the correct deletion authority,
 * not this coarse snapshot. If offline-tombstone cleanup is ever needed, it
 * must use a provably-complete or per-id authoritative check, never
 * `SELECT *` absence.
 */
export function applyRecordSnapshot(engine: SyncEngine, cores: any[]): Set<string> {
  const normalized = Array.isArray(cores)
    ? cores.map(core => {
        if (core && core.id && typeof core.id !== 'string' && typeof core.id.toString === 'function') {
          core.id = core.id.toString();
        }
        return core;
      }).filter(core => core && typeof core.id === 'string')
    : [];

  engine.applyRemote({ type: 'RecordBatchUpsert', cores: normalized });

  return new Set(normalized.map((core) => core.id));
}

export function createAppRuntime(config: RuntimeConfig): AppRuntime {
  const logLevel = config.logLevel ?? 'info';
  const logger = createLogger(`runtime:${config.isolationKey}`, logLevel);
  const cache = createAppCache();
  const ownsLeader = !config.leaderElection;
  const leaderElection = config.leaderElection ?? createLeaderElection(config.isolationKey);
  const liveBus = createLiveBus(config.isolationKey, leaderElection.tabId, { logLevel });

  const initialScopes = normalizeScopes(config.scopes);
  emitSyncTrace(`runtime:${config.isolationKey}`, 'create-runtime', {
    tabId: leaderElection.tabId,
    initialScopes,
    logLevel
  });
  const engine = createSyncEngine(cache, liveBus, {
    namespace: config.namespace,
    storageNamespace: config.isolationKey,
    url: config.url.replace(/^ws/, 'http'), // HTTP for mutations
    database: config.database,
    token: config.token,
    getToken: config.getToken,
    scopes: initialScopes,
    logLevel,
    pushConcurrency: config.pushConcurrency
  });
  
  let syncLoopStop: (() => void) | null = null;
  let liveConn: SurrealLiveConnection | null = null;
  let cachePersistUnsub: (() => void) | null = null;
  let leaderUnsub: (() => void) | null = null;
  let busUnsub: (() => void) | null = null;
  let activeScopes = [...initialScopes];
  let resyncPromise: Promise<void> | null = null;
  let resyncAbort: AbortController | null = null;
  // Depth (not a boolean) because resyncActiveScopes is abortable/re-entrant:
  // a new call aborts an in-flight one, whose finally decrements while the new
  // one increments. Exposed as rt.isResyncing() so cache subscribers (the
  // calendar reconciler) can avoid corrective slice mutations driven by the
  // coarse namespace snapshot whose client-side scope resolution is wrong
  // while the edge cache is cold — see CalendarPage sync_item_to_buckets.
  let resyncDepth = 0;
  let destroyed = false;
  let liveCatchupRequired = false;
  // First resync after start() is always authoritative — IDB state survives
  // across page loads and may contain ghosts left by past bugs that no live
  // event will ever clear. Subsequent resyncs honour the staleness window.
  let coldBootResyncPending = true;
  const SCOPE_SYNC_STALE_MS = 60_000;
  const LEADER_LIVE_RESTART_MIN_MS = 15_000;
  let lastLeaderLiveRestartAt = 0;

  async function markLiveCatchupRequired(required: boolean) {
    liveCatchupRequired = required;
    if (required) {
      await setRuntimeState(config.isolationKey, LIVE_CATCHUP_REQUIRED_KEY, true);
      return;
    }

    await deleteRuntimeState(config.isolationKey, LIVE_CATCHUP_REQUIRED_KEY);
  }

  // ── Changefeed cursor + gap recovery ─────────────────────────────────────
  let changefeedCursor: string | undefined;
  let cursorPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCursorToPersist: string | undefined;

  function flushCursorPersist() {
    cursorPersistTimer = null;
    const c = pendingCursorToPersist;
    if (c) void setRuntimeState(config.isolationKey, CHANGEFEED_CURSOR_KEY, c);
  }

  // Called for every changefeed entry as it is applied (live + catch-up), in
  // order. Debounced persistence — the cursor advances rapidly and only the
  // latest value matters for gap recovery.
  function onChangefeedCursorAdvance(cursorId: string) {
    changefeedCursor = cursorId;
    pendingCursorToPersist = cursorId;
    if (cursorPersistTimer == null) {
      cursorPersistTimer = setTimeout(flushCursorPersist, 1500);
    }
  }

  async function loadPersistedCursor(): Promise<string | undefined> {
    if (changefeedCursor) return changefeedCursor;
    const stored = await getRuntimeState<string>(config.isolationKey, CHANGEFEED_CURSOR_KEY);
    if (typeof stored === 'string' && stored.length > 0) changefeedCursor = stored;
    return changefeedCursor;
  }

  async function persistChangefeedCursor(cursor: string): Promise<void> {
    changefeedCursor = cursor;
    await setRuntimeState(config.isolationKey, CHANGEFEED_CURSOR_KEY, cursor);
  }

  async function clearPersistedCursor(): Promise<void> {
    changefeedCursor = undefined;
    await deleteRuntimeState(config.isolationKey, CHANGEFEED_CURSOR_KEY);
  }

  // Latest changes.cursor_id — used to seed the cursor on cold start so we
  // don't replay all history. Transport/parse lives here; the orchestration
  // (createChangefeedCatchup) is pure + unit-tested.
  async function seedChangefeedCursor(): Promise<string | undefined> {
    if (!liveConn) return undefined;
    const res: any = await liveConn.query(
      'SELECT VALUE cursor_id FROM changes ORDER BY cursor_id DESC LIMIT 1'
    );
    const arr = Array.isArray(res) ? res : [];
    const seed = arr[0]?.result?.[0] ?? arr[0]?.[0] ?? arr[0];
    return typeof seed === 'string' && seed.length > 0 ? seed : undefined;
  }

  // Gap recovery on (re)connect — see changefeed-catchup.ts for the contract.
  async function runChangefeedCatchup(source: 'leader' | 'follower') {
    if (!liveConn) return;
    const conn = liveConn;
    const { runChangefeedCatchup: run } = createChangefeedCatchup({
      loadPersistedCursor,
      persistCursor: persistChangefeedCursor,
      clearPersistedCursor,
      seedCursor: seedChangefeedCursor,
      runCatchup: (since) => conn.runCatchup(since),
      resync: () => resyncActiveScopes(source, true),
      markCaughtUp: () => markLiveCatchupRequired(false),
      onWarn: (msg, e) => logger.warn(msg, e)
    });
    await run();
  }

  function applyGroupingEdgeSnapshot(rows: any[]) {
    for (const row of rows) {
      const edgeId = typeof row?.id === 'string' ? row.id : null;
      if (!edgeId) continue;

      // wisewords schema:
      //   graph_child_of: in=child, out=parent  (key_parent flag on edge)
      //   groups:         in=group_record, out=member_record
      const isGraphChildOf = edgeId.startsWith('graph_child_of:');

      const rawIn  = typeof row?.in  === 'string' ? row.in  : row?.in?.id;
      const rawOut = typeof row?.out === 'string' ? row.out : row?.out?.id;

      if (typeof rawIn !== 'string' || typeof rawOut !== 'string') continue;

      const parentId = isGraphChildOf ? rawOut : rawIn;
      const childId  = isGraphChildOf ? rawIn  : rawOut;
      const isKeyParent = isGraphChildOf
        ? (typeof row.key_parent === 'boolean' ? row.key_parent : true)
        : false;

      engine.applyRemote({
        type: 'GraphChildUpsert',
        edge: {
          edge_id: edgeId,
          parent_id: parentId,
          child_id: childId,
          order: typeof row.order === 'number' ? row.order : 0,
          is_key_parent: isKeyParent,
          module_data: typeof row.module_data === 'object' ? row.module_data : undefined
        }
      });
    }
  }

  function applyAppliesEdgeSnapshot(rows: any[]) {
    for (const row of rows) {
      const edgeId = typeof row?.id === 'string' ? row.id : null;
      const srcId = typeof row?.in === 'string' ? row.in : row?.in?.id;
      const dstId = typeof row?.out === 'string' ? row.out : row?.out?.id;

      if (!edgeId || typeof srcId !== 'string' || typeof dstId !== 'string') {
        continue;
      }

      engine.applyRemote({
        type: 'AppliesUpsert',
        edgeId,
        srcId,
        dstId,
        moduleData: typeof row.module_data === 'object' ? row.module_data : undefined
      });
    }
  }

  function reconcileGroupingEdgeSnapshot(scopedRecordIds: ReadonlySet<string>, rows: any[]) {
    const staleEdgeIds = collectStaleGroupingEdgeIds(cache.childrenEdges.values(), scopedRecordIds, rows);
    for (const edgeId of staleEdgeIds) {
      engine.applyRemote({ type: 'GraphChildDelete', edgeId });
    }

    if (staleEdgeIds.length > 0) {
      logger.debug(`snapshot reconciled ${staleEdgeIds.length} stale grouping edges`);
    }
  }

  function reconcileAppliesEdgeSnapshot(scopedRecordIds: ReadonlySet<string>, rows: any[]) {
    const staleEdgeIds = collectStaleAppliesEdgeIds(cache.appliesEdges.values(), scopedRecordIds, rows);
    for (const edgeId of staleEdgeIds) {
      engine.applyRemote({ type: 'AppliesDelete', edgeId });
    }

    if (staleEdgeIds.length > 0) {
      logger.debug(`snapshot reconciled ${staleEdgeIds.length} stale applies edges`);
    }
  }

  async function executeQuery(sql: string, vars?: Record<string, unknown>): Promise<any> {
    // Always use HTTP for queries. The WS connection is used only for LIVE SELECT
    // subscriptions. This avoids issues with SurrealDB WS RPC query handling
    // (null vs NONE parameter mapping, multi-statement parsing, response format
    // differences) that cause queries to hang without responding.
    const statement = buildSurrealStatement(sql, vars);
    const httpUrl = config.url.replace(/^ws/, 'http') + '/sql';
    logger.debug(`executeQuery via HTTP: ${sql.slice(0, 80).replace(/\s+/g, ' ')}...`);

    const token = await resolveToken(config);
    const postSql = async (nextToken: string) => {
      const directInit = {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'text/plain',
          'surreal-ns': config.namespace,
          'surreal-db': config.database,
          'Authorization': `Bearer ${nextToken}`
        },
        body: statement
      };

      try {
        return await fetchWithTimeout(httpUrl, directInit);
      } catch (error) {
        if (typeof window === 'undefined') throw error;
        return await fetchWithTimeout('/api/runtime/sql', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            url: httpUrl,
            namespace: config.namespace,
            database: config.database,
            token: nextToken,
            statement
          })
        });
      }
    };

    let response = await postSql(token);

    // 401 retry: resolve a fresh token and retry once
    if (response.status === 401 && config.getToken) {
      logger.warn(`401 on query; retrying with fresh token`);
      const freshToken = await config.getToken();
      response = await postSql(freshToken);
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`HTTP query failed: ${response.status} ${text}`);
      // SECURITY: Do not leak raw database error messages to the client
      throw new Error(`HTTP query failed: ${response.status}`);
    }

    return await response.json();
  }

  async function fetchRecordsForScopes(_scopes: string[]): Promise<any[]> {
    // Namespace isolation is handled by the `use` RPC call during WebSocket handshake.
    // Fetch all records in the current namespace/database without additional scope filtering,
    // since records don't carry a `scope` field matching the SurrealDB namespace.
    const queryResult = await executeQuery('SELECT * FROM records');
    return extractQueryRows(queryResult);
  }

  async function fetchGroupingEdgesForScopes(_scopes: string[]): Promise<any[]> {
    // Fetch both hierarchy edges (graph_child_of) and many-to-many grouping (groups)
    // to match the wisewords schema.
    const [childEdges, groupEdges] = await Promise.all([
      executeQuery('SELECT * FROM graph_child_of').then(extractQueryRows),
      executeQuery('SELECT * FROM groups').then(extractQueryRows)
    ]);
    return [...childEdges, ...groupEdges];
  }

  async function fetchAppliesEdgesForScopes(_scopes: string[]): Promise<any[]> {
    const queryResult = await executeQuery('SELECT * FROM appliesto');
    return extractQueryRows(queryResult);
  }

  type RecordGraphFetchCall =
    | Extract<LeaderRpcCall, { type: 'FetchRecordGraph' }>
    | Extract<LeaderRpcCall, { type: 'FetchRecordGraphs' }>;

  function getRecordGraphIds(call: RecordGraphFetchCall): string[] {
    if (call.type === 'FetchRecordGraphs') {
      return [...new Set(call.ids.filter((id) => typeof id === 'string' && id.length > 0))];
    }
    return [call.id];
  }

  async function fetchRecordGraphs(call: RecordGraphFetchCall) {
    const includeGrouping = call.includeGrouping !== false;
    const includeConnections = call.includeConnections !== false;
    const includeParents = call.includeParents !== false;
    const includeChildren = call.includeChildren === true;
    const recursiveChildren = call.recursiveChildren === true;
    const ids = getRecordGraphIds(call);

    if (ids.length === 0) {
      return {
        roots: [],
        parents: [],
        childEdges: [],
        childRecords: []
      };
    }

    const rootSql = `
      SELECT *,
        ${includeGrouping ? '(SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping,' : ''}
        ${includeConnections
          ? `(SELECT *,
                (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping
              FROM array::concat(
                (SELECT * FROM <-appliesto<-records).filter(|$v| $v != none),
                (SELECT * FROM ->appliesto->records)
              )) AS connections,`
          : ''}
        (SELECT * FROM <-graph_child_of WHERE key_parent = true LIMIT 1) AS parent_edges
      FROM <array<record>>$ids;
    `;

    const roots = extractQueryRows(await executeQuery(rootSql, { ids }))
      .map((row) => normalizeRecordRow(row as Record<string, unknown>))
      .filter((row): row is Record<string, unknown> => Boolean(row));

    let parentRows: any[] = [];
    if (includeParents) {
      parentRows = extractQueryRows(
        await executeQuery(
          `
            LET $parent_ids = (
              SELECT VALUE out FROM graph_child_of
              WHERE in INSIDE <array<record>>$ids
            );
            SELECT *,
              ${includeGrouping ? '(SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping,' : ''}
              ${includeConnections
                ? `(SELECT *,
                      (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping
                    FROM array::concat(
                      (SELECT * FROM <-appliesto<-records).filter(|$v| $v != none),
                      (SELECT * FROM ->appliesto->records)
              )) AS connections`
                : '*'}
            FROM <array<record>>$parent_ids;
          `,
          { ids }
        )
      )
        .map((row) => normalizeRecordRow(row as Record<string, unknown>))
        .filter((row): row is Record<string, unknown> => Boolean(row));
    }

    let childEdges: any[] = [];
    let childRecords: any[] = [];
    if (includeChildren) {
      // graph_child_of: in=child, out=parent
      // groups: in=group_record, out=member_record
      const childSql = `
        SELECT * FROM array::concat(
          (SELECT * FROM graph_child_of WHERE out INSIDE <array<record>>$parentIds),
          (SELECT * FROM groups WHERE in INSIDE <array<record>>$parentIds)
        );
      `;
      const directEdges = extractQueryRows(await executeQuery(childSql, { parentIds: ids }))
        .map((row) => normalizeGraphEdgeRow(row as Record<string, unknown>))
        .filter((row): row is NonNullable<ReturnType<typeof normalizeGraphEdgeRow>> => Boolean(row));
      const visited = new Set<string>(ids);
      let edgesToProcess = directEdges;

      while (edgesToProcess.length > 0) {
        const batchChildIds: string[] = [];
        for (const edge of edgesToProcess) {
          const isGroupingEdge = typeof edge.id === 'string' && edge.id.startsWith('groups:');
          const childId = isGroupingEdge ? edge.out : edge.in;
          if (childId && !visited.has(childId)) {
            batchChildIds.push(childId);
            visited.add(childId);
          }
          childEdges.push(edge);
        }

        // Fetch the child records
        if (batchChildIds.length > 0) {
          const recordRows = extractQueryRows(
            await executeQuery(
              `
                SELECT *,
                  ${includeGrouping ? '(SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping,' : ''}
                  ${includeConnections
                    ? `(SELECT *,
                          (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping
                        FROM array::concat(
                          (SELECT * FROM <-appliesto<-records).filter(|$v| $v != none),
                          (SELECT * FROM ->appliesto->records)
              )) AS connections,`
                    : ''}
                  (SELECT * FROM <-graph_child_of WHERE key_parent = true LIMIT 1) AS parent_edges
                FROM <array<record>>$ids;
              `,
              { ids: batchChildIds }
            )
          )
            .map((row) => normalizeRecordRow(row as Record<string, unknown>))
            .filter((row): row is Record<string, unknown> => Boolean(row));
          childRecords.push(...recordRows);
        }

        // Recurse into grandchildren if recursiveChildren
        if (recursiveChildren && batchChildIds.length > 0) {
          const nextEdges = extractQueryRows(
            await executeQuery(
              `
                SELECT * FROM array::concat(
                  (SELECT * FROM graph_child_of WHERE out INSIDE <array<record>>$parentIds),
                  (SELECT * FROM groups WHERE in INSIDE <array<record>>$parentIds)
                );
              `,
              { parentIds: batchChildIds }
            )
          )
            .map((row) => normalizeGraphEdgeRow(row as Record<string, unknown>))
            .filter((row): row is NonNullable<ReturnType<typeof normalizeGraphEdgeRow>> => Boolean(row));
          edgesToProcess = nextEdges;
        } else {
          break;
        }
      }
    }

    return {
      roots,
      parents: parentRows,
      childEdges,
      childRecords
    };
  }

  async function fetchRecordGraph(call: Extract<LeaderRpcCall, { type: 'FetchRecordGraph' }>) {
    const graph = await fetchRecordGraphs(call);
    return {
      root: graph.roots[0] ?? null,
      parents: graph.parents,
      childEdges: graph.childEdges,
      childRecords: graph.childRecords
    };
  }

  async function fetchVwtData(call: Extract<LeaderRpcCall, { type: 'FetchVwtData' }>) {
    const tid = call.templateId.startsWith('records:') ? call.templateId : `records:${call.templateId}`;
    const limit = call.limit ?? 100;
    const offset = call.offset ?? 0;

    const sql = `
      LET $root = type::record($tid);
      LET $templateChildren = (SELECT VALUE id FROM <-graph_child_of<-records);
      LET $cloneSources = array::concat([$root], $templateChildren);
      LET $cloneRoots = (
        SELECT VALUE id FROM (
          SELECT id, updated FROM records
          WHERE copied_from_record INSIDE $cloneSources
          ORDER BY updated DESC
          LIMIT $limit START $offset
        )
      );
      LET $roots = array::distinct(array::concat([$root], $cloneRoots));
      LET $descendantIds = fn::find_all_child_records_any_type($roots, [], { is_grouper: false }, [], NONE, NONE);
      LET $allIds = array::distinct(array::concat($roots, $descendantIds));
      LET $rootRecords = (
        SELECT *,
          (SELECT * FROM <-graph_child_of WHERE key_parent = true LIMIT 1) AS parent_edges
        FROM $roots
      );
      LET $childRecords = (
        SELECT *,
          (SELECT * FROM <-graph_child_of WHERE key_parent = true LIMIT 1) AS parent_edges
        FROM $descendantIds
      );
      LET $childEdges = (
        SELECT * FROM graph_child_of
        WHERE out INSIDE $allIds AND in INSIDE $allIds
      );
      RETURN [{
        roots: $rootRecords,
        parents: [],
        childRecords: $childRecords,
        childEdges: $childEdges
      }];
    `;
    const rows = extractQueryRows(await executeQuery(sql, { tid, limit, offset }));
    return rows[0] ?? { roots: [], parents: [], childRecords: [], childEdges: [] };
  }

  async function fetchPlanningTemplatesRoot() {
    const rows = extractQueryRows(
      await executeQuery(
        // Return shape MUST be an array so extractQueryRows can read it. Under
        // SurrealDB 3.x "SELECT ... FROM ONLY $pt" yields a single object and the
        // trailing [0] then indexed INTO that object and produced NONE (in 2.x it
        // returned the object). The resulting non-array `result` also tripped
        // extractQueryRows, which fell back to returning the raw {result,status}
        // wrapper. Dropping ONLY and wrapping the single root in an explicit array
        // restores a well-formed [root] payload.
        `
          LET $pt = $auth.id.calendar_module.planning_templates;
          RETURN IF $pt = NONE {
            []
          } ELSE {
            [(
              SELECT *,
                (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping,
                (SELECT * FROM <-graph_child_of WHERE key_parent = true LIMIT 1) AS parent_edges
              FROM $pt
            )[0]]
          };
        `
      )
    );

    return rows[0] ?? null;
  }

  async function persistScopeSyncMarkers(
    scopes: string[],
    records: any[],
    groupingEdges: any[],
    appliesEdges: any[],
    source: 'leader' | 'follower'
  ) {
    const persistedAt = Date.now();
    // Use the isolationKey as the single sync marker since we fetch all data
    // in the namespace rather than scoping per record group.
    const scopeKey = scopes.length > 0 ? scopes[0] : config.isolationKey;
    await persistScopeSyncState(config.isolationKey, {
      scope: scopeKey,
      last_synced_at: persistedAt,
      records_count: records.length,
      grouping_edges_count: groupingEdges.length,
      applies_edges_count: appliesEdges.length,
      source
    });
  }

  async function resyncActiveScopes(source: 'leader' | 'follower', force = true) {
    // Abort any in-flight resync so we don't apply stale scope data
    if (resyncAbort) {
      resyncAbort.abort();
    }
    if (resyncPromise) {
      try { await resyncPromise; } catch { /* aborted */ }
    }

    const abort = new AbortController();
    resyncAbort = abort;

    const run = async () => {
    if (destroyed) return;
    const scopes = [...activeScopes];
    const scopeKey = scopes.length > 0 ? scopes[0] : config.isolationKey;
    const syncState = await loadScopeSyncState(config.isolationKey, scopeKey);
    const syncStateAgeMs = syncState ? Date.now() - syncState.last_synced_at : null;
    const syncStateIsStale = syncStateAgeMs == null || syncStateAgeMs > SCOPE_SYNC_STALE_MS;

    if (!force && !liveCatchupRequired && !syncStateIsStale && !coldBootResyncPending) {
      logger.debug(`skipped scope resync for ${source}; sync markers are still fresh`);
      return;
    }
    coldBootResyncPending = false;

    try {
      const cores = await fetchRecordsForScopes(scopes);

      if (abort.signal.aborted) return;
      const scopedRecordIds = applyRecordSnapshot(engine, cores);

      const edgeRows = await fetchGroupingEdgesForScopes(scopes);

      if (abort.signal.aborted) return;
      applyGroupingEdgeSnapshot(edgeRows);
      reconcileGroupingEdgeSnapshot(scopedRecordIds, edgeRows);

      const appliesRows = await fetchAppliesEdgesForScopes(scopes);

      if (abort.signal.aborted) return;
      applyAppliesEdgeSnapshot(appliesRows);
      reconcileAppliesEdgeSnapshot(scopedRecordIds, appliesRows);
      await persistScopeSyncMarkers(scopes, cores, edgeRows, appliesRows, source);
      await markLiveCatchupRequired(false);
      logger.debug(`resynced ${scopes.length} scopes as ${source}`);
    } catch (error) {
      if (abort.signal.aborted) return; // Expected cancellation
      logger.warn(`scope resync failed for ${source}`, error);
    }
    };

    resyncDepth++;
    resyncPromise = run();
    try {
      await resyncPromise;
    } finally {
      resyncDepth = Math.max(0, resyncDepth - 1);
      resyncPromise = null;
      if (resyncAbort === abort) {
        resyncAbort = null;
      }
    }
  }

  function currentLiveConfig(): RuntimeConfig {
    return {
      ...config,
      scopes: [...activeScopes],
      getToken: config.getToken
    };
  }

  async function handleLeaderRpc(call: LeaderRpcCall): Promise<any> {
    switch (call.type) {
      case 'Ping':
        return 'Pong';
      case 'FetchRecords':
        return await fetchRecordsForScopes(call.scopes);
      case 'FetchRecordsByDateRange': {
        // Build inline scope filter exactly as wisewords does, using record-typed IDs.
        // When no scopes are provided, omit the group filter and return all date records.
        // Scope IDs are inlined directly in the SQL (not via LET $scopes) because
        // buildSurrealStatement uses JSON.stringify which wraps record IDs in quotes,
        // turning them into strings instead of record references.
        const scope_list = call.scopes
          .map(s => s.startsWith('records:') ? s : `records:${s}`);
        const scopeFilter = scope_list.length > 0
          ? `AND fn::items_have_group([$this], <array<record>>$scopes, [])`
          : '';
        const excluded_tree_scope_list = (call.excludedTreeScopes ?? [])
          .filter(Boolean)
          .map(s => s.startsWith('records:') ? s : `records:${s}`);
        const excludedTreePreamble = excluded_tree_scope_list.length > 0
          ? `LET $excludedTreeRoots = array::union(
              <array<record>>$excludedTreeScopes,
              (SELECT VALUE out FROM groups WHERE in INSIDE <array<record>>$excludedTreeScopes)
            );`
          : '';
        const excludedTreeFilter = excluded_tree_scope_list.length > 0
          ? `AND array::len(array::intersect(
              array::union(
                [id],
                array::flatten(id.{..+path+inclusive}(->graph_child_of[WHERE key_parent = true]->records.id))
              ),
              $excludedTreeRoots
            )) = 0`
          : '';

        // Global ScopeFilter (tree-descendant) is independent of the
        // group-membership `scopes` field and ANDs in alongside it.
        const globalScope = call.scopeFragment;
        const globalScopePreamble = globalScope && globalScope.preamble.length > 0
          ? globalScope.preamble.join('\n') + '\n'
          : '';
        const globalScopeWhere = globalScope && globalScope.whereExpr
          ? `AND ${globalScope.whereExpr}`
          : '';

        // Mirrors wisewords calendar_module/src/api.rs get_records_by_date_range exactly.
        // time/etime are always none (no time-of-day precision needed here) —
        // hardcoded in SQL so WS RPC doesn't send JSON null (which SurrealDB
        // may interpret as NULL rather than NONE).
        const sql = `
          ${globalScopePreamble}
          ${excludedTreePreamble}
          SELECT *,
            -- Enrich permissions with public display info (username + icon),
            -- mirroring fn::group_for_fetch. Without this the calendar's
            -- permission pills only have the raw { u, r } shape and fall back to
            -- showing the user record id with no avatar.
            (IF $this.permissions != none {
              $this.permissions.map(|$p| {
                u: $p.u,
                r: $p.r,
                username: (SELECT VALUE name FROM user_public WHERE user_id = $p.u LIMIT 1)[0],
                user_icon_small: (SELECT VALUE user_icon_small FROM user_public WHERE user_id = $p.u LIMIT 1)[0]
              })
            } ELSE { none }) AS permissions,
            (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping,
            (SELECT *, (SELECT VALUE fn::object_with_field(fn::object_with_field(in.*, "is_template_container", is_template_container), "grouping", (SELECT VALUE fn::object_with_field(in.*, "is_template_container", is_template_container) FROM in<-groups)) FROM <-groups) AS grouping FROM array::concat(
              (SELECT * FROM <-appliesto<-records).filter(|$v| $v != none),
              (SELECT * FROM ->appliesto->records)
              )) AS connections
          FROM records
          WHERE type::is_array(additionals)
          AND additionals[WHERE type = 'date' AND date_info != none
          ${call.only_status ? 'AND date_info.is = true' : ''}
          AND fn::date_range(date_info.value, $year, $month, $day, none, $eyear, $emonth, $eday, none)]
          ${scopeFilter}
          ${excludedTreeFilter}
          ${globalScopeWhere};
        `;

        const q = await executeQuery(sql, {
          scopes: scope_list.length > 0 ? scope_list : undefined,
          excludedTreeScopes: excluded_tree_scope_list.length > 0 ? excluded_tree_scope_list : undefined,
          year: call.year, month: call.month, day: call.day,
          eyear: call.eyear, emonth: call.emonth, eday: call.eday,
          ...(globalScope?.vars ?? {})
        });

        // WebSocket queries return plain row arrays.
        // HTTP /sql with LET bindings returns [{result:null}, ..., {result:[...rows...]}].
        // Support both shapes.
        const cores = extractQueryRows(q);
        return cores;
      }
      case 'FetchEdgesByScopes':
        return await fetchGroupingEdgesForScopes(call.scopes);
      case 'FetchAppliesByScopes':
        return await fetchAppliesEdgesForScopes(call.scopes);
      case 'FetchChildren': {
        // graph_child_of: in=child, out=parent — fetch where out (parent) matches
        const rows = await executeQuery('SELECT * FROM graph_child_of WHERE out = <record>$parentId', { parentId: call.parentId });
        return extractQueryRows(rows);
      }
      case 'FetchRecordGraph':
        return await fetchRecordGraph(call);
      case 'FetchRecordGraphs':
        return await fetchRecordGraphs(call);
      case 'FetchVwtData':
        return await fetchVwtData(call);
      case 'FetchPlanningTemplatesRoot':
        return await fetchPlanningTemplatesRoot();
      case 'FetchTemplateClones': {
        const tid = call.templateId.startsWith('records:') ? call.templateId : `records:${call.templateId}`;
        const limit = call.limit ?? 100;
        const offset = call.offset ?? 0;
        
        // Mirrors the original wisewords fn::find_template_clones: exec
        // quick-add clones a template's CHILDREN (not the container root), so
        // a clone root is any record whose copied_from_record is the template
        // root OR one of its direct graph_child_of children. Keyed ONLY on
        // copied_from_record (precise per-node provenance) — NOT the tree-wide
        // original_template_id / planner_instance.template_root_id, which the
        // client path stamps on every descendant and which caused unrelated
        // nested descendants to surface as false clone roots.
        const sql = `
          LET $root = type::record($tid);
          LET $sources = array::concat([$root], (SELECT VALUE id FROM $root<-graph_child_of<-records));
          SELECT * FROM records
          WHERE copied_from_record INSIDE $sources
          ORDER BY updated DESC
          LIMIT $limit START $offset;
        `;
        const rows = await executeQuery(sql, { tid, limit, offset });
        return extractQueryRows(rows);
      }
      case 'CloneTemplateChildren': {
        const rid = call.rootId.startsWith('records:') ? call.rootId : `records:${call.rootId}`;
        // Inline a sanitized ISO datetime literal: SurrealQL needs d'...' for a
        // datetime, and JSON vars would arrive as plain strings (not coerced to
        // datetime by fn::clone_from_source_array's option<datetime> param).
        let anchorExpr = 'NONE';
        if (call.anchor && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(call.anchor)) {
          anchorExpr = `d'${call.anchor}'`;
        }
        // Whitelisted clone-mode override (NONE = honour each edge's stored
        // clone_setting, the normal template-apply behaviour).
        const overrideExpr =
          call.cloneSettingOverride === 'default' ||
          call.cloneSettingOverride === 'link_to_common_clone' ||
          call.cloneSettingOverride === 'link_to_original'
            ? `'${call.cloneSettingOverride}'`
            : 'NONE';
        const vars: Record<string, unknown> = { rid };
        let scopeJoin = '';
        if (call.targetScopeId) {
          vars.scopeRid = call.targetScopeId.startsWith('records:')
            ? call.targetScopeId
            : `records:${call.targetScopeId}`;
          // Templates live in a separate library root, so the source groupings
          // recreated by fn::group_for_clone won't include the user's exec
          // scope. Join each top-level clone to it, preserving structural
          // planner metadata from the source root edge (e.g. Section).
          scopeJoin = `
            LET $scope = type::record($scopeRid);
            LET $source_group_edges = (SELECT in, module_data FROM graph_child_of WHERE out = $root AND in INSIDE $sources);
            LET $source_group_module_data = object::from_entries($source_group_edges.map(|$edge| [<string>$edge.in, $edge.module_data]));
            IF $scope != NONE AND array::len($new) > 0 {
              FOR $row IN $new_rows {
                LET $source_module_data = $source_group_module_data[<string>$row.copied_from_record];
                RELATE $scope->groups->($row.new_id) SET created = time::now(), updated = time::now(), module_data = $source_module_data;
              };
            };`;
        }
        // Default (template-apply): clone the container root's key-parent
        // children, NOT the root itself. With includeRoot the root and its
        // whole subtree are cloned instead (the /records "include top
        // parent" toggle). cloneSettingOverride forces every edge into one
        // clone mode for the whole operation.
        const sourcesExpr = call.includeRoot
          ? `[$root]`
          : `(SELECT VALUE id FROM $root<-graph_child_of<-records)`;
        const sql = `
          LET $root = type::record($rid);
          LET $sources = ${sourcesExpr};
          LET $new_rows = IF array::len($sources) > 0 {
            fn::clone_from_source_array($sources, ${anchorExpr}, ${overrideExpr})
          } ELSE { [] };
          LET $new = (SELECT VALUE new_id FROM $new_rows);
          ${scopeJoin}
          RETURN $new;
        `;
        const rows = await executeQuery(sql, vars);
        return extractQueryRows(rows);
      }
    }
  }

  // Default RPC timeouts tuned per call type so a slow bulk fetch doesn't
  // share a budget with a tiny ping. Callers can still override explicitly.
  function defaultTimeoutForCall(call: LeaderRpcCall): number {
    switch (call.type) {
      case 'Ping': return 2_000;
      case 'FetchChildren':
      case 'FetchPlanningTemplatesRoot':
        return 10_000;
      case 'FetchRecordGraph':
      case 'FetchRecordGraphs':
      case 'FetchVwtData':
      case 'FetchRecords':
      case 'FetchRecordsByDateRange':
      case 'FetchEdgesByScopes':
      case 'FetchAppliesByScopes':
      case 'FetchTemplateClones':
      case 'CloneTemplateChildren':
        return 30_000;
      default:
        return 15_000;
    }
  }

  async function fetchAndCache(call: LeaderRpcCall, timeoutMs?: number): Promise<any[]> {
    const effectiveTimeout = timeoutMs ?? defaultTimeoutForCall(call);
    // Track this read as in-flight so UI loading indicators (top progress strip,
    // per-connection spinners) can react to fetch activity and color it distinctly
    // from sync (write) ops. Keyed by the runtime's isolationKey (one bucket per
    // profile/connection). Settled in the finally below regardless of outcome.
    const fetchId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    startFetch(config.isolationKey, { id: fetchId, type: String(call.type), startedAt: Date.now() });
    try {
      // Rather than routing reads through the bus where they can drop during election,
      // we can just resolve them directly in the current tab via our executeQuery fallback
      const result = await Promise.race([
        handleLeaderRpc(call),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`fetchAndCache timeout after ${effectiveTimeout}ms for ${call.type}`)), effectiveTimeout)
        )
      ]);

      if (call.type === 'FetchRecords' || call.type === 'FetchRecordsByDateRange' || call.type === 'FetchTemplateClones') {
        let cores = result || [];
        cores = cores
          .map((core: any) => normalizeRecordRow(core))
          .filter((core: any) => core && typeof core.id === 'string');
        if (cores.length > 0) {
          engine.applyRemote({ type: 'RecordBatchUpsert', cores });
        }
        return cores;
      }

      if (call.type === 'FetchEdgesByScopes') {
        const rows = Array.isArray(result) ? result : [];
        applyGroupingEdgeSnapshot(rows);
        return rows;
      }

      if (call.type === 'FetchAppliesByScopes') {
        const rows = Array.isArray(result) ? result : [];
        applyAppliesEdgeSnapshot(rows);
        return rows;
      }

      if (call.type === 'FetchRecordGraph' || call.type === 'FetchRecordGraphs' || call.type === 'FetchVwtData') {
        const roots = Array.isArray(result?.roots)
          ? result.roots.map((entry: any) => normalizeRecordRow(entry)).filter((entry: any) => entry && typeof entry.id === 'string')
          : [normalizeRecordRow(result?.root ?? null)].filter((entry: any) => entry && typeof entry.id === 'string');
        const parents = Array.isArray(result?.parents)
          ? result.parents.map((entry: any) => normalizeRecordRow(entry)).filter((entry: any) => entry && typeof entry.id === 'string')
          : [];
        const childRecords = Array.isArray(result?.childRecords)
          ? result.childRecords.map((entry: any) => normalizeRecordRow(entry)).filter((entry: any) => entry && typeof entry.id === 'string')
          : [];
        const childEdges = Array.isArray(result?.childEdges)
          ? result.childEdges.map((entry: any) => normalizeGraphEdgeRow(entry)).filter((entry: any) => entry && typeof entry.id === 'string')
          : [];
        const records = [...roots, ...parents, ...childRecords].filter((entry: any) => entry && typeof entry.id === 'string');
        if (records.length > 0) {
          engine.applyRemote({ type: 'RecordBatchUpsert', cores: records });
        }
        // Cache child edges — graph_child_of: in=child, out=parent
        if (childEdges.length > 0) {
          const edges = childEdges
            .map((e: any) => {
              const edgeId = typeof e.id === 'string' ? e.id : '';
              const isGroupingEdge = edgeId.startsWith('groups:');
              return {
                edge_id: edgeId,
                child_id: isGroupingEdge ? e.out : e.in,
                parent_id: isGroupingEdge ? e.in : e.out,
                order: typeof e.order === 'number' ? e.order : 0,
                is_key_parent: isGroupingEdge
                  ? false
                  : typeof e.key_parent === 'boolean'
                    ? e.key_parent
                    : true,
                module_data: typeof e.module_data === 'object' ? e.module_data : undefined,
                clone_setting: isGroupingEdge ? null : (e.clone_setting ?? null)
              };
            })
            .filter((e: any) => e.edge_id);
          if (edges.length > 0) {
            engine.applyRemote({ type: 'GraphChildBatchUpsert', edges });
          }
        }
        return records;
      }

      if (call.type === 'FetchPlanningTemplatesRoot') {
        if (result && typeof result.id === 'string') {
          engine.applyRemote({ type: 'RecordUpsert', core: result });
          return [result];
        }
        return [];
      }

      return result || [];
    } catch (e) {
      logger.warn(`Failed fetchAndCache for ${call.type}`, e);
      throw e;
    } finally {
      endFetch(config.isolationKey, fetchId);
    }
  }

  function createLeaderLiveConnection(sessionId: number | null) {
    return createSurrealLiveConnection(currentLiveConfig(), (msg) => {
      if (sessionId && leaderElection.leaderSessionId !== sessionId) return;
      emitSyncTrace(`runtime:${config.isolationKey}`, 'live-mutation', {
        type: msg.type,
        sessionId: leaderElection.leaderSessionId,
        tabId: leaderElection.tabId
      });
      liveBus.broadcast(msg);
      engine.applyRemote(msg);
    }, {
      logLevel,
      onCursorAdvance: onChangefeedCursorAdvance,
      onReady: () => {
        if (sessionId && leaderElection.leaderSessionId !== sessionId) return;
        // Precise changefeed gap recovery (cursor replay), replacing the
        // blunt full resync. Cold start still does one full resync inside.
        void runChangefeedCatchup('leader');
        void probeRecordsTablePermissions();
      },
      onDisconnect: (reason) => {
        if (sessionId && leaderElection.leaderSessionId !== sessionId) return;
        if (reason === 'unexpected') {
          void markLiveCatchupRequired(true);
        }
      }
    });
  }

  function restartLeaderLiveConnection(reason: string) {
    if (destroyed || !leaderElection.isLeader) return;
    const now = Date.now();
    if (now - lastLeaderLiveRestartAt < LEADER_LIVE_RESTART_MIN_MS) return;
    lastLeaderLiveRestartAt = now;
    const sessionId = leaderElection.leaderSessionId;
    liveConn?.disconnect();
    liveConn = createLeaderLiveConnection(sessionId);
    liveConn.connect();
    // Recovery is driven by runChangefeedCatchup() in onReady (precise cursor
    // replay), not a blunt full resync here. liveCatchupRequired stays set so
    // catch-up runs even if the cursor looked current.
    void markLiveCatchupRequired(true);
    logger.info(`restarted leader live connection: ${reason}`);
  }

  async function runFollowerBusProbe(source: string) {
    if (destroyed || leaderElection.isLeader) return;
    emitSyncTrace(`runtime:${config.isolationKey}`, 'bus-probe-start', {
      source,
      tabId: leaderElection.tabId
    });
    logger.info(`running follower bus probe source=${source}`);
    try {
      const result = await liveBus.rpc<string>({ type: 'Ping' }, {
        timeoutMs: 2000,
        leaderSessionId: leaderElection.leaderSessionId
      });
      logger.info(`follower bus probe ok source=${source} result=${result}`);
      emitSyncTrace(`runtime:${config.isolationKey}`, 'bus-probe-ok', {
        source,
        result,
        tabId: leaderElection.tabId
      });
    } catch (error) {
      logger.warn(`follower bus probe failed source=${source}`, error);
      emitSyncTrace(`runtime:${config.isolationKey}`, 'bus-probe-failed', {
        source,
        error: error instanceof Error ? error.message : String(error),
        tabId: leaderElection.tabId
      });
    }
  }

  async function start() {
    liveCatchupRequired = Boolean(await getRuntimeState<boolean>(config.isolationKey, LIVE_CATCHUP_REQUIRED_KEY));

    // 1. Hydrate the cache offline snapshot physically partitioned by isolationKey
    await hydrateCache(cache, config.isolationKey);
    logger.debug('hydrated offline cache snapshot');
    
    // 2. Bind Svelte memory mutations -> IndexedDB
    cachePersistUnsub = createCachePersistence(cache, config.isolationKey);
    logger.debug('attached cache persistence listener');
    
    // 3. Reactively orchestrate Sync Push and Live WebSocket via Election
    leaderUnsub = leaderElection.onChange(() => {
      if (destroyed) return;
      const sessionId = leaderElection.leaderSessionId;
      logger.info(`leader election changed: isLeader=${leaderElection.isLeader} session=${sessionId}`);
      emitSyncTrace(`runtime:${config.isolationKey}`, 'leader-election', {
        isLeader: leaderElection.isLeader,
        sessionId,
        tabId: leaderElection.tabId
      });

      // Any leader transition invalidates RPCs targeting the previous leader.
      // Fail them fast so callers retry against the new leader instead of
      // waiting out the per-call timeout (15s by default).
      liveBus.rejectPendingRpcs?.('Leader changed; retry required', {
        onlyOlderThanSession: sessionId
      });

      if (leaderElection.isLeader) {
        if (liveConn) {
          liveConn.disconnect();
          liveConn = null;
        }

        // We just became leader: immediately attempt to flush any local queued ops from when we were a follower
        void engine.pushOps();

        liveConn = createLeaderLiveConnection(sessionId);
        liveConn.connect();
        syncLoopStop = engine.startSyncLoop();
        logger.info('started leader live connection and sync loop');
      } else {
        liveConn?.disconnect();
        liveConn = null;
        if (syncLoopStop) {
          syncLoopStop();
          syncLoopStop = null;
        }
        logger.info('stopped leader-only runtime resources');
      }
    });

    // Followers (and Leaders) need to listen to the cross-tab bus for SyncWake and RPCs
    busUnsub = liveBus.onMessage(async (msg, senderId) => {
      logger.debug(`received bus message type=${msg.type} sender=${senderId}`);
      emitSyncTrace(`runtime:${config.isolationKey}`, 'bus-message', {
        type: msg.type,
        senderId,
        isLeader: leaderElection.isLeader,
        tabId: leaderElection.tabId
      });
      if (msg.type === 'SyncWake' && leaderElection.isLeader) {
        void engine.pushOps();
      } else if (msg.type === 'RequestLeadership') {
        // A foreground follower wants leadership. Only a BACKGROUNDED leader
        // yields (a visible leader keeps it; the requester self-pushes its own
        // writes meanwhile). This stops a throttled background tab from
        // starving the active tab's syncs.
        if (
          leaderElection.isLeader &&
          typeof document !== 'undefined' &&
          document.visibilityState !== 'visible'
        ) {
          logger.info('yielding leadership to a foreground tab on request');
          leaderElection.yieldLeadership();
        }
      } else if (msg.type === 'RpcRequest' && leaderElection.isLeader && liveConn) {
        try {
          const result = await handleLeaderRpc(msg.call);
          liveBus.broadcast({ type: 'RpcResponse', requestId: msg.requestId, ok: true, payload: result });
        } catch (err: any) {
          logger.warn(`leader RPC failed for ${msg.call.type}`, err);
          liveBus.broadcast({ type: 'RpcResponse', requestId: msg.requestId, ok: false, payload: err.message });
        }
      }
    });

    // 4. Tab Visibility Catch-up for Followers
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleWindowFocus);
    }

    // Ensure we trigger explicitly if we naturally launched as a Leader initially
    if (leaderElection.isLeader) {
      // If onChange has not been called yet and we're already leader, trigger setup
      if (!liveConn) {
        liveConn = createLeaderLiveConnection(leaderElection.leaderSessionId);
        liveConn.connect();
        syncLoopStop = engine.startSyncLoop();
        logger.info('booted as leader; started live connection immediately');
      }
    } else {
      void resyncActiveScopes('follower', false);
      void runFollowerBusProbe('startup');
    }
  }

  /**
   * Self-heal probe — runs once per `start()` after the leader's live
   * connection comes up. Detects the specific failure mode where the
   * `records` table has `PERMISSIONS NONE` but the edge tables (which
   * reference records) are still open, which silently hides every row from
   * a RECORD-auth session. The most common trigger is a fresh DB whose
   * runtime modules were never applied, or applied without
   * `permissions_cache_definitions`.
   *
   * Why this signal: under the user JWT, `INFO FOR TABLE records` raises
   * an IAM error so we can't introspect schema directly. But edges in
   * `graph_child_of` reference record ids — if we see edges yet zero
   * records visible to the user, the records table is almost certainly
   * locked. (A genuinely empty database has zero of both.)
   *
   * Failures are swallowed (no notice fired) so a transient network blip
   * doesn't produce a misleading banner.
   */
  let schemaProbeRan = false;
  async function probeRecordsTablePermissions() {
    if (schemaProbeRan) return;
    schemaProbeRan = true;
    if (!config.onSchemaIssue) return;
    try {
      // One round trip, two cheap aggregates.
      const result = await executeQuery(
        'SELECT count() AS n FROM records GROUP ALL; ' +
        'SELECT count() AS n FROM graph_child_of GROUP ALL;'
      );
      const rows = Array.isArray(result) ? result : [];
      const recordsCount = extractCount(rows[0]);
      const edgesCount = extractCount(rows[1]);

      // Edges visible but records invisible → records table is locked.
      // Tolerate small race windows by requiring a meaningful asymmetry.
      const looksLocked = recordsCount === 0 && edgesCount > 0;
      if (looksLocked) {
        const message = 'Database is missing record access policies — every signed-in user will see an empty list.';
        const detail = 'Re-apply runtime modules: bash scripts/apply-surql.sh --namespace db --database db';
        logger.error(`schema probe: ${message}`);
        // eslint-disable-next-line no-console
        console.error(`[modular-app] ${message}\n${detail}`);
        config.onSchemaIssue({
          code: 'records_no_select_permission',
          message,
          detail
        });
      }
    } catch (e) {
      // Probe is best-effort. Don't block sync on probe failures.
      logger.debug(`schema probe skipped: ${(e as Error).message}`);
    }
  }

  function extractCount(row: unknown): number {
    if (!row || typeof row !== 'object') return 0;
    const r = row as { result?: unknown; status?: string };
    const data = r.status && r.result !== undefined ? r.result : row;
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as { n?: number; count?: number } | number;
      if (typeof first === 'number') return first;
      if (first && typeof first === 'object') {
        return Number((first.n ?? first.count) ?? 0);
      }
    }
    return 0;
  }

  // The active (visible) tab must not depend on a possibly-throttled background
  // leader to flush its writes. Push our own queued ops directly and ask the
  // current leader to hand leadership over so subsequent ops take the
  // direct-push path in queueAndWake.
  function followerActivate() {
    if (destroyed || leaderElection.isLeader) return;
    void engine.pushOps();
    liveBus.broadcast({ type: 'RequestLeadership' });
  }

  function handleVisibilityChange() {
    if (destroyed) return;
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (leaderElection.isLeader) {
      restartLeaderLiveConnection('visibilitychange');
      // A single mobile tab IS the leader, and mobile background throttling
      // freezes the sync-loop timer — so ops queued/backing-off while hidden
      // sit until that throttled timer finally fires. Flush explicitly on
      // return to foreground (followers already do, via followerActivate).
      void engine.pushOps();
    } else {
      void resyncActiveScopes('follower', false);
      followerActivate();
    }
  }

  function handleWindowFocus() {
    if (destroyed) return;
    if (leaderElection.isLeader) {
      restartLeaderLiveConnection('window-focus');
      // See handleVisibilityChange — the leader must self-flush on foreground.
      void engine.pushOps();
    } else {
      followerActivate();
    }
  }

  function destroy() {
    destroyed = true;

    // Abort any in-flight resync before clearing the cache
    if (resyncAbort) {
      resyncAbort.abort();
      resyncAbort = null;
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', handleWindowFocus);
    }
    if (cachePersistUnsub) cachePersistUnsub();
    if (leaderUnsub) leaderUnsub();
    if (busUnsub) busUnsub();
    if (syncLoopStop) syncLoopStop();

    liveConn?.disconnect();
    liveConn = null;
    if (ownsLeader) {
      leaderElection.destroy();
    }
    liveBus.destroy();
    cache.clear();
  }

  /**
   * WARM transition. Delegates to the leader-transition orchestrator: releasing
   * the lock fires the `onChange` follower-branch (defined in `start()`), which
   * disconnects the live connection and stops the sync loop. The orchestrator
   * is the single source of truth for live/loop lifecycle, so pause/resume avoid
   * duplicating that logic (and avoid racy `isLeader` checks after async lock
   * acquisition). Cache, persistence, bus, and listeners are untouched.
   *
   * When the runtime owns its leader election (per-isolationKey, the default),
   * `release()` aborts the lock permanently and stays out — another tab may
   * lead this DB. When leadership is injected/shared, `release()` affects the
   * shared instance; the host is responsible for not pausing a shared leader.
   */
  function pause() {
    if (destroyed) return;
    leaderElection.release();
  }

  /**
   * LIVE transition. Re-arms leadership acquisition; the `onChange` leader-branch
   * (in `start()`) recreates the live connection, restarts the sync loop, and
   * runs changefeed catch-up when the lock is (re)won. Mirrors
   * `restartLeaderLiveConnection`: `markLiveCatchupRequired(true)` forces gap
   * replay even if the persisted cursor looked current. `followerActivate()`
   * is a no-op once we're leader (single-tab, immediate); if we queued behind
   * another tab it broadcasts `RequestLeadership` to nudge a backgrounded
   * leader to yield to this foreground tab.
   */
  function resume() {
    if (destroyed) return;
    void markLiveCatchupRequired(true);
    leaderElection.resumeAcquire();
    followerActivate();
  }

  function queueAndWake(kind: OpKind, payload: unknown) {
    // Enqueue an op transaction
    engine.queueOp(kind, payload);
    emitSyncTrace(`runtime:${config.isolationKey}`, 'queue-op', {
      kind,
      isLeader: leaderElection.isLeader,
      tabId: leaderElection.tabId
    });

    // Broadcast optimistic record patches immediately so sibling tabs update
    // without waiting for backend acceptance.
    for (const msg of deriveOptimisticLiveMessages(kind, payload)) {
      emitSyncTrace(`runtime:${config.isolationKey}`, 'broadcast-optimistic', {
        kind,
        type: msg.type,
        tabId: leaderElection.tabId
      });
      liveBus.broadcast(msg);
    }
    
    // Push directly if we're the leader, or if we're the visible/active tab —
    // a foreground follower must not wait on a possibly-throttled background
    // leader to flush this write. We deliberately do NOT also SyncWake the
    // leader in that case, so the same op isn't pushed by two tabs at once
    // (some ops, e.g. RELATE-based grouping edges, aren't idempotent on a
    // double-send). A hidden follower defers to the leader as before.
    const tabIsVisible =
      typeof document === 'undefined' || document.visibilityState === 'visible';
    if (leaderElection.isLeader || tabIsVisible) {
      void engine.pushOps();
    } else {
      liveBus.broadcast({ type: 'SyncWake' });
      logger.debug(`broadcast SyncWake for ${kind}`);
    }
  }

  function updateScopes(scopes: string[]) {
    // Abort any in-flight resync that captured the old scope set
    if (resyncAbort) {
      resyncAbort.abort();
    }

    activeScopes = normalizeScopes(scopes);
    if (liveConn && leaderElection.isLeader) {
      void liveConn.updateScopes(activeScopes);
    }
    void resyncActiveScopes(leaderElection.isLeader ? 'leader' : 'follower');
  }

  return {
    cache,
    liveBus,
    engine,
    leaderElection,
    isolationKey: config.isolationKey,
    start,
    destroy,
    pause,
    resume,
    queueAndWake,
    cancelOp: (opId: string) => engine.cancelOp(opId),
    updateScopes,
    getActiveScopes: () => [...activeScopes],
    fetchAndCache,
    // True while a namespace-scope resync (coarse `SELECT * FROM records`
    // snapshot + edge catch-up) is in flight. Subscribers use this to skip
    // corrective slice mutations on the coarse upserts (cold edge cache).
    isResyncing: () => resyncDepth > 0,
    // Persisted pending + inflight ops for this namespace (M4 data-loss guard).
    // Reads IDB directly so it's correct even when the engine isn't running.
    getPendingOps: () => loadPendingOps(config.isolationKey)
  };
}
