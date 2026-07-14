import type { LiveBusMsg } from './live.ts';
import type { LogLevel } from './logger.ts';
import { createLogger } from './logger.ts';
import { emitSyncTrace } from './trace.ts';
import { parseSelectResult } from './changefeed-convert.ts';
import { createChangefeedDispatcher } from './changefeed-dispatch.ts';

/**
 * ============================================================================
 * LIVE SYNC ARCHITECTURE — READ BEFORE CHANGING THIS FILE
 * ============================================================================
 *
 * This client subscribes to the server **changefeed** — a SINGLE
 * `LIVE SELECT ... FROM changes` — and NOTHING ELSE.
 *
 * DO NOT add `LIVE SELECT * FROM records` (or graph_child_of / groups /
 * appliesto, or any other base table). That is the regression this
 * architecture exists to prevent. Raw base-table live queries fire once per
 * row mutation and ignore `skip_changefeed`/`skip_cache_event`, so a single
 * server-side batch clone (which writes N records + N edges + 2 suppression
 * sweeps per row) floods the client with thousands of per-row events. The
 * `changes` table instead delivers ONE consolidated `BATCH_CLONE` entry for
 * the whole operation. This mirrors the proven legacy wisewords design.
 *
 * How it works:
 *  - The server logs every meaningful mutation into the immutable `changes`
 *    table via DEFINE EVENTs (gated by `skip_changefeed`), and consolidated
 *    `BATCH_CLONE` / `BATCH_SYNC_PUSH` entries via `fn::log_batch_*`.
 *  - Each `changes` row carries `action`, `table_name`, `record_id`,
 *    `cursor_id`, optional `batch_*_ids`, and `payload {before, after}`.
 *  - Apply path: if `payload.after` is present we apply it directly (source of
 *    truth — zero follow-up queries, so a wave of subscribers does not trigger
 *    a query storm). If it is absent — because the server deliberately omitted
 *    it for a change that needs a fresh read, or because the TTL job stripped
 *    payloads off old rows — we fall back to re-fetching by id. Batch entries
 *    without an embedded payload re-fetch by `batch_*_ids`.
 *  - Self-echoes are NOT suppressed client-side. Like legacy, the client
 *    re-applies its own writes idempotently (cache ops are upserts). The old
 *    `_sync_op_id` / `isSelfSyncOp` / `ownSyncOpIds` machinery has been
 *    removed; server-side `skip_changefeed` + `sync_ops` handle dedupe.
 *  - Reconnect/offline gaps are recovered by `fn::sync_pull($since)` cursor
 *    replay in runtime.ts, driven by the `onCursorAdvance` callback below —
 *    not by a full resync.
 * ============================================================================
 */
export interface SurrealDbLiveConfig {
  url: string;
  namespace: string;
  database: string;
  token: string;
  scopes: string[];
  /** Lazy token provider. When set, takes precedence over the static `token` field. */
  getToken?: () => Promise<string>;
}

async function resolveToken(config: SurrealDbLiveConfig): Promise<string> {
  if (config.getToken) return config.getToken();
  return config.token;
}

interface SurrealLiveMessage {
  id?: number;
  method?: string;
  params?: unknown[];
  result?: unknown;
  error?: { code: number; message: string };
}

function isManualDisconnectError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Connection disconnected manually';
}

function normalizeScopeValue(scopeValue: unknown): string | null {
  if (typeof scopeValue !== 'string' || scopeValue.length === 0) {
    return null;
  }

  return scopeValue.replace(/^records:/, '');
}

function normalizeScopes(scopes: string[]): string[] {
  const normalized = new Set<string>();
  for (const scope of scopes) {
    const value = normalizeScopeValue(scope);
    if (value) {
      normalized.add(value);
    }
  }

  return [...normalized];
}

function buildScopeVariants(scope: string): string[] {
  return [scope, `records:${scope}`];
}

export function createSurrealLiveConnection(
  config: SurrealDbLiveConfig,
  onMessage: (msg: LiveBusMsg) => void,
  options?: {
    logLevel?: LogLevel;
    onReady?: () => void;
    onDisconnect?: (reason: 'unexpected' | 'manual') => void;
    /**
     * Called with the `cursor_id` of every changefeed entry as it is applied
     * from the LIVE stream, in arrival order. The runtime persists this so a
     * later reconnect can replay only the gap via `fn::sync_pull($since)`
     * instead of doing a blunt full-scope resync. See the LIVE SYNC
     * ARCHITECTURE note at the top of this file.
     */
    onCursorAdvance?: (cursorId: string) => void;
  }
) {
  const logger = createLogger(`live:${config.namespace}:${config.database}`, options?.logLevel ?? 'info');
  let ws: WebSocket | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  
  // RPC state
  let rpcNextId = 1;
  const pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  
  // Scopes and Subscriptions
  const activeQueries = new Map<string, string[]>(); // scope -> array of live_ids
  let currentScopes = new Set(normalizeScopes(config.scopes));
  // Serializes changefeed dispatch so an id-refetch fallback never reorders
  // applies relative to later changefeed entries.
  let dispatchChain: Promise<void> = Promise.resolve();
  
  // Lifecycle
  let destroyed = false;
  let reconnectAttempts = 0;
  let authenticated = false;
  let handshakeFailed = false;
  const MAX_RECONNECT_DELAY = 30000;
  let readyResolvers: Array<() => void> = [];
  let readyRejectors: Array<(reason?: unknown) => void> = [];

  function handlePageUnload() {
    disconnect();
  }

  // Reconnect the instant the browser reports connectivity, instead of
  // waiting out whatever exponential-backoff delay was in flight when we
  // went offline (up to MAX_RECONNECT_DELAY = 30s + jitter). A no-op if
  // already connected/connecting (`ws` is set as soon as `connect()` opens
  // the socket, before the handshake completes) — this only short-circuits a
  // pending *scheduled* retry.
  function handleOnline() {
    if (destroyed || ws) return;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    reconnectAttempts = 0;
    connect();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handlePageUnload);
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('online', handleOnline);
  }

  function resolveReady() {
    const resolvers = readyResolvers;
    readyResolvers = [];
    readyRejectors = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  function rejectReady(error: unknown) {
    const rejectors = readyRejectors;
    readyResolvers = [];
    readyRejectors = [];
    for (const reject of rejectors) {
      reject(error);
    }
  }

  function getReconnectDelay(): number {
    const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    return baseDelay + Math.random() * 500;
  }

  function sendRpc(method: string, params: unknown[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not open'));
      }
      const id = rpcNextId++;
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function connect() {
    if (destroyed) return;
    if (ws) return; // Prevent overlapping connections

    const wsUrl = config.url.replace(/^http/, 'ws');
    // Declare the wire format explicitly via the WebSocket subprotocol. This
    // client encodes/decodes JSON (ws.send(JSON.stringify) + JSON.parse), so
    // negotiate 'json'. Without it SurrealDB 2.0 auto-infers the format and
    // logs a deprecation warning (removed in SurrealDB 3.0).
    ws = new WebSocket(`${wsUrl}/rpc`, 'json');
    authenticated = false;

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      handshakeFailed = false;
      logger.info('websocket opened; negotiating connection');
      emitSyncTrace(`surreal-live:${config.namespace}:${config.database}`, 'socket-open', {
        scopes: [...currentScopes]
      });
      negotiateConnection().catch((e) => {
        if (destroyed || isManualDisconnectError(e)) {
          logger.debug('live connection negotiation cancelled during manual teardown');
          return;
        }
        logger.error('SurrealDB handshake protocol failed', e);
        handshakeFailed = true;
        authenticated = false;
        rejectReady(e);
        ws?.close();
      });
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg: SurrealLiveMessage = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        logger.error('Failed to parse SurrealDB WebSocket frame', e);
      }
    });

    ws.addEventListener('close', () => {
      authenticated = false;
      activeQueries.clear();
      
      // Drain unresolved RPCs
      for (const { reject } of pendingRequests.values()) {
        reject(new Error('WebSocket closed externally'));
      }
      pendingRequests.clear();
      rejectReady(new Error('WebSocket closed externally'));
      ws = null;

      if (!destroyed) {
        options?.onDisconnect?.('unexpected');
        logger.warn(`websocket closed; scheduling reconnect attempt=${reconnectAttempts + 1}`);
        scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      ws?.close(); // Will trigger connection closure sequence
    });
  }

  async function negotiateConnection() {
    // 1. Authenticate Token
    const token = await resolveToken(config);
    await sendRpc('authenticate', [token]);

    // 2. Select Namespace & Database
    await sendRpc('use', [config.namespace, config.database]);
    
    authenticated = true;

    // 3. Initiate Live Subscriptions (unscoped — namespace isolation via `use`)
    await subscribeLiveQueries();

    resolveReady();
    options?.onReady?.();
    logger.info(`authenticated live connection for namespace=${config.namespace} database=${config.database}`);
    emitSyncTrace(`surreal-live:${config.namespace}:${config.database}`, 'socket-ready', {
      scopes: [...currentScopes]
    });
  }

  async function subscribeLiveQueries() {
    if (!authenticated || destroyed || handshakeFailed) return;
    if (activeQueries.size > 0) return; // Already subscribed
    try {
      const liveIds: string[] = [];
      // ONE subscription: the server changefeed. NEVER add a raw
      // `LIVE SELECT * FROM <base table>` here — see the LIVE SYNC
      // ARCHITECTURE note at the top of this file. Namespace isolation is
      // handled by the `use` RPC during handshake. Unlike legacy (which
      // omitted `payload` and always re-fetched), we DO select `payload`:
      // payload.after is our source of truth and avoids a follow-up query
      // per subscriber for the common single-row case.
      const result = await sendRpc('query', [
        `LIVE SELECT table_name, record_id, action, change_type, payload, cursor_id, ` +
          `batch_ids, batch_record_ids, batch_edge_ids, batch_group_ids, batch_op_ids FROM changes`
      ]);
      const extracted = extractLiveIdFromResult(result);
      if (extracted.length > 0) liveIds.push(...extracted);

      if (liveIds.length > 0) {
        activeQueries.set('__all__', liveIds);
        logger.debug(`subscribed to changefeed liveIds=${liveIds.join(',')}`);
        emitSyncTrace(`surreal-live:${config.namespace}:${config.database}`, 'subscribe-live', {
          liveIds
        });
      } else {
        logger.warn(`could not extract live_id for changefeed subscription`);
      }
    } catch (e) {
      if (destroyed || isManualDisconnectError(e)) {
        logger.debug(`live query subscription cancelled during manual teardown`);
        return;
      }
      logger.error(`failed to subscribe to live queries`, e);
    }
  }

  function extractLiveIdFromResult(result: any): string[] {
    if (typeof result === 'string') return [result];
    if (Array.isArray(result)) {
      const ids: string[] = [];
      for (const item of result) {
        if (typeof item === 'string') ids.push(item);
        else if (item && typeof item.result === 'string') ids.push(item.result);
      }
      return ids;
    }
    return [];
  }

  async function unsubscribeAll() {
    const liveIds = activeQueries.get('__all__');
    if (!liveIds || !authenticated) return;
    try {
      await Promise.all(liveIds.map(liveId => sendRpc('kill', [liveId])));
      activeQueries.clear();
      logger.debug(`unsubscribed all live queries`);
    } catch (e) {
      if (destroyed || isManualDisconnectError(e)) {
        logger.debug(`live query shutdown cancelled during manual teardown`);
        return;
      }
      logger.error(`failed to kill live queries`, e);
    }
  }

  async function updateScopes(newScopes: string[]) {
    // Live queries are namespace-scoped (not record-scoped), so no re-subscription needed.
    // Just update the tracked scopes for any future use.
    currentScopes = new Set(normalizeScopes(newScopes));
  }

  function handleMessage(msg: SurrealLiveMessage) {
    // 1. Synchronous RPC Acknowledgement
    if (msg.id !== undefined && pendingRequests.has(msg.id)) {
      const callbacks = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      
      if (msg.error) callbacks.reject(new Error(msg.error.message));
      else callbacks.resolve(msg.result);
      return;
    }

    // Unsolicited Error Broadcast (i.e. mid-flight socket issue)
    if (msg.error) {
      logger.error(`SurrealDB unsolicited transport error: ${msg.error.message}`);
      return;
    }

    // 2. Continuous Live Query Broadcast Routing.
    //
    // Every notification here is a CREATE on the immutable `changes` table
    // (the ONLY thing we subscribe to — see the architecture note up top).
    // `item.action` is the LIVE action ON the changes table (always CREATE
    // for a new entry; UPDATE is blocked by perms, DELETE only via purge).
    // The real mutation lives inside the changes row at `item.result`.
    if (msg.result) {
      const items = Array.isArray(msg.result) ? msg.result : [msg.result];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (!('action' in item && ('result' in item || 'data' in item))) continue;
        const liveAction = typeof item.action === 'string' ? item.action.toUpperCase() : '';
        if (liveAction !== 'CREATE') continue; // changes table is append-only
        const changeRow = (item.result || item.data) as Record<string, any>;
        if (!changeRow || typeof changeRow !== 'object') continue;
        // Serialize dispatch so an id-refetch fallback can't reorder applies
        // relative to later changefeed entries.
        dispatchChain = dispatchChain
          .then(() => dispatchChangeRow(changeRow))
          .catch((e) => logger.error('failed to dispatch changefeed row', e));
      }
    }
  }

  function emitBusMsg(busMsg: LiveBusMsg) {
    logger.debug(`received live mutation type=${busMsg.type}`);
    emitSyncTrace(`surreal-live:${config.namespace}:${config.database}`, 'receive-live-mutation', {
      type: busMsg.type
    });
    onMessage(busMsg);
  }

  async function selectByIds(ids: string[]): Promise<unknown[]> {
    if (ids.length === 0) return [];
    const res = await sendRpc('query', [`SELECT * FROM [${ids.join(', ')}]`]);
    return parseSelectResult(res)[0] ?? [];
  }

  function lastStatementResult(res: unknown): unknown {
    if (!Array.isArray(res)) return res;
    const last = res[res.length - 1];
    if (last && typeof last === 'object' && 'result' in (last as any)) return (last as any).result;
    return last;
  }

  // Transport wrapper for the catch-up RPC; the dispatcher owns the paging
  // loop and cursor logic (and is unit-tested in changefeed-dispatch.test.ts).
  async function syncPull(
    since: string | undefined,
    limit: number
  ): Promise<{ changes: unknown[]; new_cursor?: unknown; oldest_cursor?: unknown }> {
    const sql =
      `LET $s = IF $since = NONE OR $since = NULL { NONE } ELSE { type::uuid($since) }; ` +
      `RETURN fn::sync_pull($s, $limit);`;
    const res = await sendRpc('query', [sql, { since: since ?? null, limit }]);
    const ret = lastStatementResult(res) as any;
    const obj = Array.isArray(ret) ? ret[0] : ret;
    return {
      changes: obj && Array.isArray(obj.changes) ? obj.changes : [],
      new_cursor: obj?.new_cursor,
      oldest_cursor: obj?.oldest_cursor
    };
  }

  const dispatcher = createChangefeedDispatcher({
    selectByIds,
    syncPull,
    emit: emitBusMsg,
    onCursorAdvance: options?.onCursorAdvance,
    isStopped: () => destroyed || !authenticated
  });
  const { dispatchChangeRow, runCatchup } = dispatcher;

  function scheduleReconnect() {
    if (destroyed) return;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    reconnectTimeout = setTimeout(() => {
      reconnectAttempts++;
      connect();
    }, getReconnectDelay());
  }

  function disconnect() {
    if (destroyed) return;
    destroyed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', handlePageUnload);
      window.removeEventListener('beforeunload', handlePageUnload);
      window.removeEventListener('online', handleOnline);
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    authenticated = false;
    activeQueries.clear();
    
    // Aggressively deny waiting promises
    for (const { reject } of pendingRequests.values()) {
        reject(new Error('Connection disconnected manually'));
    }
    pendingRequests.clear();
    rejectReady(new Error('Connection disconnected manually'));
    options?.onDisconnect?.('manual');
  }

  async function query<T = any>(sql: string, vars?: Record<string, unknown>): Promise<T> {
    if (destroyed) {
      throw new Error('Connection has been destroyed');
    }
    if (handshakeFailed) {
      throw new Error('SurrealDB handshake failed; cannot query');
    }
    if (!authenticated) {
      throw new Error('Not authenticated with SurrealDB');
    }
    // Only include vars in RPC params when present — JSON.stringify turns
    // undefined into null which SurrealDB WS may reject or hang on.
    const params: unknown[] = vars && Object.keys(vars).length > 0 ? [sql, vars] : [sql];
    return sendRpc('query', params);
  }

  return {
    connect,
    disconnect,
    updateScopes,
    whenReady() {
      if (authenticated) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        readyResolvers.push(resolve);
        readyRejectors.push(reject);
      });
    },
    query,
    runCatchup
  };
}

export type SurrealLiveConnection = ReturnType<typeof createSurrealLiveConnection>;
