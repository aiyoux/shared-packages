import type { Op, OpKind, CreateTreeBatchPayload, UpdateRecordsBatchPayload, CloneSetting } from '../cache/types.ts';
import type { LiveBus, LiveBusMsg } from './live.ts';
import type { AppCache } from '../cache/store.svelte.ts';
import { persistOp, deleteOp, updateOpStatus, getPendingOps as loadPendingOps, getAllOps as loadAllOps } from '../cache/persist.ts';
import { setSyncOp, removeSyncOp } from './ops-store.svelte.ts';
import type { LogLevel } from './logger.ts';
import { createLogger } from './logger.ts';
import { buildSurrealStatement } from './surrealql.ts';
import { MINUTE_MS } from '@modular-app/ui/date';
import { mergeAdditionalsLocal } from '../additionals-mutate.ts';
import type { AdditionalWithId } from '../types.ts';

export interface SyncEngineConfig {
  url: string;
  namespace: string;
  storageNamespace: string;
  database: string;
  token: string;
  scopes: string[];
  logLevel?: LogLevel;
  /** Lazy token provider. When set, takes precedence over the static `token` field. */
  getToken?: () => Promise<string>;
}

async function resolveToken(config: SyncEngineConfig): Promise<string> {
  if (config.getToken) return config.getToken();
  return config.token;
}

function generate_op_id(): string {
  return `op_${crypto.randomUUID()}`;
}

const SYNC_PUSH_TIMEOUT_MS = 30_000;

export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = SYNC_PUSH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

interface SurrealSqlStatement {
  status?: unknown;
  result?: unknown;
  detail?: unknown;
  error?: unknown;
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

  return null;
}

function normalizeDateAdditionalForSurreal(additional: unknown): unknown {
  if (!additional || typeof additional !== 'object') return additional;
  const source = additional as Record<string, unknown>;
  if (source.type !== 'date') return additional;

  const dateInfo =
    typeof source.date_info === 'object' && source.date_info !== null ? source.date_info : undefined;

  if (!dateInfo) {
    return {
      ...source,
      type: 'date'
    };
  }

  // Normalize is_status -> is for legacy compatibility
  const normalizedDateInfo = { ...(dateInfo as any) };
  if ('is_status' in normalizedDateInfo && !('is' in normalizedDateInfo)) {
    normalizedDateInfo.is = normalizedDateInfo.is_status;
    delete normalizedDateInfo.is_status;
  }

  return {
    ...source,
    type: 'date',
    date_info: normalizedDateInfo
  };
}

function stampPayloadAdditionals(payload: unknown, kind: OpKind): void {
  if (!payload || typeof payload !== 'object') return;
  const stampList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    const nowIso = new Date().toISOString();
    for (const entry of value) {
      if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).updated_at == null) {
        (entry as Record<string, unknown>).updated_at = nowIso;
      }
    }
  };
  if (kind === 'UpdateRecord' || kind === 'CreateRecord') {
    stampList((payload as Record<string, unknown>).additionals);
  } else if (kind === 'UpdateRecordsBatch') {
    const records = (payload as { records?: unknown }).records;
    if (Array.isArray(records)) {
      for (const record of records) {
        if (record && typeof record === 'object') stampList((record as Record<string, unknown>).additionals);
      }
    }
  }
}

function normalizeAdditionalsForSurreal(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  // Server-computed entries must never be queued: rollup values live in the
  // server-owned computed_additionals field, and the ingress chokepoint
  // (fn::fix_additional_ids) would strip them anyway. Filtering here keeps
  // payloads honest and optimistic derivations consistent.
  return value
    .filter((additional) => !(additional && typeof additional === 'object' && (additional as Record<string, unknown>).computed === true))
    .map((additional) => normalizeDateAdditionalForSurreal(additional));
}

function is_statement_result(value: unknown): value is SurrealSqlStatement {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('status' in value || 'detail' in value || 'error' in value)
  );
}

function collect_statement_results(value: unknown): SurrealSqlStatement[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collect_statement_results(entry));
  }

  if (!is_statement_result(value)) {
    return [];
  }

  if (
    Array.isArray(value.result) &&
    value.result.every((entry) => is_statement_result(entry))
  ) {
    return value.result.flatMap((entry) => collect_statement_results(entry));
  }

  return [value];
}

function statement_error_message(statement: SurrealSqlStatement): string | null {
  if (typeof statement.error === 'string' && statement.error.length > 0) {
    return statement.error;
  }

  if (statement.error && typeof statement.error === 'object' && 'message' in statement.error) {
    const message = (statement.error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }

  if (statement.status === 'ERR' && typeof statement.detail === 'string' && statement.detail.length > 0) {
    return statement.detail;
  }

  if (statement.status === 'ERR') {
    // Fall back to serializing whatever SurrealDB sent. We've been burned by
    // the generic "statement failure" message hiding the real cause (e.g.
    // parse errors, record-not-found). Dump the raw statement so it's visible
    // in the retry log.
    try {
      return `SurrealDB statement failure: ${JSON.stringify(statement)}`;
    } catch {
      return 'SurrealDB reported a statement failure';
    }
  }

  return null;
}

function extract_created_record_id(statements: SurrealSqlStatement[]): string | null {
  for (const statement of statements) {
    if (Array.isArray(statement.result)) {
      for (const row of statement.result) {
        if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
          return (row as { id: string }).id;
        }
      }
    }

    if (statement.result && typeof statement.result === 'object' && typeof (statement.result as { id?: unknown }).id === 'string') {
      return (statement.result as { id: string }).id;
    }
  }

  return null;
}

function extract_returned_record(statements: SurrealSqlStatement[]): Record<string, unknown> | null {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    const result = statements[index].result;
    if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as { id?: unknown }).id === 'string') {
      return result as Record<string, unknown>;
    }
    if (Array.isArray(result)) {
      for (let rowIndex = result.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const row = result[rowIndex];
        if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
          return row as Record<string, unknown>;
        }
      }
    }
  }

  return null;
}

function normalizeReturnedGraphEdge(row: Record<string, unknown> | null) {
  if (!row) return null;

  const edgeId = normalizeThingLike(row.id);
  const inId = normalizeThingLike(row.in);
  const outId = normalizeThingLike(row.out);
  if (!edgeId || !inId || !outId) return null;

  const isGraphChildOf = edgeId.startsWith('graph_child_of:');
  const isGrouping = edgeId.startsWith('groups:');
  if (!isGraphChildOf && !isGrouping) return null;

  return {
    edge_id: edgeId,
    parent_id: isGraphChildOf ? outId : inId,
    child_id: isGraphChildOf ? inId : outId,
    order: typeof row.order === 'number' ? row.order : 0,
    is_key_parent: isGraphChildOf
      ? (typeof row.key_parent === 'boolean' ? row.key_parent : true)
      : false,
    module_data: typeof row.module_data === 'object' && row.module_data !== null
      ? (row.module_data as Record<string, unknown>)
      : undefined,
    clone_setting: isGraphChildOf
      ? ((row.clone_setting as CloneSetting | null | undefined) ?? null)
      : null
  };
}

function selectAcceptedTargetId(
  op: Op,
  createdRecordId: string | null
): string | undefined {
  if (op.kind === 'CreateRecord' && createdRecordId) {
    return createdRecordId;
  }

  if (!op.payload || typeof op.payload !== 'object') {
    return undefined;
  }

  const candidate = op.payload as {
    id?: unknown;
    src?: unknown;
  };

  if (typeof candidate.id === 'string' && candidate.id.length > 0) {
    return candidate.id;
  }

  if (typeof candidate.src === 'string' && candidate.src.length > 0) {
    return candidate.src;
  }

  return undefined;
}

type SurrealPermissionRole = 'owner' | 'editor-adv' | 'editor' | 'viewer';

function normalizePermissionRole(value: unknown): SurrealPermissionRole | null {
  if (value === 'owner' || value === 'editor-adv' || value === 'editor' || value === 'viewer') {
    return value;
  }
  return null;
}

function normalizePermissionForSurreal(permission: unknown, context: string): { r: SurrealPermissionRole; u: string } {
  if (!permission || typeof permission !== 'object') {
    throw new Error(`${context}: permission must be an object`);
  }

  const source = permission as Record<string, unknown>;
  const role = normalizePermissionRole(source.r ?? source.role);
  const userId = source.u ?? source.user_id;

  if (!role) {
    throw new Error(`${context}: permission is missing a valid role`);
  }
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error(`${context}: permission is missing a valid user id`);
  }

  return { r: role, u: userId };
}

function normalizePermissionsForSurreal(value: unknown, context: string): { r: SurrealPermissionRole; u: string }[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: permissions must be an array`);
  }
  return value.map((permission, index) => normalizePermissionForSurreal(permission, `${context}[${index}]`));
}

function evaluate_sql_response(payload: unknown) {
  const statements = collect_statement_results(payload);
  if (statements.length === 0) {
    throw new Error('Malformed SurrealDB sync response');
  }

  for (const statement of statements) {
    const errorMessage = statement_error_message(statement);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
  }

  return {
    statements,
    createdRecordId: extract_created_record_id(statements)
  };
}

export function isRetryableSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return (
    normalized.includes('read or write conflict') ||
    normalized.includes('failed to commit transaction') ||
    normalized.includes('transaction can be retried') ||
    normalized.includes('this transaction can be retried')
  );
}

function assertNever(_value: never): never {
  throw new Error('Unhandled live bus message');
}

// Structural graph/op keys remapped ANYWHERE in a payload. Module-specific
// record references do NOT belong here: inside module_settings, references
// live under reserved `refs: {}` objects whose every string value (and string
// array element) is remapped blindly — see ref_child_scope below and
// module-refs.ts. This replaces the old ever-growing per-module key whitelist,
// whose forgotten entries left temp ids dangling forever.
const REFERENCE_ID_KEYS = new Set([
  'id',
  'in',
  'out',
  'src',
  'dst',
  'parent',
  'child',
  'parent_id',
  'child_id',
  'parentId',
  'childId',
  'oldParentId',
  'newParentId',
  'tempId',
  'realId',
  'groupId',
  'memberId'
]);

/**
 * Traversal scope for reference remapping:
 *  - 'default':  structural whitelist applies; entering a `module_settings`
 *                key switches to 'settings'.
 *  - 'settings': module-private blob — NOTHING is remapped except inside a
 *                reserved `refs` object.
 *  - 'refs':     every string value / string array element is a record ref.
 */
type RefScope = 'default' | 'settings' | 'refs';

function ref_child_scope(scope: RefScope, key: string): RefScope {
  if (scope === 'default') return key === 'module_settings' ? 'settings' : 'default';
  if (scope === 'settings') return key === 'refs' ? 'refs' : 'settings';
  return 'refs';
}

function is_ref_slot(scope: RefScope, key: string): boolean {
  if (scope === 'refs') return true;
  if (scope === 'settings') return false;
  return REFERENCE_ID_KEYS.has(key);
}

function rewrite_reference_ids(value: unknown, oldId: string, newId: string, scope: RefScope = 'default'): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  let changed = false;

  if (Array.isArray(value)) {
    // Inside a refs object, string array elements are record refs too
    // (e.g. shopping line_item refs.source_record_ids).
    if (scope === 'refs') {
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === oldId) {
          value[index] = newId;
          changed = true;
        }
      }
    }
    for (const entry of value) {
      changed = rewrite_reference_ids(entry, oldId, newId, scope) || changed;
    }
    return changed;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry === oldId && is_ref_slot(scope, key)) {
      record[key] = newId;
      changed = true;
      continue;
    }

    if (entry && typeof entry === 'object') {
      changed = rewrite_reference_ids(entry, oldId, newId, ref_child_scope(scope, key)) || changed;
    }
  }

  return changed;
}

function has_reference_id(value: unknown, targetId: string, scope: RefScope = 'default'): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    if (scope === 'refs' && value.some((entry) => entry === targetId)) return true;
    for (const entry of value) {
      if (has_reference_id(entry, targetId, scope)) return true;
    }
    return false;
  }

  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      const entry = record[key];
      if (typeof entry === 'string' && entry === targetId && is_ref_slot(scope, key)) {
        return true;
      }

      if (entry && typeof entry === 'object') {
        if (has_reference_id(entry, targetId, ref_child_scope(scope, key))) return true;
      }
    }
  }

  return false;
}

const SQL_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Find content fields that reference a temp id created by the SAME
 * CreateTreeBatch (e.g. a shopping line's module_settings list_id pointing at
 * the list record in the batch). These never go through the per-record remap
 * path, so they must be rewritten server-side after the batch CREATEs.
 * `id`/`tempId` are excluded: the record's own identity is assigned by CREATE.
 */
function collect_intra_batch_reference_paths(
  value: unknown,
  tempIdToIdx: Map<string, number>,
  path = '',
  out: Array<{ path: string; targetIdx: number }> = [],
  scope: RefScope = 'default'
): Array<{ path: string; targetIdx: number }> {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (scope === 'refs' && typeof entry === 'string' && tempIdToIdx.has(entry)) {
        out.push({ path: `${path}[${index}]`, targetIdx: tempIdToIdx.get(entry)! });
        return;
      }
      collect_intra_batch_reference_paths(entry, tempIdToIdx, `${path}[${index}]`, out, scope);
    });
    return out;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!SQL_PATH_SEGMENT.test(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    if (
      typeof entry === 'string' &&
      key !== 'id' &&
      key !== 'tempId' &&
      is_ref_slot(scope, key) &&
      tempIdToIdx.has(entry)
    ) {
      out.push({ path: childPath, targetIdx: tempIdToIdx.get(entry)! });
      continue;
    }
    if (entry && typeof entry === 'object') {
      collect_intra_batch_reference_paths(entry, tempIdToIdx, childPath, out, ref_child_scope(scope, key));
    }
  }

  return out;
}

function collect_temp_reference_ids(value: unknown, found = new Set<string>(), scope: RefScope = 'default'): Set<string> {
  if (!value || typeof value !== 'object') {
    return found;
  }

  if (Array.isArray(value)) {
    if (scope === 'refs') {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.startsWith('temp:')) found.add(entry);
      }
    }
    for (const entry of value) {
      collect_temp_reference_ids(entry, found, scope);
    }
    return found;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry.startsWith('temp:') && is_ref_slot(scope, key)) {
      found.add(entry);
      continue;
    }

    if (entry && typeof entry === 'object') {
      collect_temp_reference_ids(entry, found, ref_child_scope(scope, key));
    }
  }

  return found;
}

export function createSyncEngine(
  cache: AppCache,
  liveBus: LiveBus,
  config: SyncEngineConfig
) {
  const logger = createLogger(`sync:${config.storageNamespace}`, config.logLevel ?? 'info');
  let oplog: Op[] = [];
  let inflightOps: Map<string, Op> = new Map();
  let syncPromise: Promise<void> | null = null;
  let initialized = false;
  let failureCount = 0;
  let syncLoopWake: (() => void) | null = null;
  let syncWasBusy = false;
  // Set whenever a pushOps() call collides with an already-running push (the
  // lock makes it a no-op). It records "more work was requested while we were
  // busy" — covering both a same-tab queueAndWake and a cross-tab SyncWake
  // whose op lives only in IDB (not yet in our in-memory oplog). The owning
  // push re-drains when it sees this, so late work doesn't wait for the next
  // ~30s sync-loop tick.
  let pushRequestedDuringFlight = false;

  const MAX_RETRIES = 5;
  const BASE_BACKOFF_MS = 5000;
  const MAX_BACKOFF_MS = 300000;

  // NOTE: client-side self-echo suppression (ownSyncOpIds / markOwnSyncOp /
  // isOwnSyncOp) was REMOVED with the move to the changefeed subscription.
  // The client now re-applies its own writes idempotently (cache ops are
  // upserts), exactly like legacy wisewords. Server-side `skip_changefeed`
  // and the `sync_ops` table handle dedupe. See the LIVE SYNC ARCHITECTURE
  // note in surrealdb-live.ts. Do NOT reintroduce op-id echo tracking — it
  // only existed to paper over the old raw `LIVE SELECT *` firehose.

  function publishOp(op: Op): void {
    setSyncOp(config.storageNamespace, op);
    // BroadcastChannel does not loop back to the sender, so keep the local
    // store update above and mirror lifecycle changes to follower tabs.
    liveBus.broadcast({ type: 'OpUpsert', op });
  }

  function scheduleRemoveSyncOp(opId: string, delayMs = 10000): void {
    setTimeout(() => {
      removeSyncOp(config.storageNamespace, opId);
      liveBus.broadcast({ type: 'OpRemove', id: opId });
    }, delayMs);
  }

  async function persistAndPublish(op: Op): Promise<void> {
    op.updated = Date.now();
    publishOp(op);
    await persistOp(config.storageNamespace, {
      id: op.id,
      kind: op.kind,
      payload: op.payload,
      status: op.status,
      created: op.created,
      retries: op.retries,
      last_error: op.last_error,
      last_attempt_at: op.last_attempt_at,
      updated: op.updated
    }).catch((e) => logger.error('failed to persist op', e));
  }

  // Per-op exponential backoff. The wait before an op's next attempt is derived
  // from that op's OWN retry count + `last_attempt_at` — NOT a shared counter.
  // The old global `failureCount` gate stalled the ENTIRE queue (including
  // brand-new, never-tried writes) for up to MAX_BACKOFF_MS whenever any single
  // op was backing off; a retryable-conflict op (infinite retries) could starve
  // healthy writes indefinitely. A never-attempted op (retries 0) is always
  // eligible, so one struggling op can no longer block unrelated ones.
  function backoffForRetries(retries: number): number {
    if (retries <= 0) return 0;
    return Math.min(
      BASE_BACKOFF_MS * Math.pow(2, Math.min(retries, 6)),
      MAX_BACKOFF_MS
    );
  }

  function opEligibleNow(op: Op, now: number): boolean {
    if (op.retries <= 0) return true;
    return now - (op.last_attempt_at ?? 0) >= backoffForRetries(op.retries);
  }

  /** Load pending ops from IndexedDB on startup so they survive page refresh. */
  async function initialize(): Promise<void> {
    if (initialized) return;
    initialized = true;
    try {
      const [pending, all] = await Promise.all([
        loadPendingOps(config.storageNamespace),
        loadAllOps(config.storageNamespace)
      ]);
      const existingIds = new Set(oplog.map(op => op.id));
      for (const raw of pending) {
        const op: Op = {
          id: raw.id,
          kind: raw.kind as OpKind,
          payload: raw.payload,
          status: 'pending',
          created: raw.created,
          retries: raw.retries,
          last_error: raw.last_error,
          last_attempt_at: raw.last_attempt_at,
          updated: raw.updated
        };
        if (!existingIds.has(op.id)) {
          oplog.push(op);
          existingIds.add(op.id);
        }
        publishOp(op);
      }
      // Hydrate store with rejected ops too so the UI reflects the full queue state.
      for (const raw of all) {
        if (raw.status === 'rejected') {
          publishOp({
            id: raw.id,
            kind: raw.kind as OpKind,
            payload: raw.payload,
            status: 'rejected',
            created: raw.created,
            retries: raw.retries,
            last_error: raw.last_error,
            last_attempt_at: raw.last_attempt_at,
            updated: raw.updated
          });
        }
      }
    } catch (e) {
      logger.error('failed to load pending ops from IndexedDB', e);
    }
  }

  function queueOp(kind: OpKind, payload: unknown): Op {
    const now = Date.now();
    // De-proxy reactive (Svelte $state) payloads before they enter the op
    // pipeline. The op is persisted to IndexedDB and broadcast over a
    // BroadcastChannel, both of which structured-clone — a proxy nested in the
    // payload throws DataCloneError and the op sticks pending/inflight forever
    // (no broadcast, no persist). The cache owns the svelte-aware deep clone
    // ($state.snapshot + structuredClone, which also preserves Date instances
    // that a JSON round-trip would corrupt). Defensive `?.` so a partial cache
    // stub without clonePlain (e.g. unit tests) falls back to the raw payload.
    const plainPayload =
      typeof (cache as any).clonePlain === 'function'
        ? (cache as any).clonePlain(payload)
        : payload;
    // Stamp per-entry updated_at NOW (queue = edit time), not at flush: an
    // offline queue can drain hours later, and fn::merge_additionals' per-id
    // LWW must see when the user actually edited, not when the op arrived.
    stampPayloadAdditionals(plainPayload, kind);
    const op: Op = {
      id: generate_op_id(),
      kind,
      payload: plainPayload,
      status: 'pending',
      created: now,
      retries: 0,
      updated: now
    };
    oplog.push(op);

    void persistAndPublish(op);

    logger.debug(`queued op kind=${kind} id=${op.id}`);

    // Wake the sync loop out of idle backoff so the new op flushes promptly
    syncLoopWake?.();

    return op;
  }

  async function pushOps(): Promise<void> {
    // Promise-based lock: if a sync is already running, wait for it then return.
    // Flag the collision so the owning push re-drains afterwards — this is the
    // signal that covers cross-tab SyncWake ops (which live only in IDB until
    // the re-run's loadPendingOps pulls them in) as well as same-tab wakes.
    if (syncPromise) {
      pushRequestedDuringFlight = true;
      await syncPromise;
      return;
    }

    // Capture ops queued by sleeping/background followers into shared IndexedDB
    const persisted = await loadPendingOps(config.storageNamespace);
    const existingIds = new Set(oplog.map(op => op.id));
    for (const raw of persisted) {
      if (!existingIds.has(raw.id)) {
        const op: Op = {
          id: raw.id,
          kind: raw.kind as OpKind,
          payload: raw.payload,
          status: 'pending',
          created: raw.created,
          retries: raw.retries,
          last_error: raw.last_error,
          last_attempt_at: raw.last_attempt_at,
          updated: raw.updated
        };
        oplog.push(op);
        existingIds.add(raw.id);
        publishOp(op);
      }
    }

    // Per-op backoff: attempt only ops that are eligible now (never-tried, or
    // past their own retry backoff). Ops still backing off stay pending and are
    // retried by a later pushOps()/sync-loop tick — they no longer block the
    // eligible ones.
    const now = Date.now();
    const pending = oplog.filter(op => op.status === 'pending' && opEligibleNow(op, now));
    if (pending.length === 0) return;
    syncWasBusy = true;
    logger.debug(`pushing ${pending.length} pending ops`);

    // executePush only processes THIS snapshot. Ops queued while the push is
    // in flight (the rapid-fire user-action case — e.g. checking off several
    // exec items in quick succession) are NOT in `pending`, and the
    // `if (syncPromise) { await; return; }` lock above made their own
    // pushOps() calls no-ops. Remember the snapshot ids so we can detect such
    // late arrivals and drain them once the lock is released, instead of
    // stranding them until the next ~30s sync-loop tick.
    const snapshotIds = new Set(pending.map(op => op.id));
    // Reset right before we take ownership; any collision from here on is work
    // that arrived DURING this push and must be drained when it finishes.
    pushRequestedDuringFlight = false;
    syncPromise = executePush(pending);
    try {
      await syncPromise;
    } finally {
      syncPromise = null;
      if (
        syncWasBusy &&
        oplog.every(op => op.status !== 'pending') &&
        inflightOps.size === 0
      ) {
        syncWasBusy = false;
        cache.notify_sync_idle?.();
      }
    }

    // Drain work that arrived DURING the push just completed. Two triggers:
    //  - pushRequestedDuringFlight: a concurrent pushOps() collided with the
    //    lock (same-tab queueAndWake or cross-tab SyncWake — the latter's op is
    //    only in IDB, which the re-run's loadPendingOps will pull in).
    //  - a late in-memory op not in our snapshot (defensive belt-and-suspenders).
    // Both key off "new ELIGIBLE work appeared," NOT "any pending op remains".
    // The eligibility check is essential now that pushOps filters by per-op
    // backoff: a failed op that's still backing off is pending AND not in
    // `snapshotIds`, so without it this would hot-loop. Genuinely stuck ops
    // (deferred on an unresolved temp id, or backing off) set no flag and are
    // not eligible/new, so they wait for the next sync-loop tick instead.
    if (
      pushRequestedDuringFlight ||
      oplog.some(op => op.status === 'pending' && !snapshotIds.has(op.id) && opEligibleNow(op, Date.now()))
    ) {
      await pushOps();
    }
  }

  function buildTreeBatchSql(op: Op, payload: CreateTreeBatchPayload): { sql: string; vars: Record<string, unknown> } {
    const vars: Record<string, unknown> = { op_id: op.id };
    const tempIdToIdx = new Map<string, number>();
    payload.records.forEach((record, index) => tempIdToIdx.set(record.tempId, index));

    const lines: string[] = [];
    lines.push('LET $existing = (SELECT * FROM records WHERE _sync_op_id = $op_id);');
    lines.push('IF array::len($existing) > 0 {');
    lines.push('  RETURN { records: $existing, edges: (SELECT * FROM graph_child_of WHERE _sync_op_id = $op_id) };');
    lines.push('};');

    payload.records.forEach((record, index) => {
      const varName = `rec_${index}`;
      // Peel `permissions` off the CREATE content for the same reason
      // build_op_vars/build_op_sql do for single-record ops: SurrealDB's
      // permission check compares `$perm.u = $user_id` (record vs record),
      // and JSON serialization of `u` produces a string — comparison fails,
      // CREATE silently rejected. Apply the cast in a follow-up MERGE once
      // the row exists. (Empty/undefined `perms` skips the MERGE entirely.)
      const content = { ...record.content } as Record<string, unknown>;
      const recordPerms = Array.isArray(content.permissions)
        ? normalizePermissionsForSurreal(content.permissions, `CreateTreeBatch.records[${index}].permissions`)
        : null;
      if (recordPerms) delete content.permissions;
      // Drop any client-side created/updated so server-side time::now() below
      // is authoritative and typed as a SurrealDB datetime.
      delete content.created;
      delete content.updated;
      // The record's own identity is assigned by SurrealDB — `CREATE records
      // CONTENT` with no `id` yields a server-assigned random id, which
      // `temp_ids` (below) reads back and `cache.remap_id` pairs with the
      // caller's `record.tempId`. Strip any `id` the caller put on `content`
      // (optimistic clones carry `id: temp:…` as the local placeholder + the
      // intra-batch reference key is tracked separately via `record.tempId`).
      // Without this, SurrealDB persists the temp string as the record id →
      // permanent `records:`temp:⟨uuid⟩`` rows (records is SCHEMALESS, so it
      // accepts the string id and backtick-quotes it). Mirrors build_op_vars
      // (CreateRecord, line ~2008) and buildUpdateRecordsBatchSql (line ~1300).
      delete content.id;
      // Server-owned rollup values must not be cloned from the cached source
      // item — the server re-derives them (fn::recompute_computed_additionals
      // + edge kicks) once the batch's records and edges exist.
      delete content.computed_additionals;
      vars[varName] = {
        ...content,
        // Retry-idempotency key (NOT echo suppression — see note near
        // publishOp). The `$existing` guard above dedupes a replayed batch.
        _sync_op_id: op.id,
        // Suppress the per-row changefeed event. A CreateTreeBatch clones N
        // records + N edges; without this each CREATE/RELATE logs its own
        // `changes` row and floods every live subscriber with N per-row
        // upserts. Instead we emit ONE consolidated fn::log_batch_clone at
        // the end (mirrors fn::clone_from_source_array). Cleared afterwards
        // so subsequent normal edits ARE tracked. See LIVE SYNC ARCHITECTURE
        // in surrealdb-live.ts.
        skip_changefeed: true
      };
      lines.push(`  LET $r_${index} = (CREATE records CONTENT $${varName})[0];`);
      lines.push(`  LET $r_id_${index} = $r_${index}.id;`);
      lines.push(`  UPDATE $r_id_${index} MERGE { created: time::now(), updated: time::now() };`);
      lines.push(`  IF $r_${index}.additionals != NONE {`);
      lines.push(`    UPDATE $r_id_${index} SET additionals = fn::fix_additional_ids($r_${index}.additionals);`);
      // Self-derive rollup marker values (computed entries never arrive from
      // the client). Parent-side recomputes happen via the edge kicks.
      lines.push(`    fn::recompute_computed_additionals($r_id_${index});`);
      lines.push(`  };`);
      if (recordPerms && recordPerms.length > 0) {
        const permsVarName = `perms_${index}`;
        vars[permsVarName] = recordPerms;
        lines.push(
          `  UPDATE $r_id_${index} MERGE { permissions: $${permsVarName}.map(|$p| { r: $p.r, u: type::record($p.u) }) };`
        );
      }
    });

    // Rewrite intra-batch temp references inside record content to the
    // server-assigned ids (stored as strings, matching client-written refs).
    // Without this, content like a line's list_id keeps the dead temp id
    // forever — the per-record remap path never sees batch-created records.
    payload.records.forEach((record, index) => {
      for (const ref of collect_intra_batch_reference_paths(record.content, tempIdToIdx)) {
        lines.push(`  UPDATE $r_id_${index} SET ${ref.path} = <string> $r_id_${ref.targetIdx};`);
      }
    });

    payload.edges.forEach((edge, index) => {
      const edgeVarName = `edge_${index}`;
      vars[edgeVarName] = {
        order: edge.order,
        key_parent: edge.key_parent,
        ...(edge.moduleData ? { module_data: edge.moduleData } : {}),
        // Preserve clone mode on the recreated edge so a clone-of-a-clone
        // keeps its semantics. Absent → default (server treats NONE as default).
        ...(edge.cloneSetting ? { clone_setting: edge.cloneSetting } : {}),
        _sync_op_id: op.id,
        skip_changefeed: true
      };

      // Child is either a cloned (temp) record or, for link_to_original, an
      // existing real record linked under the cloned parent.
      let childExpr: string;
      const childRef = edge.childRef ?? { kind: 'temp' as const, tempId: edge.childTempId };
      if (childRef.kind === 'real') {
        const childVarName = `edge_${index}_child`;
        const childIdVarName = `edge_${index}_child_id`;
        vars[childVarName] = childRef.id;
        lines.push(`  LET $${childIdVarName} = type::record($${childVarName});`);
        childExpr = `$${childIdVarName}`;
      } else {
        const childIdx = tempIdToIdx.get(childRef.tempId);
        if (childIdx === undefined) {
          throw new Error(`CreateTreeBatch: unknown childTempId ${childRef.tempId}`);
        }
        childExpr = `$r_id_${childIdx}`;
      }

      let parentExpr: string;
      if (edge.parentRef.kind === 'temp') {
        const parentIdx = tempIdToIdx.get(edge.parentRef.tempId);
        if (parentIdx === undefined) {
          throw new Error(`CreateTreeBatch: unknown parent tempId ${edge.parentRef.tempId}`);
        }
        parentExpr = `$r_id_${parentIdx}`;
      } else {
        const parentVarName = `edge_${index}_parent`;
        const parentIdVarName = `edge_${index}_parent_id`;
        vars[parentVarName] = edge.parentRef.id;
        lines.push(`  LET $${parentIdVarName} = type::record($${parentVarName});`);
        parentExpr = `$${parentIdVarName}`;
      }

      lines.push(
        `  LET $e_${index} = (RELATE ${childExpr}->graph_child_of->${parentExpr} CONTENT $${edgeVarName})[0];`
      );
    });

    // Recreate groups edges copied from source items.
    payload.groupEdges?.forEach((edge, index) => {
      const childIdx = tempIdToIdx.get(edge.childTempId);
      if (childIdx === undefined) {
        throw new Error(`CreateTreeBatch: unknown group childTempId ${edge.childTempId}`);
      }

      const edgeVarName = `group_edge_${index}`;
      vars[edgeVarName] = {
        _sync_op_id: op.id,
        skip_changefeed: true,
        ...(edge.moduleData ? { module_data: edge.moduleData } : {})
      };

      const groupVarName = `group_edge_${index}_group`;
      const groupIdVarName = `group_edge_${index}_group_id`;
      vars[groupVarName] = edge.groupId;
      lines.push(`  LET $${groupIdVarName} = type::record($${groupVarName});`);

      const childExpr = `$r_id_${childIdx}`;
      lines.push(
        `  LET $ge_${index} = (RELATE $${groupIdVarName}->groups->${childExpr} CONTENT $${edgeVarName})[0];`
      );
    });

    // Recreate applies edges copied from source items.
    payload.appliesEdges?.forEach((edge, index) => {
      let srcExpr: string;
      if (edge.srcRef.kind === 'real') {
        const srcVarName = `applies_edge_${index}_src`;
        const srcIdVarName = `applies_edge_${index}_src_id`;
        vars[srcVarName] = edge.srcRef.id;
        lines.push(`  LET $${srcIdVarName} = type::record($${srcVarName});`);
        srcExpr = `$${srcIdVarName}`;
      } else {
        const srcIdx = tempIdToIdx.get(edge.srcRef.tempId);
        if (srcIdx === undefined) {
          throw new Error(`CreateTreeBatch: unknown applies src tempId ${edge.srcRef.tempId}`);
        }
        srcExpr = `$r_id_${srcIdx}`;
      }

      let dstExpr: string;
      if (edge.dstRef.kind === 'real') {
        const dstVarName = `applies_edge_${index}_dst`;
        const dstIdVarName = `applies_edge_${index}_dst_id`;
        vars[dstVarName] = edge.dstRef.id;
        lines.push(`  LET $${dstIdVarName} = type::record($${dstVarName});`);
        dstExpr = `$${dstIdVarName}`;
      } else {
        const dstIdx = tempIdToIdx.get(edge.dstRef.tempId);
        if (dstIdx === undefined) {
          throw new Error(`CreateTreeBatch: unknown applies dst tempId ${edge.dstRef.tempId}`);
        }
        dstExpr = `$r_id_${dstIdx}`;
      }

      const edgeVarName = `applies_edge_${index}`;
      vars[edgeVarName] = {
        _sync_op_id: op.id,
        skip_changefeed: true,
        ...(edge.moduleData ? { module_data: edge.moduleData } : {})
      };

      lines.push(
        `  LET $ae_${index} = (RELATE ${srcExpr}->appliesto->${dstExpr} CONTENT $${edgeVarName})[0];`
      );
    });

    // Re-select records so the response carries post-MERGE created/updated
    // values rather than the stale LET-captured $r_* rows.
    const recordIdRefs = payload.records.map((_, index) => `$r_id_${index}`).join(', ');
    const childEdgeIdRefs = payload.edges.map((_, index) => `$e_${index}.id`).join(', ');
    const groupEdgeIdRefs = (payload.groupEdges?.map((_, index) => `$ge_${index}.id`) ?? []).join(', ');
    const appliesEdgeIdRefs = (payload.appliesEdges?.map((_, index) => `$ae_${index}.id`) ?? []).join(', ');
    const allEdgeRefs = [
      ...payload.edges.map((_, index) => `$e_${index}`),
      ...(payload.groupEdges?.map((_, index) => `$ge_${index}`) ?? []),
      ...(payload.appliesEdges?.map((_, index) => `$ae_${index}`) ?? [])
    ].join(', ');

    // Emit ONE consolidated changefeed entry for the whole batch instead of
    // the N per-row CREATE/RELATE events (which were suppressed via
    // skip_changefeed above). This is the CreateTreeBatch analogue of
    // fn::clone_from_source_array's batch emission — see LIVE SYNC
    // ARCHITECTURE in surrealdb-live.ts. Then clear skip_changefeed so later
    // normal edits to these rows ARE tracked (the clearing UPDATE itself
    // produces no event: $before.skip_changefeed = true).
    if (payload.records.length > 0) {
      lines.push(`  LET $batch_record_ids = [${recordIdRefs}];`);
      lines.push(`  LET $batch_edge_ids = [${childEdgeIdRefs}];`);
      lines.push(`  LET $batch_group_ids = [${groupEdgeIdRefs}];`);
      lines.push(`  LET $batch_applies_ids = [${appliesEdgeIdRefs}];`);
      lines.push(`  LET $batch_perms = (SELECT VALUE effective_permissions FROM $batch_record_ids[0])[0];`);
      lines.push(`  fn::log_batch_clone($batch_record_ids, $batch_edge_ids, $batch_group_ids, $batch_applies_ids, $batch_perms);`);
      // SurrealDB's UPDATE target must be an expression/variable — an inline
      // array literal (`UPDATE [a, b] ...`) is a parse error. Use the LET
      // vars (empty array ⇒ no-op).
      lines.push(`  UPDATE $batch_record_ids SET skip_changefeed = NONE;`);
      if (childEdgeIdRefs) lines.push(`  UPDATE $batch_edge_ids SET skip_changefeed = NONE;`);
      if (groupEdgeIdRefs) lines.push(`  UPDATE $batch_group_ids SET skip_changefeed = NONE;`);
      if (appliesEdgeIdRefs) lines.push(`  UPDATE $batch_applies_ids SET skip_changefeed = NONE;`);
    }

    // temp_ids is ordered like payload.records so the client can pair each
    // tempId with its server-assigned id (the records SELECT has no
    // guaranteed order) and rewrite queued ops that reference it.
    const tempIdRefs = payload.records.map((_, index) => `<string> $r_id_${index}`).join(', ');
    lines.push(
      `RETURN { records: (SELECT * FROM records WHERE id IN [${recordIdRefs}]), edges: [${allEdgeRefs}], temp_ids: [${tempIdRefs}] };`
    );

    return { sql: lines.join('\n'), vars };
  }

  function extractBatchResult(
    statements: SurrealSqlStatement[]
  ): { records: any[]; edges: any[]; temp_ids?: any[] } | null {
    for (const statement of statements) {
      const r = statement.result as any;
      if (r && typeof r === 'object' && Array.isArray(r.records) && Array.isArray(r.edges)) {
        return {
          records: r.records,
          edges: r.edges,
          ...(Array.isArray(r.temp_ids) ? { temp_ids: r.temp_ids } : {})
        };
      }
    }
    return null;
  }

  function normalizeThingString(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      const v = value as { tb?: unknown; id?: unknown; toString?: () => string };
      if (typeof v.tb === 'string' && v.id !== undefined && v.id !== null) {
        return `${v.tb}:${typeof v.id === 'object' ? JSON.stringify(v.id) : String(v.id)}`;
      }
      if (typeof v.toString === 'function') {
        const s = v.toString();
        if (s && s !== '[object Object]') return s;
      }
    }
    return null;
  }

  async function runTreeBatch(op: Op, acceptedMarkerOpIds: Set<string>): Promise<void> {
    const payload = op.payload as CreateTreeBatchPayload;
    if (
      !payload ||
      !Array.isArray(payload.records) ||
      !Array.isArray(payload.edges)
    ) {
      op.status = 'rejected';
      op.last_error = 'CreateTreeBatch payload missing records/edges';
      await persistAndPublish(op);
      return;
    }

    op.status = 'inflight';
    op.last_attempt_at = Date.now();
    op.last_error = undefined;
    publishOp(op);
    inflightOps.set(op.id, op);

    try {
      const { sql, vars } = buildTreeBatchSql(op, payload);
      const token = await resolveToken(config);
      const statement = buildSurrealStatement(sql, vars);
      let response = await fetchWithTimeout(`${config.url}/sql`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'text/plain',
          'surreal-ns': config.namespace,
          'surreal-db': config.database,
          'authorization': `Bearer ${token}`
        },
        body: statement
      });

      if (response.status === 401 && config.getToken) {
        logger.warn(`401 on batch op ${op.id}; retrying with fresh token`);
        const freshToken = await config.getToken();
        response = await fetchWithTimeout(`${config.url}/sql`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'text/plain',
            'surreal-ns': config.namespace,
            'surreal-db': config.database,
            'authorization': `Bearer ${freshToken}`
          },
          body: statement
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`CreateTreeBatch HTTP ${response.status} body: ${body.slice(0, 800)}`);
        logger.debug(`CreateTreeBatch failing SQL:\n${statement.slice(0, 1500)}`);
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      const resJson = await response.json();
      const evaluation = evaluate_sql_response(resJson);
      const final = extractBatchResult(evaluation.statements);
      if (!final) throw new Error('CreateTreeBatch: response missing records/edges');

      const cores: any[] = [];
      for (const rec of final.records) {
        if (!rec || typeof rec !== 'object') continue;
        const realId = normalizeThingString((rec as any).id);
        if (!realId) continue;
        const r = rec as any;
        cores.push({
          ...r,
          id: realId,
          created: typeof r.created === 'string' ? r.created : (r.created != null ? String(r.created) : undefined),
          updated: typeof r.updated === 'string' ? r.updated : (r.updated != null ? String(r.updated) : undefined),
          is_temp: false,
          dirty: false,
          sync_status: 'accepted'
        });
      }

      const normalizedEdges: any[] = [];
      const normalizedGroupEdges: any[] = [];
      const normalizedAppliesEdges: any[] = [];
      for (const edge of final.edges) {
        if (!edge || typeof edge !== 'object') continue;
        const realEdgeId = normalizeThingString((edge as any).id);
        const inId = normalizeThingString((edge as any).in);
        const outId = normalizeThingString((edge as any).out);
        if (!realEdgeId || !inId || !outId) continue;

        if (realEdgeId.startsWith('appliesto:')) {
          normalizedAppliesEdges.push({
            edge_id: realEdgeId,
            src_id: inId,
            dst_id: outId,
            module_data: (edge as any).module_data
          });
          continue;
        }

        // graph_child_of: in=child, out=parent (key_parent flag on edge).
        // groups:        in=group_record, out=member_record.
        // The cache stores everything via the graph_child_of_edge map keyed by
        // parent_id (= scope/owner) → child_id (= member). For groups edges
        // that means parent_id should be the GROUP (in), child the member (out).
        const isGroupEdge = realEdgeId.startsWith('groups:');
        const normalized = {
          edge_id: realEdgeId,
          child_id: isGroupEdge ? outId : inId,
          parent_id: isGroupEdge ? inId : outId,
          order: typeof (edge as any).order === 'number' ? (edge as any).order : 0,
          is_key_parent: isGroupEdge ? false : (typeof (edge as any).key_parent === 'boolean' ? (edge as any).key_parent : true)
        };
        if (isGroupEdge) {
          normalizedGroupEdges.push(normalized);
        } else {
          normalizedEdges.push(normalized);
        }
      }

      // Mark op accepted before async cache mutation (mirrors single-op pattern).
      op.status = 'accepted';
      op.updated = Date.now();
      inflightOps.delete(op.id);
      oplog = oplog.filter(o => o.id !== op.id);
      failureCount = 0;
      acceptedMarkerOpIds.add(op.id);
      await persistAndPublish(op);

      // 1. Drop the optimistic preview from the cache. The server creates
      //    durable ids for the same client-resolved clone payload, so swap the
      //    optimistic rows out wholesale instead of remapping temp ids.
      for (const tempEdgeId of payload.optimisticTempEdgeIds ?? []) {
        cache.remove_graph_child(tempEdgeId);
      }
      for (const tempGroupEdgeId of payload.optimisticGroupTempEdgeIds ?? []) {
        cache.remove_graph_child(tempGroupEdgeId);
      }
      for (const tempAppliesEdgeId of payload.optimisticAppliesTempEdgeIds ?? []) {
        cache.remove_applies_edge(tempAppliesEdgeId);
      }
      for (const tempId of payload.optimisticTempIds ?? []) {
        cache.removeItem(tempId);
      }

      // 2. Apply server-confirmed records and edges in bulk.
      if (cores.length > 0) {
        cache.batch_upsert(cores);
        liveBus.broadcast({ type: 'RecordBatchUpsert', cores });
      }
      if (normalizedEdges.length > 0) {
        for (const e of normalizedEdges) {
          cache.upsert_graph_child_of_edge(e.edge_id, e.child_id, e.parent_id, e.order, e.is_key_parent, undefined, (e as any).clone_setting ?? null);
        }
        liveBus.broadcast({ type: 'GraphChildBatchUpsert', edges: normalizedEdges });
      }
      if (normalizedGroupEdges.length > 0) {
        for (const e of normalizedGroupEdges) {
          cache.upsert_graph_child_of_edge(e.edge_id, e.child_id, e.parent_id, e.order, false);
        }
        liveBus.broadcast({ type: 'GraphChildBatchUpsert', edges: normalizedGroupEdges });
      }
      if (normalizedAppliesEdges.length > 0) {
        for (const e of normalizedAppliesEdges) {
          cache.upsert_applies_edge(e.edge_id, e.src_id, e.dst_id, e.module_data);
          liveBus.broadcast({ type: 'AppliesUpsert', edgeId: e.edge_id, srcId: e.src_id, dstId: e.dst_id, moduleData: e.module_data });
        }
      }

      // 3. Rewrite queued ops that reference batch-created temp ids (e.g. an
      //    inventory transaction queued after the batch with a temp
      //    source_record_id). Batch records never go through the per-record
      //    CreateRecord remap path, so this is their only rewrite point.
      if (Array.isArray(final.temp_ids)) {
        for (let index = 0; index < payload.records.length; index++) {
          const tempId = payload.records[index]?.tempId;
          const realId = normalizeThingString(final.temp_ids[index]);
          if (!tempId || !realId || tempId === realId) continue;
          // Mirror the single-record CreateRecord path (which calls
          // cache.remap_id locally before broadcasting): emit the remap to
          // LOCAL cache subscribers too. The livebus filters self-broadcasts
          // (live.ts: envelope.sender === senderId -> return), so without
          // this the originating tab never learns the temp->real mapping and
          // any optimistic UI keyed on the temp id can't bridge onto the real
          // id. By this point the swap (removeItem(tempId) + batch_upsert of
          // the real cores + real edges) has already happened, so remap_id is
          // a data no-op (temp id gone from items/slices/edges) — it only
          // emits TempIdRemap + bumps reactivity epochs.
          cache.remap_id(tempId, realId);
          await rewriteOplogId(tempId, realId);
          liveBus.broadcast({ type: 'TempIdRemap', tempId, realId });
        }
      }

      await deleteOp(config.storageNamespace, op.id).catch(() => {});
      publishOp(op);
      scheduleRemoveSyncOp(op.id);
      logger.debug(
        `accepted op id=${op.id} kind=CreateTreeBatch records=${cores.length} edges=${normalizedEdges.length} groupEdges=${normalizedGroupEdges.length} appliesEdges=${normalizedAppliesEdges.length}`
      );
    } catch (error) {
      failureCount++;
      op.retries++;
      inflightOps.delete(op.id);
      const retryableConflict = isRetryableSyncError(error);
      const maxRetries = retryableConflict ? Number.POSITIVE_INFINITY : MAX_RETRIES;
      const errMsg = error instanceof Error ? error.message : String(error);
      op.last_error = errMsg;
      op.last_attempt_at = Date.now();

      if (op.retries >= maxRetries) {
        op.status = 'rejected';
        // Mirror the accept-path cleanup so optimistic temp items/edges don't
        // outlive the op that created them. Without this, a rejected batch
        // would leave phantom `temp:` rows in the cache (and IDB) that no
        // subsequent reconcile will ever clear, since they're not in the
        // server's record set but also have no temp→real remap.
        for (const tempEdgeId of payload.optimisticTempEdgeIds ?? []) {
          cache.remove_graph_child(tempEdgeId);
        }
        for (const tempGroupEdgeId of payload.optimisticGroupTempEdgeIds ?? []) {
          cache.remove_graph_child(tempGroupEdgeId);
        }
        for (const tempAppliesEdgeId of payload.optimisticAppliesTempEdgeIds ?? []) {
          cache.remove_applies_edge(tempAppliesEdgeId);
        }
        for (const tempId of payload.optimisticTempIds ?? []) {
          cache.removeItem(tempId);
        }
        await persistAndPublish(op);
        logger.warn(
          `rejected op id=${op.id} kind=CreateTreeBatch${retryableConflict ? ' after repeated transaction conflicts' : ''}`,
          error
        );
      } else {
        op.status = 'pending';
        await persistAndPublish(op);
        if (retryableConflict) {
          logger.info(`retrying op id=${op.id} kind=CreateTreeBatch after transaction conflict attempt=${op.retries}`);
        } else {
          logger.warn(`retrying op id=${op.id} kind=CreateTreeBatch attempt=${op.retries}`, error);
        }
      }
    }
  }

  function buildUpdateRecordsBatchSql(
    op: Op,
    payload: UpdateRecordsBatchPayload
  ): { sql: string; vars: Record<string, unknown> } {
    const vars: Record<string, unknown> = { op_id: op.id };
    const lines: string[] = [];

    // Retry-idempotency guard (mirrors buildTreeBatchSql). A replayed batch —
    // e.g. after a transient network failure where the response was lost —
    // must not re-emit the consolidated changefeed entry. On replay every
    // touched row already carries `_sync_op_id`, so short-circuit and return
    // the current rows. (UPDATE … MERGE is itself idempotent; the guard is
    // here to keep fn::log_batch_clone from firing twice.)
    lines.push('LET $existing = (SELECT * FROM records WHERE _sync_op_id = $op_id);');
    lines.push('IF array::len($existing) > 0 {');
    lines.push('  RETURN { records: $existing, edges: [] };');
    lines.push('};');

    payload.records.forEach((record, index) => {
      const { id, ...rest } = record;
      const content = { ...rest } as Record<string, unknown>;

      // Peel `permissions` off the MERGE body for the same reason
      // build_op_vars does for single-record ops: the records-table
      // permission check compares `$perm.u = $user_id` (record vs record)
      // and JSON-serialized `u` is a string, so the MERGE is silently
      // rejected. Re-apply via a follow-up cast once the row is updated.
      let recordPerms: { r: unknown; u: string }[] | null = null;
      if (Array.isArray(content.permissions)) {
        recordPerms = normalizePermissionsForSurreal(
          content.permissions,
          `UpdateRecordsBatch.records[${index}].permissions`
        );
        delete content.permissions;
      }
      if (Array.isArray(content.additionals)) {
        content.additionals = normalizeAdditionalsForSurreal(content.additionals);
      }
      // Server-owned field — never part of a client MERGE body.
      delete (content as Record<string, unknown>).computed_additionals;
      // `id` is the UPDATE target — never part of the MERGE body (SurrealDB
      // rejects an `id` field when a specific record is targeted).
      delete (content as Record<string, unknown>).id;

      const mergeVar = `u_${index}`;
      vars[mergeVar] = {
        ...content,
        // Retry-idempotency key (NOT echo suppression — see publishOp note).
        _sync_op_id: op.id,
        // Suppress the per-row `records` changefeed event. Without this each
        // UPDATE fires records_changefeed and floods every live subscriber
        // with one RecordUpsert per updated row (the A2 anchor-template
        // flood). One consolidated fn::log_batch_clone is emitted at the
        // tail instead; skip_changefeed is cleared afterwards so later
        // normal edits ARE tracked. See LIVE SYNC ARCHITECTURE in
        // surrealdb-live.ts.
        skip_changefeed: true
      };

      const rawIdVar = `rid_${index}`;
      vars[rawIdVar] = id;
      lines.push(`  LET $rt_${index} = type::record($${rawIdVar});`);
      lines.push(`  UPDATE $rt_${index} MERGE $${mergeVar};`);
      lines.push(`  UPDATE $rt_${index} MERGE { updated: time::now() };`);
      lines.push(`  IF $${mergeVar}.additionals != NONE {`);
      lines.push(`    UPDATE $rt_${index} SET additionals = fn::fix_additional_ids($${mergeVar}.additionals);`);
      lines.push(`  };`);
      if (recordPerms && recordPerms.length > 0) {
        const permsVar = `perms_${index}`;
        vars[permsVar] = recordPerms;
        lines.push(
          `  UPDATE $rt_${index} MERGE { permissions: $${permsVar}.map(|$p| { r: $p.r, u: type::record($p.u) }) };`
        );
      }
      // NOTE: progress/duration/distance/transaction propagation is
      // deliberately NOT run here. The only caller (anchorPlannerTemplateAction)
      // only rewrites date additionals, which never change the pg/du/di/tx
      // additional set — so propagation would be a no-op, and running it per
      // row could fire ancestor `records` changefeed events that defeat the
      // single-entry batching this op exists to provide.
    });

    const recordIdRefs = payload.records.map((_, index) => `$rt_${index}`).join(', ');

    // Emit ONE consolidated changefeed entry for the whole batch (semantically
    // a batch upsert of these record rows — the client RecordBatchUpsert path
    // applies it identically to a clone). Then clear skip_changefeed so later
    // normal edits to these rows ARE tracked (the clearing UPDATE itself
    // produces no event: $before.skip_changefeed = true). SurrealDB's UPDATE
    // target must be a $var — an inline `[literal]` array is a parse error —
    // so the clear goes through $batch_record_ids.
    lines.push(`  LET $batch_record_ids = [${recordIdRefs}];`);
    lines.push(`  LET $batch_perms = (SELECT VALUE effective_permissions FROM $batch_record_ids[0])[0];`);
    lines.push(`  fn::log_batch_clone($batch_record_ids, [], [], $batch_perms);`);
    lines.push(`  UPDATE $batch_record_ids SET skip_changefeed = NONE;`);
    lines.push(
      `RETURN { records: (SELECT * FROM records WHERE id IN $batch_record_ids), edges: [] };`
    );

    return { sql: lines.join('\n'), vars };
  }

  async function runRecordsBatch(op: Op, acceptedMarkerOpIds: Set<string>): Promise<void> {
    const payload = op.payload as UpdateRecordsBatchPayload;
    if (!payload || !Array.isArray(payload.records)) {
      op.status = 'rejected';
      op.last_error = 'UpdateRecordsBatch payload missing records';
      await persistAndPublish(op);
      return;
    }
    if (payload.records.length === 0) {
      // Nothing to do — accept as a no-op without a round trip.
      op.status = 'accepted';
      op.updated = Date.now();
      oplog = oplog.filter(o => o.id !== op.id);
      await persistAndPublish(op);
      await deleteOp(config.storageNamespace, op.id).catch(() => {});
      publishOp(op);
      scheduleRemoveSyncOp(op.id);
      return;
    }

    op.status = 'inflight';
    op.last_attempt_at = Date.now();
    op.last_error = undefined;
    publishOp(op);
    inflightOps.set(op.id, op);

    try {
      const { sql, vars } = buildUpdateRecordsBatchSql(op, payload);
      const token = await resolveToken(config);
      const statement = buildSurrealStatement(sql, vars);
      let response = await fetchWithTimeout(`${config.url}/sql`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'text/plain',
          'surreal-ns': config.namespace,
          'surreal-db': config.database,
          'authorization': `Bearer ${token}`
        },
        body: statement
      });

      if (response.status === 401 && config.getToken) {
        logger.warn(`401 on batch op ${op.id}; retrying with fresh token`);
        const freshToken = await config.getToken();
        response = await fetchWithTimeout(`${config.url}/sql`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'text/plain',
            'surreal-ns': config.namespace,
            'surreal-db': config.database,
            'authorization': `Bearer ${freshToken}`
          },
          body: statement
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`UpdateRecordsBatch HTTP ${response.status} body: ${body.slice(0, 800)}`);
        logger.debug(`UpdateRecordsBatch failing SQL:\n${statement.slice(0, 1500)}`);
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      const resJson = await response.json();
      const evaluation = evaluate_sql_response(resJson);
      const final = extractBatchResult(evaluation.statements);
      if (!final) throw new Error('UpdateRecordsBatch: response missing records');

      const cores: any[] = [];
      for (const rec of final.records) {
        if (!rec || typeof rec !== 'object') continue;
        const realId = normalizeThingString((rec as any).id);
        if (!realId) continue;
        const r = rec as any;
        cores.push({
          ...r,
          id: realId,
          created: typeof r.created === 'string' ? r.created : (r.created != null ? String(r.created) : undefined),
          updated: typeof r.updated === 'string' ? r.updated : (r.updated != null ? String(r.updated) : undefined),
          is_temp: false,
          dirty: false,
          sync_status: 'accepted'
        });
      }

      op.status = 'accepted';
      op.updated = Date.now();
      inflightOps.delete(op.id);
      oplog = oplog.filter(o => o.id !== op.id);
      failureCount = 0;
      acceptedMarkerOpIds.add(op.id);
      await persistAndPublish(op);

      // Reconcile the optimistic local cache writes with the server-confirmed
      // rows (source of truth). ids are real — no temp remap needed.
      if (cores.length > 0) {
        cache.batch_upsert(cores);
        liveBus.broadcast({ type: 'RecordBatchUpsert', cores });
      }

      await deleteOp(config.storageNamespace, op.id).catch(() => {});
      publishOp(op);
      scheduleRemoveSyncOp(op.id);
      logger.debug(`accepted op id=${op.id} kind=UpdateRecordsBatch records=${cores.length}`);
    } catch (error) {
      failureCount++;
      op.retries++;
      inflightOps.delete(op.id);
      const retryableConflict = isRetryableSyncError(error);
      const maxRetries = retryableConflict ? Number.POSITIVE_INFINITY : MAX_RETRIES;
      const errMsg = error instanceof Error ? error.message : String(error);
      op.last_error = errMsg;
      op.last_attempt_at = Date.now();

      if (op.retries >= maxRetries) {
        op.status = 'rejected';
        await persistAndPublish(op);
        logger.warn(
          `rejected op id=${op.id} kind=UpdateRecordsBatch${retryableConflict ? ' after repeated transaction conflicts' : ''}`,
          error
        );
      } else {
        op.status = 'pending';
        await persistAndPublish(op);
        if (retryableConflict) {
          logger.info(`retrying op id=${op.id} kind=UpdateRecordsBatch after transaction conflict attempt=${op.retries}`);
        } else {
          logger.warn(`retrying op id=${op.id} kind=UpdateRecordsBatch attempt=${op.retries}`, error);
        }
      }
    }
  }

  async function executePush(initialPending: Op[]): Promise<void> {
    let pending = [...initialPending];
    let madeProgress = true;
    const acceptedMarkerOpIds = new Set<string>();

    while (madeProgress && pending.length > 0) {
      madeProgress = false;
      const currentBatch = [...pending];
      pending = [];

      for (const op of currentBatch) {
      if (op.kind === 'CreateTreeBatch') {
        // Defer if the batch references temp ids it does not itself create
        // (e.g. a purchase batch pointing at a stock item from a pending
        // CreateRecord); the remap rewrite will resolve them.
        const batchPayload = op.payload as CreateTreeBatchPayload | undefined;
        const ownTempIds = new Set(
          (batchPayload?.records ?? []).map((record) => record.tempId)
        );
        const unresolvedBatchTempIds = Array.from(
          collect_temp_reference_ids(op.payload)
        ).filter((tempId) => !ownTempIds.has(tempId));
        if (unresolvedBatchTempIds.length > 0) {
          const lastError = `waiting for temp ids: ${unresolvedBatchTempIds.join(', ')}`;
          const alreadyDeferred = op.status === 'pending' && op.last_error === lastError;
          op.status = 'pending';
          op.last_error = lastError;
          if (!alreadyDeferred) {
            await persistAndPublish(op);
            logger.debug(
              `deferred op id=${op.id} kind=${op.kind}; waiting for temp ids ${unresolvedBatchTempIds.join(', ')}`
            );
          }
          pending.push(op);
          continue;
        }
        await runTreeBatch(op, acceptedMarkerOpIds);
        continue;
      }

      if (op.kind === 'UpdateRecordsBatch') {
        await runRecordsBatch(op, acceptedMarkerOpIds);
        continue;
      }

      const unresolvedTempIds =
        op.kind === 'CreateRecord' ? [] : Array.from(collect_temp_reference_ids(op.payload));
      if (unresolvedTempIds.length > 0) {
        const lastError = `waiting for temp ids: ${unresolvedTempIds.join(', ')}`;
        const alreadyDeferred = op.status === 'pending' && op.last_error === lastError;
        op.status = 'pending';
        op.last_error = lastError;
        if (!alreadyDeferred) {
          await persistAndPublish(op);
          logger.debug(
            `deferred op id=${op.id} kind=${op.kind}; waiting for temp ids ${unresolvedTempIds.join(', ')}`
          );
        }
        pending.push(op);
        continue;
      }

      const sql = build_op_sql(op);
      if (!sql) {
        op.status = 'rejected';
        op.last_error = `unknown op kind: ${op.kind}`;
        await persistAndPublish(op);
        continue;
      }

      op.status = 'inflight';
      op.last_attempt_at = Date.now();
      op.last_error = undefined;
      publishOp(op);
      inflightOps.set(op.id, op);

      try {
        const token = await resolveToken(config);
        const statement = buildSurrealStatement(sql, build_op_vars(op));
        let response = await fetchWithTimeout(`${config.url}/sql`, {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'text/plain',
            'surreal-ns': config.namespace,
            'surreal-db': config.database,
            'authorization': `Bearer ${token}`
          },
          body: statement
        });

        // 401 retry: resolve a fresh token and retry once
        if (response.status === 401 && config.getToken) {
          logger.warn(`401 on op ${op.id}; retrying with fresh token`);
          const freshToken = await config.getToken();
          response = await fetchWithTimeout(`${config.url}/sql`, {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'content-type': 'text/plain',
              'surreal-ns': config.namespace,
              'surreal-db': config.database,
              'authorization': `Bearer ${freshToken}`
            },
            body: statement
          });
        }

        if (response.ok) {
          const resJson = await response.json();
          const evaluation = evaluate_sql_response(resJson);
          op.status = 'accepted';
          op.updated = Date.now();
          inflightOps.delete(op.id);
          oplog = oplog.filter(o => o.id !== op.id);
          failureCount = 0;
          if (shouldStampMarker(op.kind)) {
            acceptedMarkerOpIds.add(op.id);
          }
          // Persist the accepted terminal state before any async remap work.
          // Otherwise another runtime/tab can reload this same op from IDB as
          // pending/inflight and replay a non-idempotent create while this
          // instance is still rewriting temp references.
          await persistAndPublish(op);

          // 1. Authoritative Temp Remapping
          if (op.kind === 'CreateRecord') {
            const newId = evaluation.createdRecordId;
            const oldId = extractTargetId(op.payload);
            if (newId && oldId && typeof newId === 'string' && oldId !== newId) {
              cache.remap_id(oldId, newId);
              await rewriteOplogId(oldId, newId);
              liveBus.broadcast({ type: 'TempIdRemap', tempId: oldId, realId: newId });
              madeProgress = true;
            }
          }

          // 1b. DeleteTree confirmed — remove the record locally now that the
          // server has deleted it. Callers no longer remove optimistically at
          // queue time (so a pending delete can show its indicator and can't be
          // resurrected by a refetch racing server indexing), so this accept is
          // the authoritative local removal. The originating tab's own
          // live-stream echo is filtered, so relying on it would leave the row
          // until a refresh; other tabs/devices still get the changefeed delete.
          if (op.kind === 'DeleteTree') {
            const delId = extractTargetId(op.payload);
            if (delId) cache.removeItem(delId);
          }

          // 2. Feedback Accepted
          const targetId = selectAcceptedTargetId(op, evaluation.createdRecordId);
          if (targetId) cache.update_sync_status?.(targetId, 'accepted');
          const returnedRecord = extract_returned_record(evaluation.statements);
          if (returnedRecord && typeof returnedRecord.id === 'string' && returnedRecord.id.startsWith('records:')) {
            const rr = returnedRecord as any;
            const core = {
              ...rr,
              id: returnedRecord.id,
              created: typeof rr.created === 'string' ? rr.created : (rr.created != null ? String(rr.created) : undefined),
              updated: typeof rr.updated === 'string' ? rr.updated : (rr.updated != null ? String(rr.updated) : undefined),
              is_temp: false,
              dirty: false,
              sync_status: 'accepted'
            } as any;
            cache.normalizeItem(core);
            liveBus.broadcast({ type: 'RecordUpsert', core });
          }
          const returnedEdge = normalizeReturnedGraphEdge(returnedRecord);
          if (returnedEdge) {
            cache.upsert_graph_child_of_edge(
              returnedEdge.edge_id,
              returnedEdge.child_id,
              returnedEdge.parent_id,
              returnedEdge.order,
              returnedEdge.is_key_parent,
              returnedEdge.module_data
            );
            liveBus.broadcast({ type: 'GraphChildUpsert', edge: returnedEdge });
          }

          // Drop from durable queue; keep in reactive store briefly so UI can show completion.
          await deleteOp(config.storageNamespace, op.id).catch(() => {});
          publishOp(op);
          scheduleRemoveSyncOp(op.id);
          logger.debug(`accepted op id=${op.id} kind=${op.kind}`);
        } else {
          throw new Error(`Sync failed: ${response.statusText}`);
        }
      } catch (error) {
        failureCount++;
        op.retries++;
        inflightOps.delete(op.id);
        const targetId = extractTargetId(op.payload);
        const retryableConflict = isRetryableSyncError(error);
        const maxRetries = retryableConflict ? Number.POSITIVE_INFINITY : MAX_RETRIES;
        const errMsg = error instanceof Error ? error.message : String(error);
        op.last_error = errMsg;
        op.last_attempt_at = Date.now();

        if (op.retries >= maxRetries) {
          op.status = 'rejected';
          if (targetId) cache.update_sync_status?.(targetId, 'rejected');
          // Drop optimistic temp rows that the rejected op had spawned: a
          // temp:* record (from CreateRecord) or a temp-edge:* edge (from
          // AddChild) will never receive a temp→real remap, so without
          // explicit cleanup they sit in the cache/IDB forever and look like
          // ghost items on next page load.
          rollbackOptimisticForRejection(op);
          await persistAndPublish(op);
          logger.warn(
            `rejected op id=${op.id} kind=${op.kind}${retryableConflict ? ' after repeated transaction conflicts' : ''}`,
            error
          );
        } else {
          op.status = 'pending';
          if (targetId) cache.update_sync_status?.(targetId, 'pending');
          await persistAndPublish(op);
          if (retryableConflict) {
            logger.info(`retrying op id=${op.id} kind=${op.kind} after transaction conflict attempt=${op.retries}`);
          } else {
            logger.warn(`retrying op id=${op.id} kind=${op.kind} attempt=${op.retries}`, error);
          }
        }
        }
      }
    }

    await cleanupSyncMarkers(Array.from(acceptedMarkerOpIds));
  }

  function shouldStampMarker(kind: OpKind): boolean {
    return (
      kind === 'CreateRecord' ||
      kind === 'UpdateRecord' ||
      kind === 'AddChild' ||
      kind === 'MoveChild' ||
      kind === 'UpdateEdge' ||
      kind === 'AddGrouping' ||
      kind === 'AddApplies'
    );
  }

  /**
   * Post-accept GC of the `_sync_op_id` retry-idempotency key. This is NOT
   * echo suppression (that machinery was removed with the changefeed switch).
   * It only runs AFTER an op is accepted — by which point the op is off the
   * queue and can never be retried — so it cannot race the idempotency window
   * (`$existing` guards in buildTreeBatchSql / build_op_sql). Its sole purpose
   * now is to stop `_sync_op_id` accumulating on every record forever.
   * `changes` has no DEFINE EVENT and these fields aren't in any changefeed
   * `$has_real_change` set, so this UPDATE produces no changefeed entries.
   */
  async function cleanupSyncMarkers(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return;
    const vars: Record<string, unknown> = { op_ids: opIds };
    const sql = `
      UPDATE records UNSET _sync_op_id WHERE _sync_op_id IN $op_ids;
      UPDATE graph_child_of UNSET _sync_op_id WHERE _sync_op_id IN $op_ids;
      UPDATE groups UNSET _sync_op_id WHERE _sync_op_id IN $op_ids;
    `;
    try {
      const token = await resolveToken(config);
      const statement = buildSurrealStatement(sql, vars);
      const response = await fetchWithTimeout(`${config.url}/sql`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'text/plain',
          'surreal-ns': config.namespace,
          'surreal-db': config.database,
          authorization: `Bearer ${token}`
        },
        body: statement
      });
      if (response.ok) {
        logger.debug(`cleaned up sync markers for ${opIds.length} op(s)`);
      } else {
        logger.warn(`sync marker cleanup HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      }
    } catch (e) {
      logger.warn('sync marker cleanup failed', e);
    }
  }

  function rollbackOptimisticForRejection(op: Op): void {
    const payload = op.payload as Record<string, unknown> | undefined;
    if (!payload) return;
    const targetId = typeof payload.id === 'string' ? payload.id : undefined;
    if (op.kind === 'CreateRecord' && targetId && targetId.startsWith('temp:')) {
      cache.removeItem?.(targetId);
      return;
    }
    if (op.kind === 'AddChild') {
      // AddChild's edge id is server-generated; the caller writes an
      // optimistic edge under a `temp-edge:` synthetic id which is carried
      // in the payload's `id` field when present, otherwise via `optimisticEdgeId`.
      const optimisticEdgeId =
        (typeof payload.optimisticEdgeId === 'string' && payload.optimisticEdgeId) ||
        (typeof targetId === 'string' && targetId.startsWith('temp-edge:') ? targetId : undefined);
      if (optimisticEdgeId) cache.remove_graph_child?.(optimisticEdgeId);
      return;
    }
    if ((op.kind === 'AddGrouping' || op.kind === 'AddApplies') &&
        typeof payload.optimisticEdgeId === 'string') {
      cache.remove_graph_child?.(payload.optimisticEdgeId);
    }
  }

  function extractTargetId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
      return undefined;
    }

    const candidate = payload as {
      id?: unknown;
      src?: unknown;
    };

    if (typeof candidate.id === 'string' && candidate.id.length > 0) {
      return candidate.id;
    }

    if (typeof candidate.src === 'string' && candidate.src.length > 0) {
      return candidate.src;
    }

    return undefined;
  }

  /**
   * Rewrite all references to oldId → newId in the oplog.
   * Uses a 2-pass approach (ported from wisewords) to catch ops that may have
   * been queued during the async remap window.
   */
  async function rewriteOplogId(oldId: string, newId: string) {
    // Pass 1: rewrite the in-memory oplog snapshot
    const snapshot = [...oplog];
    const persistPromises: Promise<void>[] = [];
    for (const op of snapshot) {
      if (!op.payload) continue;
      const changed = rewrite_reference_ids(op.payload, oldId, newId);
      if (changed) {
        persistPromises.push(persistAndPublish(op).catch((e) => logger.error('failed to rewrite op', e)));
      }
    }

    // Pass 2: re-read from IDB to catch ops queued during the async window above
    try {
      const [postRemapOps] = await Promise.all([
        loadPendingOps(config.storageNamespace),
        ...persistPromises
      ]);
      const hasStale = postRemapOps.some(
        e => e.payload && has_reference_id(e.payload, oldId)
      );
      if (hasStale) {
        logger.warn(`found stale temp_id ${oldId} after remap pass 1, re-remapping`);
        // Re-read current oplog (may have new entries since snapshot)
        const rewritePromises: Promise<void>[] = [];
        for (const op of oplog) {
          if (!op.payload) continue;
          const changed = rewrite_reference_ids(op.payload, oldId, newId);
          if (changed) {
            rewritePromises.push(persistAndPublish(op).catch((e) => logger.error('failed to rewrite op (pass 2)', e)));
          }
        }
        await Promise.all(rewritePromises);
      }
    } catch (e) {
      logger.error('failed second-pass remap check', e);
    }
  }

  function build_op_sql(op: Op): string {
    switch (op.kind) {
      case 'CreateRecord':
        // The follow-up `IF $perms != NONE { UPDATE … }` exists to work around
        // a SurrealDB schema/permission interaction: the records table's
        // permission check (see `surql/manual/permissions_cache/definitions.surql`
        // — `fn::has_perm` etc.) compares `$perm.u = $user_id` where `$user_id`
        // is a record. JSON serialization of our payload makes `u` a string
        // ("user:abc"), so the comparison silently fails and the CREATE is
        // rejected with no error (returns `[]`). Cast each `u` to a record
        // via a follow-up MERGE — by then the row exists, so the check uses
        // the inherited/cached effective_permissions instead of the new array.
        // `build_op_vars` peels `permissions` off into the `$perms` var so the
        // first CREATE doesn't trip the same check.
        return `
          LET $existing = (SELECT * FROM records WHERE _sync_op_id = $op_id LIMIT 1)[0];
          IF $existing != NONE {
            RETURN $existing;
          };
          LET $created = (CREATE records CONTENT $payload)[0];
          UPDATE $created.id MERGE { created: time::now(), updated: time::now() };
          IF $created.additionals != NONE {
            UPDATE $created.id SET additionals = fn::fix_additional_ids($created.additionals);
            fn::recompute_computed_additionals($created.id);
          };
          IF $perms != NONE AND $perms != NULL AND array::len($perms) > 0 {
            UPDATE $created.id MERGE { permissions: $perms.map(|$p| { r: $p.r, u: type::record($p.u) }) };
          };
          RETURN (SELECT * FROM ONLY $created.id)
        `;
      case 'UpdateRecord':
        // Same `permissions[*].u` cast as CreateRecord — see comment above.
        // When additionals are touched, run progress propagation in the same
        // round trip so computed ancestors recalculate atomically. Server-side
        // events don't fire on records UPDATE by design (see progress.surql),
        // so this call is the only thing that keeps computed parents in sync.
        // Additionals travel OUTSIDE $payload ($incoming_additionals /
        // $removed_additional_ids, peeled in build_op_vars): the leading
        // MERGE $payload must never whole-array overwrite the stored array —
        // fn::merge_additionals applies the per-id tombstone merge instead
        // (upserts by id + explicit removals; omission never deletes).
        return `
          LET $before_additionals = (SELECT VALUE additionals FROM type::record($id))[0];
          UPDATE type::record($id) MERGE $payload;
          UPDATE type::record($id) MERGE { updated: time::now() };
          IF $incoming_additionals != NONE OR $removed_additional_ids != NONE {
            UPDATE type::record($id) SET additionals = fn::merge_additionals(
              additionals,
              IF $incoming_additionals = NONE { [] } ELSE { fn::fix_additional_ids($incoming_additionals) },
              $removed_additional_ids
            );
          };
          IF $perms != NONE AND $perms != NULL AND array::len($perms) > 0 {
            UPDATE type::record($id) MERGE { permissions: $perms.map(|$p| { r: $p.r, u: type::record($p.u) }) };
          };
          IF $incoming_additionals != NONE OR $removed_additional_ids != NONE {
            LET $after_additionals = (SELECT VALUE additionals FROM type::record($id))[0];
            fn::recompute_computed_additionals(type::record($id));
            fn::propagate_progress_change(type::record($id));
            fn::propagate_duration_change(type::record($id));
            fn::propagate_distance_change(type::record($id));
            fn::propagate_stock_level_change(type::record($id));
            fn::propagate_transaction_balance_from_additionals(
              type::record($id),
              $before_additionals,
              $after_additionals
            );
          };
          RETURN (SELECT * FROM ONLY type::record($id))
        `;
      case 'AddChild':
        return `
          LET $c = type::record($child);
          LET $p = type::record($parent);
          LET $existing = (
            SELECT VALUE id FROM graph_child_of
            WHERE in = $c AND out = $p
            LIMIT 1
          )[0];
          IF $existing != NONE {
            RETURN (UPDATE $existing MERGE $payload);
          };
          RELATE $c->graph_child_of->$p CONTENT $payload
        `;
      case 'DeleteTree':
        return `
          fn::delete_and_children(type::record($id));
        `;
      case 'RemoveChild':
        return 'DELETE type::record($id)';
      case 'MoveChild':
        // The edge `out` field is a record reference on a SCHEMAFULL relation
        // table; a plain MERGE with a string value won't coerce, so cast via
        // type::record. SET also preserves the in/out semantics (in=child,
        // out=parent for graph_child_of) — overwriting `in` here would
        // silently corrupt the edge by replacing its child.
        //
        // `$payload.out` is NOT used: SurrealQL's `.out` is the graph-traversal
        // operator, so accessing it as a field on a JSON variable parses
        // ambiguously and silently fails to update the edge. The new parent
        // and order are hoisted to top-level vars ($out, $order) in
        // build_op_vars to sidestep the lexer entirely.
        return `
          UPDATE type::record($id) SET
            out = type::record($out),
            order = $order,
            _sync_op_id = $op_id
        `;
      case 'AddGrouping':
        return `
          LET $s = type::record($src);
          LET $d = type::record($dst);
          LET $existing = (SELECT * FROM groups WHERE in = $s AND out = $d LIMIT 1)[0];
          IF $existing != NONE {
            RETURN $existing;
          };
          RELATE $s->groups->$d CONTENT $payload
        `;
      case 'RemoveGrouping':
        return 'DELETE type::record($id)';
      case 'AddApplies':
        return 'LET $s = type::record($src); LET $d = type::record($dst); RELATE $s->applies->$d CONTENT $payload';
      case 'RemoveApplies':
        return 'DELETE type::record($id)';
      case 'UpdateEdge':
        return 'UPDATE type::record($id) MERGE $payload';
      default:
        return '';
    }
  }

  function build_op_vars(op: Op): Record<string, unknown> {
    const payload = op.payload as Record<string, unknown> | undefined;
    const sanitized = { ...payload };

    // Peel `permissions` off the payload so CREATE / UPDATE MERGE doesn't
    // include the string-shaped `u` field that fails the records-table
    // permission check (see comment in `build_op_sql` for `CreateRecord`).
    // The follow-up cast happens in SQL via `$perms` after the row exists.
    let perms: unknown = undefined;
    let incomingAdditionals: unknown = undefined;
    let removedAdditionalIds: unknown = undefined;
    if (op.kind === 'CreateRecord' || op.kind === 'UpdateRecord') {
      if (Array.isArray(sanitized.permissions)) {
        perms = normalizePermissionsForSurreal(sanitized.permissions, `${op.kind}.permissions`);
        delete sanitized.permissions;
      }
      if (Array.isArray(sanitized.additionals)) {
        sanitized.additionals = normalizeAdditionalsForSurreal(sanitized.additionals);
      }
      // computed_additionals is server-owned: a client copy in the payload
      // would be persisted verbatim by CREATE / UPDATE MERGE and clobber the
      // server's rollup values. Never send it.
      delete sanitized.computed_additionals;
    }
    if (op.kind === 'UpdateRecord') {
      // Peel additionals OUT of the MERGE body: the leading `UPDATE … MERGE
      // $payload` would whole-array overwrite before fn::merge_additionals
      // runs. They travel as dedicated vars instead (see build_op_sql).
      if (Array.isArray(sanitized.additionals)) {
        incomingAdditionals = sanitized.additionals;
        delete sanitized.additionals;
      }
      if (Array.isArray(sanitized.removed_additional_ids)) {
        removedAdditionalIds = (sanitized.removed_additional_ids as unknown[]).map(String);
        delete sanitized.removed_additional_ids;
      }
    }

    if (op.kind === 'CreateRecord') {
      delete sanitized.id;
      delete sanitized.is_temp;
      delete sanitized.sync_status;
    }

    if (op.kind === 'DeleteTree') {
      if (typeof payload?.id !== 'string' || !payload.id.startsWith('records:')) {
        throw new Error('DeleteTree requires a records:* id');
      }
    }

    if (op.kind === 'RemoveChild') {
      if (typeof payload?.id !== 'string' || !payload.id.startsWith('graph_child_of:')) {
        throw new Error('RemoveChild requires a graph_child_of:* edge id');
      }
    }

    if (op.kind === 'AddChild') {
      delete sanitized.id;
      delete sanitized.parent;
      delete sanitized.child;
    }

    // For UPDATE … MERGE ops the target record is already specified via
    // `type::record($id)`; including `id` inside the merge body causes
    // SurrealDB to reject with "Found '<id>' for the `id` field, but a
    // specific record has been specified". Strip it from the merge payload.
    if (op.kind === 'UpdateRecord' || op.kind === 'MoveChild' || op.kind === 'UpdateEdge') {
      delete sanitized.id;
    }

    // RELATE … CONTENT $payload likewise can't carry an id for the edge
    // record (SurrealDB generates it), nor the in/out references we've
    // already inlined via $src/$dst/$child/$parent.
    if (op.kind === 'AddGrouping' || op.kind === 'AddApplies') {
      delete sanitized.id;
      delete sanitized.src;
      delete sanitized.dst;
    }

    // Tag every upsert payload with the originating op id so the LIVE
    // subscription can drop our own write echoes. DELETE ops have no
    // content body, so they're handled separately via the own-id set.
    if (
      op.kind === 'CreateRecord' ||
      op.kind === 'UpdateRecord' ||
      op.kind === 'AddChild' ||
      op.kind === 'MoveChild' ||
      op.kind === 'UpdateEdge' ||
      op.kind === 'AddGrouping' ||
      op.kind === 'AddApplies'
    ) {
      sanitized._sync_op_id = op.id;
    }

    return {
      payload: sanitized,
      id: payload?.id,
      src: payload?.src,
      dst: payload?.dst,
      parent: payload?.parent,
      child: payload?.child,
      // MoveChild hoists out/order to top-level vars so the SurrealQL doesn't
      // have to access `$payload.out` — SurrealQL's `.out` parses as the
      // graph-traversal operator, which made the previous version silently
      // no-op the field update and only persist the side-effect of bumping
      // order/_sync_op_id (i.e. the move appeared local-only and reverted on
      // refresh).
      out: payload?.out,
      order: payload?.order,
      op_id: op.id,
      perms,
      incoming_additionals: incomingAdditionals,
      removed_additional_ids: removedAdditionalIds
    };
  }

  function applyRemote(msg: LiveBusMsg) {
    switch (msg.type) {
      case 'RecordUpsert':
        cache.normalizeItem(msg.core);
        break;
      case 'RecordDelete':
        cache.removeItem(msg.id);
        break;
      case 'RecordBatchUpsert':
        cache.batch_upsert(msg.cores);
        break;
      case 'RecordBatchDelete':
        cache.batch_delete(msg.ids);
        break;
      case 'GraphChildUpsert':
        {
          const existing = cache.childrenEdges.get(msg.edge.edge_id);
          const parentId = msg.edge.parent_id || existing?.parent_id;
          const childId = msg.edge.child_id || existing?.child_id;
          if (!parentId || !childId) {
            break;
          }

        cache.upsert_graph_child_of_edge(
          msg.edge.edge_id,
          childId,
          parentId,
          Number.isFinite(msg.edge.order) ? msg.edge.order : (existing?.order ?? 0),
          typeof msg.edge.is_key_parent === 'boolean' ? msg.edge.is_key_parent : (existing?.is_key_parent ?? true),
          msg.edge.module_data ?? existing?.module_data,
          msg.edge.clone_setting ?? existing?.clone_setting ?? null
        );
        }
        break;
      case 'GraphChildDelete':
        cache.remove_graph_child(msg.edgeId);
        break;
      case 'GraphChildBatchUpsert':
        cache.begin_children_batch();
        try {
          for (const edge of msg.edges) {
            cache.upsert_graph_child_of_edge(
              edge.edge_id,
              edge.child_id,
              edge.parent_id,
              edge.order,
              edge.is_key_parent,
              edge.module_data,
              edge.clone_setting ?? null
            );
          }
        } finally {
          cache.end_children_batch();
        }
        break;
      case 'GraphChildBatchDelete':
        for (const edgeId of msg.edgeIds) {
          cache.remove_graph_child(edgeId);
        }
        break;
      case 'TempIdRemap':
        cache.remap_id(msg.tempId, msg.realId);
        void rewriteOplogId(msg.tempId, msg.realId);
        break;
      case 'RecordPatchText':
        cache.patch_item_text(msg.id, msg.text);
        break;
      case 'RecordPatchColor':
        cache.patch_item_color(msg.id, msg.color);
        break;
      case 'RecordPatchHeader':
        cache.patch_item_header(msg.id, msg.isHeader);
        break;
      case 'RecordPatchModuleSettings':
        cache.patch_item_module_settings(msg.id, msg.moduleSettings);
        break;
      case 'RecordPatchAdditionals':
        if (msg.merge) {
          // Merge-shaped optimistic patch (mirrors fn::merge_additionals):
          // upsert by id into the cached array, then apply explicit removals.
          // The cache patch itself stays full-array.
          const cached = cache.getItem(msg.id) as { additionals?: AdditionalWithId[] } | undefined;
          cache.patch_item_additionals(
            msg.id,
            mergeAdditionalsLocal(cached?.additionals, msg.additionals, msg.removedIds ?? [])
          );
        } else {
          cache.patch_item_additionals(msg.id, msg.additionals);
        }
        break;
      case 'RecordSyncStatus':
        cache.update_sync_status(msg.id, msg.status as any);
        break;
      case 'OpUpsert':
        setSyncOp(config.storageNamespace, msg.op);
        break;
      case 'OpRemove':
        removeSyncOp(config.storageNamespace, msg.id);
        break;
      case 'AppliesUpsert':
        {
          const existing = cache.appliesEdges.get(msg.edgeId);
          const srcId = msg.srcId || existing?.src_id;
          const dstId = msg.dstId || existing?.dst_id;
          if (!srcId || !dstId) {
            break;
          }

          cache.upsert_applies_edge(msg.edgeId, srcId, dstId, msg.moduleData ?? existing?.module_data);
        }
        break;
      case 'AppliesDelete':
        cache.remove_applies_edge(msg.edgeId);
        break;
      case 'GraphChildModuleDataPatch':
      case 'ChildMove':
      case 'TempRecordCreate':
      case 'SyncWake':
      case 'RequestLeadership':
      case 'RpcRequest':
      case 'RpcResponse':
        break;
      default:
        assertNever(msg);
    }
  }

  liveBus.onMessage((msg) => {
    applyRemote(msg);
  });

  function startSyncLoop(intervalMs = 30000) {
    initialize();

    // Adaptive idle backoff: when consecutive polls find no pending ops,
    // grow the polling interval up to IDLE_MAX_MS (mirrors wisewords
    // sync/manager.rs idle_no_change_pulls behaviour). Activity resets it.
    const IDLE_MAX_MS = 5 * MINUTE_MS; // 5 minutes ceiling
    let idlePolls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let tickInFlight = false;

    function nextDelay(): number {
      if (idlePolls === 0) return intervalMs;
      // Double the base interval per consecutive idle poll, up to the cap.
      const grown = intervalMs * Math.pow(2, Math.min(idlePolls, 6));
      return Math.min(grown, IDLE_MAX_MS);
    }

    function schedule() {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(tick, nextDelay());
    }

    async function tick() {
      timer = null;
      if (stopped) return;
      tickInFlight = true;
      const beforeCount = oplog.filter(op => op.status === 'pending').length;
      try {
        await pushOps();
      } catch (e) {
        logger.warn('sync loop tick failed', e);
      }
      // If there was nothing to push and nothing failed, count this as an idle poll.
      // Any activity (pending ops drained, failures, retries) resets the counter.
      const afterCount = oplog.filter(op => op.status === 'pending').length;
      if (beforeCount === 0 && afterCount === 0 && failureCount === 0) {
        idlePolls++;
      } else {
        idlePolls = 0;
      }
      tickInFlight = false;
      schedule();
    }

    // Eagerly push when connectivity is restored instead of waiting for poll
    function handleOnline() {
      failureCount = 0; // Reset backoff logic intentionally to clear queue
      idlePolls = 0;    // Wake the loop out of idle backoff
      pushOps();
      // Re-arm the next tick at the base interval (no-op if a tick is in flight;
      // its end-of-tick schedule() call will use idlePolls=0).
      if (!tickInFlight) schedule();
    }

    function wake() {
      if (stopped) return;
      idlePolls = 0;
      // If a tick is currently in flight, its end-of-tick schedule() will
      // pick up the reset idlePolls. Avoid double-scheduling here.
      if (!tickInFlight) schedule();
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }

    schedule();
    syncLoopWake = wake;

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
      }
      if (syncLoopWake === wake) {
        syncLoopWake = null;
      }
    };
  }


  function getPendingOps(): Op[] {
    return oplog.filter(op => op.status === 'pending');
  }

  function getInflightOps(): Op[] {
    return Array.from(inflightOps.values());
  }

  return {
    queueOp,
    pushOps,
    initialize,
    applyRemote,
    startSyncLoop,
    getPendingOps,
    getInflightOps,
    get isRunning() { return syncPromise !== null; },
    get failureCount() { return failureCount; }
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
