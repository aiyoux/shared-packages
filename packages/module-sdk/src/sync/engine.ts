import type { Op, OpKind, CreateTreeBatchPayload, UpdateRecordsBatchPayload, UpdateRelationsBatchPayload, CloneSetting } from '../cache/types.ts';
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
import { markSyncHealthy, markSyncDegraded, markSyncOffline } from './sync-health.svelte.ts';

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
  /**
   * Optional override for the push-scheduler concurrency cap (default 4). Escape
   * hatch for runtimes expected to push a lot of independent ops; the default
   * is intentionally conservative to avoid storming the server or exhausting
   * mobile connection pools.
   */
  pushConcurrency?: number;
}

async function resolveToken(config: SyncEngineConfig): Promise<string> {
  if (config.getToken) return config.getToken();
  return config.token;
}

function generate_op_id(): string {
  return `op_${crypto.randomUUID()}`;
}

export const SYNC_PUSH_TIMEOUT_MS = 30_000;

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

interface ConflictMarker {
  current: Record<string, unknown> | null;
  deleted: boolean;
  conflictedFields?: string[];
}

/**
 * Scans a successful (non-error) SQL response for the `{ conflict: true, ... }`
 * business-logic marker `build_op_sql`'s field-stamps CAS check RETURNs for
 * UpdateRecord/DeleteTree. This is NOT an error path — evaluate_sql_response
 * already ran and found no statement-level error — it's a normal 200 whose
 * payload says "not applied, here's why." Checked from the END of the
 * statements array, mirroring extract_returned_record, since the conflict
 * RETURN (when present) is the block's final statement.
 */
function extractConflictMarker(statements: SurrealSqlStatement[]): ConflictMarker | null {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    const result = statements[index].result;
    if (result && typeof result === 'object' && !Array.isArray(result) && (result as { conflict?: unknown }).conflict === true) {
      const marker = result as { current?: unknown; deleted?: unknown; conflicted_fields?: unknown };
      return {
        current: marker.current && typeof marker.current === 'object' ? (marker.current as Record<string, unknown>) : null,
        deleted: marker.deleted === true,
        conflictedFields: Array.isArray(marker.conflicted_fields) ? marker.conflicted_fields.map(String) : undefined
      };
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

/**
 * True for errors that mean "we couldn't reach the server" — a failed
 * `fetch()`, an aborted request (the 30s `fetchWithTimeout` circuit-breaker),
 * or an offline browser — as opposed to a genuine server-side rejection (bad
 * SQL, validation, 4xx). These must retry forever, like `isRetryableSyncError`
 * conflicts: an op queued while offline used to burn all `MAX_RETRIES`
 * attempts in ~2.5 minutes of backoff and get permanently REJECTED (with its
 * optimistic rows rolled back) even though the user simply hadn't reconnected
 * yet. Must be called with the raw caught error (not a persisted string) —
 * classification relies on `instanceof`/`.name`, which only survive at the
 * original catch site.
 */
export function isNetworkSyncError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'AbortError') return true;
  // fetch() rejects with a TypeError for network-level failures (DNS,
  // connection refused, offline) — never for a bug in our own code, which
  // would not originate from the fetchWithTimeout() call sites that raise
  // these.
  if (error instanceof TypeError) return true;
  return false;
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

/**
 * Collect EVERY reference-slot string in a payload (temp or real). These are
 * the "structural keys" the push scheduler uses for same-target FIFO ordering:
 * queued ops whose key sets intersect run in queue order relative to each
 * other, while disjoint ops push concurrently. Over-collection is safe (it
 * only adds ordering); under-collection is not — so this reuses the same
 * ref-slot traversal as the temp-id remapper rather than a per-kind key list.
 */
function collect_reference_ids(value: unknown, found = new Set<string>(), scope: RefScope = 'default'): Set<string> {
  if (!value || typeof value !== 'object') {
    return found;
  }

  if (Array.isArray(value)) {
    if (scope === 'refs') {
      for (const entry of value) {
        if (typeof entry === 'string' && entry.length > 0) found.add(entry);
      }
    }
    for (const entry of value) {
      collect_reference_ids(entry, found, scope);
    }
    return found;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry.length > 0 && is_ref_slot(scope, key)) {
      found.add(entry);
      continue;
    }

    if (entry && typeof entry === 'object') {
      collect_reference_ids(entry, found, ref_child_scope(scope, key));
    }
  }

  return found;
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
  // Retryable SurrealDB transaction conflicts get a much shorter, jittered
  // backoff curve than genuine failures: they're expected under concurrent
  // pushes (ancestor propagation racing server-side events) and resolve on
  // re-attempt, so waiting seconds for them is pure stall.
  const CONFLICT_BASE_BACKOFF_MS = 500;
  const CONFLICT_MAX_BACKOFF_MS = 5000;
  // Network-shaped failures (offline, fetch failure, timeout) get their own
  // curve: longer than conflicts (a dead connection won't resolve in
  // milliseconds) but capped well under the genuine-failure ceiling above, so
  // a reconnect is noticed promptly instead of waiting out a multi-minute
  // backoff earned while still offline.
  const NETWORK_BASE_BACKOFF_MS = 5000;
  const NETWORK_MAX_BACKOFF_MS = 60000;
  // Concurrency cap for the push scheduler. High enough that a burst drains in
  // parallel, low enough not to storm the server with conflicting transactions
  // or exhaust mobile connection pools. `config.pushConcurrency` overrides it
  // as an escape hatch (RuntimeConfig.pushConcurrency).
  const MAX_CONCURRENT_PUSHES = config.pushConcurrency ?? 4;

  // Batched push envelope (M10): a reconnect after being offline can leave
  // dozens of independent single-record ops queued. Firing each as its own
  // HTTP request is the "server spam on reconnect" the offline audit flagged.
  // Instead, up to BATCH_ENVELOPE_SIZE simultaneously-ready, independent ops
  // are combined into ONE multi-statement /sql request (each op wrapped in
  // its own `{ }` block — SurrealDB block-scopes LET vars and isolates
  // errors per top-level statement, confirmed empirically: one block
  // throwing does not affect sibling blocks' results in the same request).
  // Still capped by MAX_CONCURRENT_PUSHES (one batch = one concurrency slot,
  // same as one single op) and additionally paced by MIN_LAUNCH_INTERVAL_MS
  // between successive network launches so a 200-op backlog can't fire its
  // ~8 batches back-to-back in the same tick.
  const BATCH_ENVELOPE_SIZE = 25;
  const MIN_LAUNCH_INTERVAL_MS = 200;
  let lastNetworkLaunchAt = 0;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Await this immediately before every outgoing sync fetch to enforce MIN_LAUNCH_INTERVAL_MS pacing. */
  async function paceNextLaunch(): Promise<void> {
    const now = Date.now();
    const nextSlot = Math.max(now, lastNetworkLaunchAt + MIN_LAUNCH_INTERVAL_MS);
    lastNetworkLaunchAt = nextSlot;
    const wait = nextSlot - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Ops eligible to join a combined batch envelope: exactly the ones
   * runSingleOp already handles as one self-contained statement. The three
   * batch-shaped ops (CreateTreeBatch/UpdateRecordsBatch/UpdateRelationsBatch)
   * are themselves already single consolidated requests covering many
   * records, so batching them together adds complexity (their SQL bodies
   * assume they own the whole statement, e.g. `$existing` idempotency guards
   * keyed off the FULL op) for little benefit — they stay on the individual
   * path. DeleteTree is a scheduler barrier and is never ready alongside
   * other ops anyway.
   */
  function isBatchableOpKind(kind: OpKind): boolean {
    return (
      kind !== 'CreateTreeBatch' &&
      kind !== 'UpdateRecordsBatch' &&
      kind !== 'UpdateRelationsBatch' &&
      kind !== 'DeleteTree'
    );
  }

  // One-shot timer armed after a drain that leaves ops backing off, firing at
  // the earliest per-op eligibility. Without it, retries only happen when the
  // ~30s sync-loop tick lands — a single transient failure used to park an op
  // for up to 30s (two for ~60s) regardless of its actual backoff.
  let retryWakeTimer: ReturnType<typeof setTimeout> | null = null;

  // Ops cancelled by the user (or a sibling tab via OpCancel) while a drain
  // was holding references to them. The scheduler consults this before
  // launching a node so a cancelled op is never pushed.
  const cancelledOpIds = new Set<string>();

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

  // Keep a settled op visible briefly so the panel can show completion, but
  // not so long that it reads as "still hanging" (it sat 10s originally).
  function scheduleRemoveSyncOp(opId: string, delayMs = 3000): void {
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
      last_error_kind: op.last_error_kind,
      last_attempt_at: op.last_attempt_at,
      updated: op.updated,
      conflictCurrent: op.conflictCurrent
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

  // Deterministic per-op jitter (0-249ms) so retrying conflict ops don't
  // re-collide in lockstep. Derived from the op id (not Math.random) so an
  // op's eligibility instant is stable across repeated opEligibleNow checks.
  function jitterForOp(opId: string): number {
    let hash = 0;
    for (let index = 0; index < opId.length; index += 1) {
      hash = (hash * 31 + opId.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 250;
  }

  function backoffForOp(op: Op): number {
    if (op.retries <= 0) return 0;
    // `last_error_kind` is stamped at catch time going forward; ops loaded
    // from IDB before this field existed fall back to the old text-matching
    // heuristic so an in-flight conflict-backoff op doesn't regress.
    const kind: 'network' | 'conflict' | 'server' =
      op.last_error_kind ?? (op.last_error && isRetryableSyncError(op.last_error) ? 'conflict' : 'server');
    if (kind === 'conflict') {
      return (
        Math.min(
          CONFLICT_BASE_BACKOFF_MS * Math.pow(2, Math.min(op.retries - 1, 3)),
          CONFLICT_MAX_BACKOFF_MS
        ) + jitterForOp(op.id)
      );
    }
    if (kind === 'network') {
      return (
        Math.min(
          NETWORK_BASE_BACKOFF_MS * Math.pow(2, Math.min(op.retries - 1, 4)),
          NETWORK_MAX_BACKOFF_MS
        ) + jitterForOp(op.id)
      );
    }
    return backoffForRetries(op.retries);
  }

  function opEligibleNow(op: Op, now: number): boolean {
    if (op.retries <= 0) return true;
    return now - (op.last_attempt_at ?? 0) >= backoffForOp(op);
  }

  /**
   * Arm (or re-arm) the retry wake at the earliest eligibility instant among
   * backing-off pending ops. No-op when nothing is backing off. The timer just
   * kicks pushOps — the per-op eligibility filter there decides what actually
   * goes out.
   */
  function armRetryWake(): void {
    if (retryWakeTimer) {
      clearTimeout(retryWakeTimer);
      retryWakeTimer = null;
    }
    // Only arm while a sync loop is active (leaders — including the only tab
    // on mobile — always run one; see runtime.ts). A loop-less follower's
    // backing-off ops live in shared IDB, so the leader's own wake/tick
    // retries them; gating here keeps bare engines (tests, teardown races)
    // from leaving stray timers that outlive their fetch context.
    if (!syncLoopWake) return;
    const now = Date.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const op of oplog) {
      if (op.status !== 'pending' || op.retries <= 0) continue;
      soonest = Math.min(soonest, (op.last_attempt_at ?? 0) + backoffForOp(op));
    }
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(soonest - now, 250);
    retryWakeTimer = setTimeout(() => {
      retryWakeTimer = null;
      void pushOps();
    }, delay);
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
          last_error_kind: raw.last_error_kind as Op['last_error_kind'],
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
            last_error_kind: raw.last_error_kind as Op['last_error_kind'],
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
    // Capture the client's last-seen server `updated` for the target NOW
    // (queue time), not at flush — that's the baseline field_stamps CAS
    // conflict detection compares against server-side. A record absent from
    // the cache (never fetched) has no baseline, so `_base_updated` stays
    // undefined/null and the server skips the conflict check entirely for
    // this op rather than false-flagging every field as conflicted.
    if ((kind === 'UpdateRecord' || kind === 'DeleteTree') && plainPayload && typeof plainPayload === 'object') {
      const targetId = (plainPayload as Record<string, unknown>).id;
      if (typeof targetId === 'string' && !('_base_updated' in (plainPayload as Record<string, unknown>))) {
        const cached = typeof (cache as any).getItem === 'function' ? cache.getItem(targetId) : undefined;
        (plainPayload as Record<string, unknown>)._base_updated = cached?.updated ?? null;
      }
    }
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

    // Claim the lock SYNCHRONOUSLY, before the first await. The lock used to
    // be assigned only after the loadPendingOps await below, so two pushOps
    // entering in the same tick (queueAndWake fires one per queued op) BOTH
    // passed the null-check above and ran overlapping drains — each queued op
    // briefly got its own drain, defeating the single-drain invariant the
    // scheduler's ordering guarantees are built on.
    let releaseLock!: () => void;
    syncPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    let snapshotIds = new Set<string>();
    try {
      // Capture ops queued by sleeping/background followers into shared IndexedDB
      const persisted = await loadPendingOps(config.storageNamespace);
      const existingIds = new Set(oplog.map(op => op.id));
      for (const raw of persisted) {
        // A cancelled op can transiently reappear from IDB (the cancelling tab's
        // delete may not have committed yet) — never re-import it.
        if (cancelledOpIds.has(raw.id)) continue;
        if (!existingIds.has(raw.id)) {
          const op: Op = {
            id: raw.id,
            kind: raw.kind as OpKind,
            payload: raw.payload,
            status: 'pending',
            created: raw.created,
            retries: raw.retries,
            last_error: raw.last_error,
            last_error_kind: raw.last_error_kind as Op['last_error_kind'],
            last_attempt_at: raw.last_attempt_at,
            updated: raw.updated
          };
          oplog.push(op);
          existingIds.add(raw.id);
          publishOp(op);
        }
      }

      // Per-op backoff: attempt only ops that are eligible now (never-tried, or
      // past their own retry backoff). Ops still backing off stay pending and
      // are retried by the retry wake / a later pushOps() — they no longer
      // block the eligible ones.
      const now = Date.now();
      const pending = oplog.filter(op => op.status === 'pending' && opEligibleNow(op, now));
      if (pending.length === 0) return;

      // The browser reports no network at all: don't burn a single retry
      // attempt against any of these ops (network-classified or not — a
      // never-tried op would otherwise take its first failed attempt here
      // and start backing off for no reason). Leave everything pending as-is;
      // the sync loop's `online` handler resets backoff and re-invokes
      // pushOps() the instant connectivity returns, so nothing waits out a
      // stale timer either. `navigator.onLine === false` is the one reading
      // of this flag that's actually trustworthy (browsers rarely claim
      // "offline" incorrectly, unlike the reverse).
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        markSyncOffline(config.storageNamespace);
        logger.debug(`skipping push: navigator reports offline (${pending.length} op(s) remain queued)`);
        return;
      }

      syncWasBusy = true;
      logger.debug(`pushing ${pending.length} pending ops`);

      // executePush only processes THIS snapshot. Ops queued while the push is
      // in flight (the rapid-fire user-action case — e.g. checking off several
      // exec items in quick succession) are NOT in `pending`, and the
      // `if (syncPromise) { await; return; }` lock above made their own
      // pushOps() calls no-ops. Remember the snapshot ids so we can detect such
      // late arrivals and drain them once the lock is released, instead of
      // stranding them until the next ~30s sync-loop tick.
      snapshotIds = new Set(pending.map(op => op.id));
      // Reset right before we take ownership; any collision from here on is work
      // that arrived DURING this push and must be drained when it finishes.
      pushRequestedDuringFlight = false;
      await executePush(pending);
    } finally {
      releaseLock();
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
      return;
    }

    // Ops still backing off retry at their own eligibility instant, not at the
    // next ~30s sync-loop tick (which stays as a safety net only).
    armRetryWake();
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
      markSyncHealthy(config.storageNamespace);
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
      const networkError = !retryableConflict && isNetworkSyncError(error);
      const maxRetries = (retryableConflict || networkError) ? Number.POSITIVE_INFINITY : MAX_RETRIES;
      const errMsg = error instanceof Error ? error.message : String(error);
      op.last_error = errMsg;
      op.last_error_kind = retryableConflict ? 'conflict' : networkError ? 'network' : 'server';
      op.last_attempt_at = Date.now();
      if (networkError) markSyncDegraded(config.storageNamespace);

      if (op.retries >= maxRetries) {
        op.status = 'rejected';
        // Mirror the accept-path cleanup so optimistic temp items/edges don't
        // outlive the op that created them. Without this, a rejected batch
        // would leave phantom `temp:` rows in the cache (and IDB) that no
        // subsequent reconcile will ever clear, since they're not in the
        // server's record set but also have no temp→real remap.
        rollbackTreeBatchOptimistic(payload);
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
        } else if (networkError) {
          logger.info(`retrying op id=${op.id} kind=CreateTreeBatch after network error attempt=${op.retries}`);
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
      markSyncHealthy(config.storageNamespace);
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
      const networkError = !retryableConflict && isNetworkSyncError(error);
      const maxRetries = (retryableConflict || networkError) ? Number.POSITIVE_INFINITY : MAX_RETRIES;
      const errMsg = error instanceof Error ? error.message : String(error);
      op.last_error = errMsg;
      op.last_error_kind = retryableConflict ? 'conflict' : networkError ? 'network' : 'server';
      op.last_attempt_at = Date.now();
      if (networkError) markSyncDegraded(config.storageNamespace);

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
        } else if (networkError) {
          logger.info(`retrying op id=${op.id} kind=UpdateRecordsBatch after network error attempt=${op.retries}`);
        } else {
          logger.warn(`retrying op id=${op.id} kind=UpdateRecordsBatch attempt=${op.retries}`, error);
        }
      }
    }
  }

  /**
   * SQL for `UpdateRelationsBatch` — one transaction carrying every group/applies
   * add/remove delta for an existing record. Collapses what would otherwise be N
   * `AddGrouping`/`RemoveGrouping`/`AddApplies`/`RemoveApplies` ops (N HTTP
   * transactions; the SDK has no coalescing) into a single op.
   *
   * Adds are idempotent on replay (each RELATE guarded by an `in`/`out` existence
   * check, mirroring the individual `AddGrouping` op); removes are plain
   * `DELETE type::record($id)` (idempotent). Edges are NOT tagged with
   * `_sync_op_id` — idempotency comes from the `in`/`out` guard — and we do NOT
   * set `skip_changefeed`, so each RELATE/DELETE emits its own changefeed event
   * and live propagation is identical to the per-op path. Only the op count and
   * HTTP request count drop.
   */
  function buildRelationsBatchSql(
    op: Op,
    payload: UpdateRelationsBatchPayload
  ): { sql: string; vars: Record<string, unknown> } {
    const vars: Record<string, unknown> = {};
    const lines: string[] = [];

    payload.addGroups.forEach((g, i) => {
      const s = `ag_${i}_s`;
      const d = `ag_${i}_d`;
      vars[s] = g.src;
      vars[d] = g.dst;
      // Idempotency guard mirrors AddGrouping: if the groups edge already
      // exists (in=group, out=member), return it instead of creating a duplicate.
      lines.push(`  LET $ag_${i}_s = type::record($${s});`);
      lines.push(`  LET $ag_${i}_d = type::record($${d});`);
      lines.push(`  LET $ag_${i}_ex = (SELECT * FROM groups WHERE in = $ag_${i}_s AND out = $ag_${i}_d LIMIT 1)[0];`);
      lines.push(`  LET $ag_${i} = IF $ag_${i}_ex != NONE { $ag_${i}_ex } ELSE { (RELATE $ag_${i}_s->groups->$ag_${i}_d)[0] };`);
    });

    payload.removeGroups.forEach((r, i) => {
      const id = `rg_${i}`;
      vars[id] = r.id;
      lines.push(`  DELETE type::record($${id});`);
    });

    payload.addApplies.forEach((a, i) => {
      const s = `aa_${i}_s`;
      const d = `aa_${i}_d`;
      vars[s] = a.src;
      vars[d] = a.dst;
      // Idempotency guard mirrors AddApplies (corrected to the `appliesto` table
      // — the schema-defined table with a changefeed; the legacy `->applies->`
      // form wrote to a phantom table). See offline_sync.surql add_applies.
      lines.push(`  LET $aa_${i}_s = type::record($${s});`);
      lines.push(`  LET $aa_${i}_d = type::record($${d});`);
      lines.push(`  LET $aa_${i}_ex = (SELECT * FROM appliesto WHERE in = $aa_${i}_s AND out = $aa_${i}_d LIMIT 1)[0];`);
      lines.push(`  LET $aa_${i} = IF $aa_${i}_ex != NONE { $aa_${i}_ex } ELSE { (RELATE $aa_${i}_s->appliesto->$aa_${i}_d)[0] };`);
    });

    payload.removeApplies.forEach((r, i) => {
      const id = `ra_${i}`;
      vars[id] = r.id;
      lines.push(`  DELETE type::record($${id});`);
    });

    const addedGroupRefs = payload.addGroups.map((_, i) => `$ag_${i}`).join(', ');
    const addedAppliesRefs = payload.addApplies.map((_, i) => `$aa_${i}`).join(', ');
    lines.push(`  RETURN { addedGroups: [${addedGroupRefs}], addedApplies: [${addedAppliesRefs}] };`);

    return { sql: lines.join('\n'), vars };
  }

  /** Extract the `{ addedGroups, addedApplies }` RETURN of a relations batch. */
  function extractRelationsBatchResult(
    statements: SurrealSqlStatement[]
  ): { addedGroups: any[]; addedApplies: any[] } | null {
    for (let index = statements.length - 1; index >= 0; index -= 1) {
      const r = statements[index].result as any;
      if (
        r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        Array.isArray(r.addedGroups) &&
        Array.isArray(r.addedApplies)
      ) {
        return { addedGroups: r.addedGroups, addedApplies: r.addedApplies };
      }
    }
    return null;
  }

  async function runRelationsBatch(op: Op, acceptedMarkerOpIds: Set<string>): Promise<void> {
    const payload = op.payload as UpdateRelationsBatchPayload | undefined;
    if (
      !payload ||
      !Array.isArray(payload.addGroups) ||
      !Array.isArray(payload.removeGroups) ||
      !Array.isArray(payload.addApplies) ||
      !Array.isArray(payload.removeApplies)
    ) {
      op.status = 'rejected';
      op.last_error = 'UpdateRelationsBatch payload missing relation arrays';
      await persistAndPublish(op);
      return;
    }
    const totalChanges =
      payload.addGroups.length +
      payload.removeGroups.length +
      payload.addApplies.length +
      payload.removeApplies.length;
    if (totalChanges === 0) {
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
      const { sql, vars } = buildRelationsBatchSql(op, payload);
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
        logger.warn(`401 on relations batch op ${op.id}; retrying with fresh token`);
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
        logger.warn(`UpdateRelationsBatch HTTP ${response.status} body: ${body.slice(0, 800)}`);
        logger.debug(`UpdateRelationsBatch failing SQL:\n${statement.slice(0, 1500)}`);
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      const resJson = await response.json();
      const evaluation = evaluate_sql_response(resJson);
      const final = extractRelationsBatchResult(evaluation.statements);
      // final may be null if every add short-circuited to an existing edge that
      // the SELECT returned as NONE-shaped — tolerate it and fall back to empty.
      const addedGroupsRows = final?.addedGroups ?? [];
      const addedAppliesRows = final?.addedApplies ?? [];

      // Normalize added groups edges (in=group, out=member → parent_id=group,
      // child_id=member — same mapping as runTreeBatch for `groups:` edges).
      const normalizedGroupEdges: any[] = [];
      for (const edge of addedGroupsRows) {
        if (!edge || typeof edge !== 'object') continue;
        const edgeId = normalizeThingString((edge as any).id);
        const groupId = normalizeThingString((edge as any).in);
        const memberId = normalizeThingString((edge as any).out);
        if (!edgeId || !groupId || !memberId) continue;
        normalizedGroupEdges.push({
          edge_id: edgeId,
          parent_id: groupId,
          child_id: memberId,
          order: typeof (edge as any).order === 'number' ? (edge as any).order : 0,
          is_key_parent: false,
          module_data: typeof (edge as any).module_data === 'object' && (edge as any).module_data !== null
            ? (edge as any).module_data
            : undefined,
          clone_setting: null
        });
      }

      const normalizedAppliesEdges: any[] = [];
      for (const edge of addedAppliesRows) {
        if (!edge || typeof edge !== 'object') continue;
        const edgeId = normalizeThingString((edge as any).id);
        const srcId = normalizeThingString((edge as any).in);
        const dstId = normalizeThingString((edge as any).out);
        if (!edgeId || !srcId || !dstId) continue;
        normalizedAppliesEdges.push({
          edge_id: edgeId,
          src_id: srcId,
          dst_id: dstId,
          module_data: typeof (edge as any).module_data === 'object' && (edge as any).module_data !== null
            ? (edge as any).module_data
            : undefined
        });
      }

      // Mark accepted before async cache mutation (mirrors single-op + batch patterns).
      op.status = 'accepted';
      op.updated = Date.now();
      inflightOps.delete(op.id);
      oplog = oplog.filter(o => o.id !== op.id);
      failureCount = 0;
      markSyncHealthy(config.storageNamespace);
      // No _sync_op_id tagging on these edges, so no marker to clean — but keep
      // the op id out of the marker set for consistency with the accept flow.
      void acceptedMarkerOpIds;
      await persistAndPublish(op);

      // Apply server-confirmed added edges to the local cache and broadcast to
      // sibling tabs for immediacy (the changefeed also delivers idempotently).
      if (normalizedGroupEdges.length > 0) {
        for (const e of normalizedGroupEdges) {
          cache.upsert_graph_child_of_edge(e.edge_id, e.child_id, e.parent_id, e.order, e.is_key_parent, e.module_data, e.clone_setting);
        }
        liveBus.broadcast({ type: 'GraphChildBatchUpsert', edges: normalizedGroupEdges });
      }
      if (normalizedAppliesEdges.length > 0) {
        for (const e of normalizedAppliesEdges) {
          cache.upsert_applies_edge(e.edge_id, e.src_id, e.dst_id, e.module_data);
          liveBus.broadcast({ type: 'AppliesUpsert', edgeId: e.edge_id, srcId: e.src_id, dstId: e.dst_id, moduleData: e.module_data });
        }
      }

      // Apply removals from the payload ids (authoritative — the server DELETE
      // is idempotent and the cache remove is a no-op if the edge wasn't cached).
      for (const r of payload.removeGroups) {
        cache.remove_graph_child(r.id);
        liveBus.broadcast({ type: 'GraphChildDelete', edgeId: r.id });
      }
      for (const r of payload.removeApplies) {
        cache.remove_applies_edge(r.id);
        liveBus.broadcast({ type: 'AppliesDelete', edgeId: r.id });
      }

      await deleteOp(config.storageNamespace, op.id).catch(() => {});
      publishOp(op);
      scheduleRemoveSyncOp(op.id);
      logger.debug(
        `accepted op id=${op.id} kind=UpdateRelationsBatch addedGroups=${normalizedGroupEdges.length} addedApplies=${normalizedAppliesEdges.length} removedGroups=${payload.removeGroups.length} removedApplies=${payload.removeApplies.length}`
      );
    } catch (error) {
      failureCount++;
      op.retries++;
      inflightOps.delete(op.id);
      const retryableConflict = isRetryableSyncError(error);
      const networkError = !retryableConflict && isNetworkSyncError(error);
      const maxRetries = (retryableConflict || networkError) ? Number.POSITIVE_INFINITY : MAX_RETRIES;
      const errMsg = error instanceof Error ? error.message : String(error);
      op.last_error = errMsg;
      op.last_error_kind = retryableConflict ? 'conflict' : networkError ? 'network' : 'server';
      op.last_attempt_at = Date.now();
      if (networkError) markSyncDegraded(config.storageNamespace);

      if (op.retries >= maxRetries) {
        op.status = 'rejected';
        await persistAndPublish(op);
        logger.warn(
          `rejected op id=${op.id} kind=UpdateRelationsBatch${retryableConflict ? ' after repeated transaction conflicts' : ''}`,
          error
        );
      } else {
        op.status = 'pending';
        await persistAndPublish(op);
        if (retryableConflict) {
          logger.info(`retrying op id=${op.id} kind=UpdateRelationsBatch after transaction conflict attempt=${op.retries}`);
        } else if (networkError) {
          logger.info(`retrying op id=${op.id} kind=UpdateRelationsBatch after network error attempt=${op.retries}`);
        } else {
          logger.warn(`retrying op id=${op.id} kind=UpdateRelationsBatch attempt=${op.retries}`, error);
        }
      }
    }
  }

  /** Temp ids this op will create when accepted (it is their "producer"). */
  function producedTempIds(op: Op): string[] {
    if (op.kind === 'CreateRecord') {
      const id = (op.payload as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' && id.startsWith('temp:') ? [id] : [];
    }
    if (op.kind === 'CreateTreeBatch') {
      const records = (op.payload as CreateTreeBatchPayload | undefined)?.records;
      if (!Array.isArray(records)) return [];
      return records
        .map((record) => record.tempId)
        .filter((tempId): tempId is string => typeof tempId === 'string' && tempId.startsWith('temp:'));
    }
    return [];
  }

  /** Temp ids the op references but does not itself create. */
  function unresolvedTempIdsFor(op: Op): string[] {
    if (op.kind === 'CreateRecord') return [];
    const refs = Array.from(collect_temp_reference_ids(op.payload));
    if (op.kind === 'CreateTreeBatch') {
      const ownTempIds = new Set(
        ((op.payload as CreateTreeBatchPayload | undefined)?.records ?? []).map((record) => record.tempId)
      );
      return refs.filter((tempId) => !ownTempIds.has(tempId));
    }
    return refs;
  }

  /**
   * The op references temp ids whose producer isn't in this drain (still
   * backing off, or queued on another tab). Leave it pending for a later
   * drain — a producer accept rewrites its payload via rewriteOplogId.
   */
  async function deferOpForTempIds(op: Op, unresolvedTempIds: string[]): Promise<void> {
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
  }

  /**
   * The op depends on temp ids whose producer was REJECTED — they will never
   * resolve, so the op can never be pushed. Reject it too (rolling back its
   * optimistic rows) instead of leaving it deferred forever.
   */
  async function cascadeRejectForTempIds(op: Op, rejectedRefs: string[]): Promise<void> {
    op.status = 'rejected';
    op.last_error = `dependency rejected: ${rejectedRefs.join(', ')} will never be created`;
    rollbackOptimisticForRejection(op);
    await persistAndPublish(op);
    logger.warn(
      `rejected op id=${op.id} kind=${op.kind}; its temp id dependency was rejected: ${rejectedRefs.join(', ')}`
    );
  }

  function runOpNode(op: Op, acceptedMarkerOpIds: Set<string>): Promise<void> {
    if (op.kind === 'CreateTreeBatch') return runTreeBatch(op, acceptedMarkerOpIds);
    if (op.kind === 'UpdateRecordsBatch') return runRecordsBatch(op, acceptedMarkerOpIds);
    if (op.kind === 'UpdateRelationsBatch') return runRelationsBatch(op, acceptedMarkerOpIds);
    return runSingleOp(op, acceptedMarkerOpIds);
  }

  /**
   * Concurrent, dependency-aware drain of one pending snapshot.
   *
   * Replaces the old strictly-serial loop (one HTTP round trip at a time, so a
   * burst's tail op waited for the SUM of every round trip before it, and one
   * hung request stalled the whole queue). Only ordering that actually matters
   * is kept, as graph edges; everything else pushes concurrently up to
   * MAX_CONCURRENT_PUSHES:
   *
   *  - same-target FIFO: ops whose structural key sets intersect (any shared
   *    record/edge reference — collect_reference_ids) run in queue order;
   *  - temp-id production: an op referencing temp:X shares that key with the
   *    CreateRecord/CreateTreeBatch that creates it (queued first), so it
   *    orders after its producer — which rewrites dependent payloads via
   *    rewriteOplogId BEFORE settling;
   *  - DeleteTree is a full barrier: it deletes server-side descendants the
   *    client can't cheaply enumerate into keys, so nothing may straddle it.
   *
   * The graph is acyclic by construction (every edge points from an earlier
   * queued op to a later one), so the pump below always terminates.
   *
   * Temp-id resolution is re-checked when a node is released: producer
   * accepted → payload already rewritten, run it; producer still pending
   * (failed, backing off) → defer to a later drain; producer rejected →
   * cascade-reject, the temp id will never exist.
   */
  async function executePush(initialPending: Op[]): Promise<void> {
    const acceptedMarkerOpIds = new Set<string>();

    interface SchedulerNode {
      op: Op;
      deps: Set<string>;
      dependents: Set<string>;
      state: 'waiting' | 'running' | 'settled';
    }

    const nodes = new Map<string, SchedulerNode>();
    const lastOpForKey = new Map<string, string>();
    let barrierId: string | null = null;

    for (const op of initialPending) {
      const node: SchedulerNode = { op, deps: new Set(), dependents: new Set(), state: 'waiting' };
      nodes.set(op.id, node);
      if (op.kind === 'DeleteTree') {
        for (const other of nodes.values()) {
          if (other.op.id === op.id) continue;
          node.deps.add(other.op.id);
          other.dependents.add(op.id);
        }
        barrierId = op.id;
      } else {
        if (barrierId) {
          node.deps.add(barrierId);
          nodes.get(barrierId)!.dependents.add(op.id);
        }
        for (const key of collect_reference_ids(op.payload)) {
          const previous = lastOpForKey.get(key);
          if (previous && previous !== op.id) {
            node.deps.add(previous);
            nodes.get(previous)!.dependents.add(op.id);
          }
        }
      }
      for (const key of collect_reference_ids(op.payload)) {
        lastOpForKey.set(key, op.id);
      }
    }

    // Temp ids whose producer settled as rejected during THIS drain.
    const rejectedTempIds = new Set<string>();

    await new Promise<void>((resolveAll) => {
      const readyQueue: SchedulerNode[] = [];
      for (const node of nodes.values()) {
        if (node.deps.size === 0) readyQueue.push(node);
      }
      let running = 0;

      const settleNode = (node: SchedulerNode) => {
        node.state = 'settled';
        if (node.op.status === 'rejected') {
          for (const tempId of producedTempIds(node.op)) rejectedTempIds.add(tempId);
        }
        for (const dependentId of node.dependents) {
          const dependent = nodes.get(dependentId);
          if (!dependent || dependent.state !== 'waiting') continue;
          dependent.deps.delete(node.op.id);
          if (dependent.deps.size === 0) readyQueue.push(dependent);
        }
      };

      const launch = (node: SchedulerNode, task: () => Promise<void>) => {
        node.state = 'running';
        running += 1;
        void task()
          .catch((e) => logger.error(`op runner crashed id=${node.op.id} kind=${node.op.kind}`, e))
          .finally(() => {
            running -= 1;
            settleNode(node);
            pump();
          });
      };

      // M10: launches SEVERAL nodes as one combined batch envelope request.
      // Counts as ONE concurrency slot (like a single launch) since it's one
      // HTTP round trip; each node settles independently once the envelope's
      // per-op results have been applied (runBatchEnvelope never leaves a
      // node's op.status unresolved).
      const launchBatch = (batchNodes: SchedulerNode[], task: () => Promise<void>) => {
        for (const node of batchNodes) node.state = 'running';
        running += 1;
        void task()
          .catch((e) => logger.error(`batch runner crashed ids=${batchNodes.map((n) => n.op.id).join(',')}`, e))
          .finally(() => {
            running -= 1;
            for (const node of batchNodes) settleNode(node);
            pump();
          });
      };

      const pump = () => {
        // cap is `config.pushConcurrency ?? 4` (see MAX_CONCURRENT_PUSHES).
        while (running < MAX_CONCURRENT_PUSHES && readyQueue.length > 0) {
          // Drop stale (already-settled) entries from the front.
          while (readyQueue.length > 0 && readyQueue[0].state !== 'waiting') readyQueue.shift();
          if (readyQueue.length === 0) break;

          // Gather a batchable run from the FRONT of the queue: single-op-kind,
          // not cancelled, no unresolved temp-id deps. Stops at the first node
          // that doesn't qualify (it — and everything behind it — is handled
          // by the existing per-node path below, on this or a later pump()
          // call) or once BATCH_ENVELOPE_SIZE is reached.
          const group: SchedulerNode[] = [];
          while (readyQueue.length > 0 && group.length < BATCH_ENVELOPE_SIZE) {
            const candidate = readyQueue[0];
            if (candidate.state !== 'waiting') {
              readyQueue.shift();
              continue;
            }
            if (
              !isBatchableOpKind(candidate.op.kind) ||
              cancelledOpIds.has(candidate.op.id) ||
              candidate.op.status !== 'pending' ||
              unresolvedTempIdsFor(candidate.op).length > 0
            ) {
              break;
            }
            group.push(candidate);
            readyQueue.shift();
          }

          if (group.length >= 2) {
            launchBatch(group, () => runBatchEnvelope(group.map((n) => n.op), acceptedMarkerOpIds));
            continue;
          }

          if (group.length === 1) {
            // Exactly one batchable op was ready — no batching benefit.
            // Already shifted out above; its eligibility was just re-verified
            // during the scan, so run it directly via the single-op path.
            const node = group[0];
            launch(node, () => runOpNode(node.op, acceptedMarkerOpIds));
            continue;
          }

          // group.length === 0: the node now at the front is non-batchable
          // (a batch-kind op or DeleteTree), cancelled, or temp-blocked —
          // the ONLY path that handles cancel-settle / cascade-reject / defer.
          if (readyQueue.length === 0) break;
          const node = readyQueue.shift()!;
          const op = node.op;

          // Cancelled (or otherwise no longer pending) while waiting in this
          // drain — settle without a network attempt so dependents release.
          if (cancelledOpIds.has(op.id) || op.status !== 'pending') {
            settleNode(node);
            continue;
          }

          const unresolved = unresolvedTempIdsFor(op);
          if (unresolved.length > 0) {
            const rejectedRefs = unresolved.filter((tempId) => rejectedTempIds.has(tempId));
            if (rejectedRefs.length > 0) {
              launch(node, () => cascadeRejectForTempIds(op, rejectedRefs));
            } else {
              launch(node, () => deferOpForTempIds(op, unresolved));
            }
            continue;
          }

          launch(node, () => runOpNode(op, acceptedMarkerOpIds));
        }
        if (running === 0 && readyQueue.length === 0) resolveAll();
      };

      pump();
    });

    await cleanupSyncMarkers(Array.from(acceptedMarkerOpIds));
  }

  function markOpInflight(op: Op): void {
    op.status = 'inflight';
    op.last_attempt_at = Date.now();
    op.last_error = undefined;
    publishOp(op);
    inflightOps.set(op.id, op);
  }

  /**
   * Success-path application for one single-op-kind op, given its ALREADY
   * PARSED response JSON. Shared verbatim by the solo path (runSingleOp,
   * where resJson is the full per-op multi-statement response) and the
   * batched path (runBatchEnvelope, where resJson is a one-element array
   * wrapping just that op's `{ }` block result — evaluate_sql_response
   * doesn't care which, it just scans for errors and finds the RETURNed row).
   */
  async function applySingleOpSuccess(
    op: Op,
    resJson: unknown,
    acceptedMarkerOpIds: Set<string>
  ): Promise<void> {
    const evaluation = evaluate_sql_response(resJson);
    if (op.kind === 'UpdateRecord' || op.kind === 'DeleteTree') {
      const conflict = extractConflictMarker(evaluation.statements);
      if (conflict) {
        await applyConflictResult(op, conflict);
        return;
      }
    }
    op.status = 'accepted';
    op.updated = Date.now();
    inflightOps.delete(op.id);
    oplog = oplog.filter(o => o.id !== op.id);
    failureCount = 0;
    markSyncHealthy(config.storageNamespace);
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
  }

  /**
   * The field-stamps CAS check in build_op_sql found the target changed
   * since this op's `base_updated` baseline (or the target was deleted) and
   * did NOT apply the write. This is a genuine round-trip success (the
   * server is reachable and answered), so — unlike handleSingleOpFailure —
   * failureCount/health stay on the happy path. The op is marked
   * 'conflicted' and stays in oplog/IDB (excluded from getPendingOps, so it
   * never auto-retries and never blocks the scheduler) until the caller
   * resolves it via resolveConflict. Left OUT of scheduleRemoveSyncOp's
   * auto-fade — unlike an accepted op, a conflict needs the user to notice
   * and act on it (M11 surfaces it in the activity feed).
   */
  async function applyConflictResult(op: Op, conflict: ConflictMarker): Promise<void> {
    op.status = 'conflicted';
    op.updated = Date.now();
    op.conflictCurrent = conflict.current;
    op.last_error = conflict.deleted
      ? 'Target was deleted since your last sync'
      : `Changed since your last sync: ${conflict.conflictedFields?.join(', ') || 'unknown fields'}`;
    op.last_error_kind = 'conflict';
    inflightOps.delete(op.id);
    failureCount = 0;
    markSyncHealthy(config.storageNamespace);

    const targetId = extractTargetId(op.payload);
    if (targetId) cache.update_sync_status?.(targetId, 'conflicted');

    await persistAndPublish(op);
    publishOp(op);
    logger.warn(
      `conflict on op id=${op.id} kind=${op.kind}${conflict.deleted ? ' (target deleted)' : ` fields=${conflict.conflictedFields?.join(',')}`}`
    );
  }

  /** Failure-path handling for one single-op-kind op. Shared by the solo and batched launch paths. */
  async function handleSingleOpFailure(op: Op, error: unknown): Promise<void> {
    failureCount++;
    op.retries++;
    inflightOps.delete(op.id);
    const targetId = extractTargetId(op.payload);
    const retryableConflict = isRetryableSyncError(error);
    const networkError = !retryableConflict && isNetworkSyncError(error);
    const maxRetries = (retryableConflict || networkError) ? Number.POSITIVE_INFINITY : MAX_RETRIES;
    const errMsg = error instanceof Error ? error.message : String(error);
    op.last_error = errMsg;
    op.last_error_kind = retryableConflict ? 'conflict' : networkError ? 'network' : 'server';
    op.last_attempt_at = Date.now();
    if (networkError) markSyncDegraded(config.storageNamespace);

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
      } else if (networkError) {
        logger.info(`retrying op id=${op.id} kind=${op.kind} after network error attempt=${op.retries}`);
      } else {
        logger.warn(`retrying op id=${op.id} kind=${op.kind} attempt=${op.retries}`, error);
      }
    }
  }

  async function runSingleOp(op: Op, acceptedMarkerOpIds: Set<string>): Promise<void> {
      const sql = build_op_sql(op);
      if (!sql) {
        op.status = 'rejected';
        op.last_error = `unknown op kind: ${op.kind}`;
        await persistAndPublish(op);
        return;
      }

      markOpInflight(op);

      try {
        const token = await resolveToken(config);
        const statement = buildSurrealStatement(sql, build_op_vars(op));
        await paceNextLaunch();
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
          await applySingleOpSuccess(op, resJson, acceptedMarkerOpIds);
        } else {
          throw new Error(`Sync failed: ${response.statusText}`);
        }
      } catch (error) {
        await handleSingleOpFailure(op, error);
      }
  }

  /**
   * Build the `{ }`-scoped block for one op inside a combined batch envelope.
   * Reuses `build_op_sql`/`build_op_vars` UNCHANGED — the op's own SQL body
   * text is never rewritten — and only adds an outer LET-rebinding preamble
   * so the (per-batch-unique) namespaced vars are visible under the plain
   * names that body already references. Namespacing prevents collisions when
   * multiple ops of the same kind (e.g. two UpdateRecords, both internally
   * using `$id`/`$payload`) are concatenated into one request.
   */
  function wrapOpForBatchEnvelope(op: Op, index: number): { sql: string; vars: Record<string, unknown> } | null {
    const body = build_op_sql(op);
    if (!body) return null;
    const rawVars = build_op_vars(op);
    const prefix = `b${index}_`;
    const vars: Record<string, unknown> = {};
    const rebinds: string[] = [];
    for (const [key, value] of Object.entries(rawVars)) {
      const namespacedKey = `${prefix}${key}`;
      vars[namespacedKey] = value;
      rebinds.push(`LET $${key} = $${namespacedKey};`);
    }
    const sql = `{\n${rebinds.join('\n')}\n${body}\n}`;
    return { sql, vars };
  }

  /**
   * Combined multi-statement push for several independent, simultaneously-
   * ready single-op-kind ops (see BATCH_ENVELOPE_SIZE / isBatchableOpKind).
   * ONE HTTP request; each op's block settles independently (a thrown error
   * inside one block does not affect sibling blocks' results — verified
   * against SurrealDB directly), so one bad op in the batch never blocks or
   * fails the others. Falls back to per-op handleSingleOpFailure for every
   * op in the batch if the request itself fails at the network/HTTP level
   * (never reached the server, so no op-specific result exists to parse).
   */
  async function runBatchEnvelope(ops: Op[], acceptedMarkerOpIds: Set<string>): Promise<void> {
    const built: Array<{ op: Op; sql: string; vars: Record<string, unknown> } | null> = ops.map((op, index) => {
      const wrapped = wrapOpForBatchEnvelope(op, index);
      return wrapped ? { op, ...wrapped } : null;
    });

    for (let i = 0; i < ops.length; i++) {
      if (built[i]) {
        markOpInflight(ops[i]);
      } else {
        ops[i].status = 'rejected';
        ops[i].last_error = `unknown op kind: ${ops[i].kind}`;
        await persistAndPublish(ops[i]);
      }
    }

    const entries = built.filter((b): b is { op: Op; sql: string; vars: Record<string, unknown> } => b !== null);
    if (entries.length === 0) return;

    const combinedSql = entries.map((e) => e.sql).join(';\n');
    const combinedVars: Record<string, unknown> = {};
    for (const e of entries) Object.assign(combinedVars, e.vars);

    try {
      const token = await resolveToken(config);
      const statement = buildSurrealStatement(combinedSql, combinedVars);
      await paceNextLaunch();
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
        logger.warn(`401 on batch envelope (${entries.length} ops); retrying with fresh token`);
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
        throw new Error(`Sync failed: ${response.statusText}`);
      }

      const resJson = await response.json();
      const rawResults = Array.isArray(resJson) ? resJson : [resJson];
      // buildSurrealStatement inlines every combinedVars entry as its OWN
      // top-level `LET $x = …;` statement ahead of the `{ }` blocks (the
      // HTTP /sql body is plain text — there's no separate RPC vars
      // parameter to sidestep this) — and each of THOSE also produces a
      // `{status:'OK', result:null}` entry in the response array, exactly
      // like any other top-level statement. The block results are the LAST
      // `entries.length` entries, in submission order; skip the LET-prefix
      // noise ahead of them rather than indexing `rawResults` directly by
      // op position (verified against a live SurrealDB instance — indexing
      // without this offset silently grabbed LET-prefix nulls instead of
      // each op's actual result).
      const letPrefixCount = Object.keys(combinedVars).length;
      const perOpResults = rawResults.slice(letPrefixCount);
      logger.debug(`batch envelope settled ${entries.length} op(s) in one request`);

      // Apply each op's own result/failure independently — one bad op must
      // not affect its batch-mates (see the block-isolation note above).
      await Promise.all(
        entries.map(async ({ op }, i) => {
          const entry = perOpResults[i];
          try {
            if (entry === undefined) {
              throw new Error('batch envelope response missing an entry for this op');
            }
            await applySingleOpSuccess(op, [entry], acceptedMarkerOpIds);
          } catch (error) {
            await handleSingleOpFailure(op, error);
          }
        })
      );
    } catch (error) {
      // Request-level failure (network/timeout/non-OK before any per-op
      // result existed) — every op in the batch retries/rejects the same way
      // a solo runSingleOp would for the same error.
      await Promise.all(entries.map(({ op }) => handleSingleOpFailure(op, error)));
    }
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
      UPDATE appliesto UNSET _sync_op_id WHERE _sync_op_id IN $op_ids;
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

  /** Drop the optimistic rows a CreateTreeBatch wrote at queue time. */
  function rollbackTreeBatchOptimistic(payload: CreateTreeBatchPayload): void {
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
  }

  function rollbackOptimisticForRejection(op: Op): void {
    if (op.kind === 'CreateTreeBatch') {
      rollbackTreeBatchOptimistic(op.payload as CreateTreeBatchPayload);
      return;
    }
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

  /**
   * User-initiated cancel of a QUEUED (pending) op. Inflight ops are refused —
   * the request is already on the wire and the server may have applied it, so
   * "cancelling" one would just desync the local view.
   *
   * Cancelling removes the op everywhere (memory, IndexedDB, reactive store,
   * sibling tabs via OpCancel) and rolls back the optimistic rows it created.
   * For update-shaped ops there is no before-image to restore — cancel means
   * "don't sync this"; the local edit stays until the next server refresh.
   *
   * Cascade: pending ops referencing temp ids this op would have created can
   * never resolve, so they are cancelled too.
   */
  function cancelOp(opId: string): boolean {
    const op = oplog.find((o) => o.id === opId);
    if (!op || op.status !== 'pending' || inflightOps.has(opId)) return false;
    cancelInternal(op);
    return true;
  }

  function cancelInternal(op: Op): void {
    cancelledOpIds.add(op.id);
    oplog = oplog.filter((o) => o.id !== op.id);
    rollbackOptimisticForRejection(op);
    void deleteOp(config.storageNamespace, op.id).catch(() => {});
    removeSyncOp(config.storageNamespace, op.id);
    // OpCancel prunes sibling tabs' in-memory oplogs (the shared-IDB delete
    // alone can't — a tab that already loaded the op would still push it) and
    // doubles as the store removal broadcast.
    liveBus.broadcast({ type: 'OpCancel', id: op.id });
    logger.info(`cancelled op id=${op.id} kind=${op.kind}`);

    const tempIds = producedTempIds(op);
    if (tempIds.length === 0) return;
    for (const dependent of [...oplog]) {
      if (dependent.status !== 'pending') continue;
      if (tempIds.some((tempId) => has_reference_id(dependent.payload, tempId))) {
        cancelInternal(dependent);
      }
    }
  }

  /**
   * User-initiated retry of a REJECTED op (e.g. one that hit the finite
   * `server`-kind retry cap — network/conflict-kind ops never reject in the
   * first place, so this exists for genuine server-side rejections a user
   * wants to attempt again, or a rejected op from a prior software version).
   * Resets retries/backoff and re-queues it as pending.
   *
   * KNOWN LIMITATION: this does NOT re-create optimistic rows that were
   * rolled back when the op was rejected (`rollbackOptimisticForRejection`) —
   * e.g. a retried CreateRecord's temp preview will not reappear in the UI
   * until the retried op actually accepts, at which point the real row is
   * inserted directly. Re-deriving a full optimistic preview from the queued
   * payload is out of scope here; document this rather than silently
   * under-restoring it.
   */
  async function retryOp(opId: string): Promise<boolean> {
    let op = oplog.find((o) => o.id === opId);
    if (!op) {
      // Rejected ops are NOT reloaded into the in-memory oplog by initialize()
      // (which only hydrates pending/inflight) — after a page reload a
      // rejected op lives only in IDB (and the ops-store, hydrated separately
      // for display). Pull it in here so retry still works post-reload.
      const all = await loadAllOps(config.storageNamespace);
      const raw = all.find((entry) => entry.id === opId && entry.status === 'rejected');
      if (!raw) return false;
      op = {
        id: raw.id,
        kind: raw.kind as OpKind,
        payload: raw.payload,
        status: raw.status as Op['status'],
        created: raw.created,
        retries: raw.retries,
        last_error: raw.last_error,
        last_error_kind: raw.last_error_kind as Op['last_error_kind'],
        last_attempt_at: raw.last_attempt_at,
        updated: raw.updated
      };
      oplog.push(op);
    }
    if (op.status !== 'rejected') return false;

    op.status = 'pending';
    op.retries = 0;
    op.last_error = undefined;
    op.last_error_kind = undefined;
    op.last_attempt_at = undefined;
    cancelledOpIds.delete(op.id);
    await persistAndPublish(op);
    logger.info(`retrying rejected op id=${op.id} kind=${op.kind}`);
    syncLoopWake?.();
    void pushOps();
    return true;
  }

  /**
   * User-initiated resolution of a `conflicted` op (see applyConflictResult).
   *
   * - `take-theirs`: discard the local edit and adopt the server's current
   *   row. UpdateRecord applies `conflictCurrent` to the cache directly;
   *   DeleteTree does the same (the record survived — our delete didn't
   *   happen, so the local view must catch up to whatever changed). A
   *   `deleted: true` marker (target gone) has no `current` row to apply —
   *   just drop the local copy.
   * - `keep-mine`: re-stamp `_base_updated` from `conflictCurrent.updated`
   *   (the row's state we're now explicitly overriding) and re-queue as
   *   pending — an explicit forced overwrite that will pass the CAS check
   *   on the next attempt.
   *
   * Mirrors retryOp's reload-from-IDB fallback: a conflicted op is not
   * reloaded into the in-memory oplog by initialize() (only pending/inflight
   * are), so after a page reload it lives only in IDB/the ops-store.
   */
  async function resolveConflict(opId: string, resolution: 'keep-mine' | 'take-theirs'): Promise<boolean> {
    let op = oplog.find((o) => o.id === opId);
    if (!op) {
      const all = await loadAllOps(config.storageNamespace);
      const raw = all.find((entry) => entry.id === opId && entry.status === 'conflicted');
      if (!raw) return false;
      op = {
        id: raw.id,
        kind: raw.kind as OpKind,
        payload: raw.payload,
        status: raw.status as Op['status'],
        created: raw.created,
        retries: raw.retries,
        last_error: raw.last_error,
        last_error_kind: raw.last_error_kind as Op['last_error_kind'],
        last_attempt_at: raw.last_attempt_at,
        updated: raw.updated,
        conflictCurrent: raw.conflictCurrent
      };
      oplog.push(op);
    }
    if (op.status !== 'conflicted') return false;

    const current = op.conflictCurrent;

    if (resolution === 'take-theirs') {
      const targetId = extractTargetId(op.payload);
      if (current && typeof current.id === 'string') {
        const rr = current as Record<string, unknown>;
        const core = {
          ...rr,
          id: current.id,
          created: typeof rr.created === 'string' ? rr.created : (rr.created != null ? String(rr.created) : undefined),
          updated: typeof rr.updated === 'string' ? rr.updated : (rr.updated != null ? String(rr.updated) : undefined),
          is_temp: false,
          dirty: false,
          sync_status: 'accepted'
        } as any;
        cache.normalizeItem(core);
        liveBus.broadcast({ type: 'RecordUpsert', core });
      } else if (targetId) {
        // deleted: true (or no current row available) — nothing to adopt,
        // the target is gone server-side, so drop our local copy too.
        cache.removeItem(targetId);
      }
      oplog = oplog.filter((o) => o.id !== op!.id);
      await deleteOp(config.storageNamespace, op.id).catch(() => {});
      removeSyncOp(config.storageNamespace, op.id);
      liveBus.broadcast({ type: 'OpRemove', id: op.id });
      logger.info(`resolved conflict (take-theirs) op id=${op.id} kind=${op.kind}`);
      return true;
    }

    // keep-mine: force our edit through by re-baselining on the row we just
    // saw, then re-queue.
    const newBaseUpdated =
      current && typeof current.updated === 'string'
        ? current.updated
        : current?.updated != null
          ? String(current.updated)
          : null;
    if (op.payload && typeof op.payload === 'object') {
      (op.payload as Record<string, unknown>)._base_updated = newBaseUpdated;
    }
    op.status = 'pending';
    op.retries = 0;
    op.last_error = undefined;
    op.last_error_kind = undefined;
    op.last_attempt_at = undefined;
    op.conflictCurrent = undefined;
    const targetId = extractTargetId(op.payload);
    if (targetId) cache.update_sync_status?.(targetId, 'pending');
    await persistAndPublish(op);
    logger.info(`resolved conflict (keep-mine) op id=${op.id} kind=${op.kind}`);
    syncLoopWake?.();
    void pushOps();
    return true;
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
        // Field-stamps CAS conflict check: every write's target fields are
        // compared against a per-field `field_stamps[F]` timestamp (falling
        // back to the whole-record `updated` when a field has never been
        // individually stamped — a conservative default that needs no
        // separate backfill migration, since the fallback IS the effective
        // default at query time). `$base_updated` is the client's last-seen
        // `updated` for this record, captured at queue time (see queueOp);
        // NONE means the client never had a baseline (e.g. never fetched
        // this record), so the check is skipped rather than false-flagging
        // every field. A conflict returns the current row instead of
        // applying the write; the caller (applySingleOpSuccess) detects the
        // `conflict: true` marker and routes to the conflicted-op path
        // instead of accepting. Additionals are exempt — their own per-id
        // `fn::merge_additionals` LWW remains the resolution mechanism.
        // The conflict check and the write are branches of ONE top-level
        // IF/ELSE statement rather than an early "IF conflict { RETURN }"
        // guard: verified directly against SurrealDB that a top-level
        // `RETURN` inside an `IF {}` block (not itself wrapped in an outer
        // `{}`) does NOT skip the flat multi-statement body's LATER
        // statements — only a `{}`-enclosing block's own RETURN does that
        // (see wrapOpForBatchEnvelope, which DOES wrap in `{}` for the
        // batched path). An early-RETURN guard here would have let the
        // UPDATE run anyway even after reporting a conflict. Structuring as
        // IF/ELSE with nothing following it sidesteps the whole question —
        // correct in both the flat (solo) and `{}`-wrapped (batched) forms.
        return `
          LET $current = (SELECT * FROM ONLY type::record($id));
          // _sync_op_id is a client bookkeeping marker build_op_vars stamps
          // onto every $payload (for LIVE echo-filtering), not a user edit —
          // it's never in field_stamps, so leaving it in $written_fields
          // would make it fall back to the whole-record $current.updated on
          // EVERY write, silently turning per-field CAS into an
          // any-prior-edit-anywhere CAS. Excluded from the conflict check.
          LET $written_fields = IF $current = NONE { [] } ELSE {
            object::keys($payload).filter(|$f| $f != '_sync_op_id')
          };
          LET $stamps = IF $current = NONE { {} } ELSE { $current.field_stamps ?? {} };
          LET $conflicted_fields = IF $current = NONE OR $base_updated = NONE { [] } ELSE {
            $written_fields.filter(|$f| ($stamps[$f] ?? $current.updated) > <datetime>$base_updated)
          };
          LET $is_conflict = $current = NONE OR array::len($conflicted_fields) > 0;
          IF $is_conflict {
            RETURN { conflict: true, deleted: $current = NONE, current: $current, conflicted_fields: $conflicted_fields, op_id: $op_id };
          } ELSE {
            LET $before_additionals = $current.additionals;
            UPDATE type::record($id) MERGE $payload;
            UPDATE type::record($id) MERGE { updated: time::now() };
            IF array::len($written_fields) > 0 {
              LET $now_stamp = time::now();
              UPDATE type::record($id) SET field_stamps = object::from_entries(
                array::concat(object::entries($stamps), $written_fields.map(|$f| [$f, $now_stamp]))
              );
            };
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
            RETURN (SELECT * FROM ONLY type::record($id));
          }
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
        // Whole-record CAS: if the target was edited (by anyone) after this
        // client's last-seen `updated`, surface a conflict instead of
        // silently deleting a row the user hasn't seen the latest edits to.
        // A target that's already gone ($current = NONE — e.g. a replayed
        // or duplicate DeleteTree) is NOT a conflict: deleting an
        // already-deleted row is the existing idempotent no-op behavior.
        // See the UpdateRecord case above for why this is IF/ELSE (not an
        // early-RETURN guard) — a flat top-level RETURN inside an IF block
        // does not skip later statements in the SOLO (unbatched) push path.
        return `
          LET $current = (SELECT * FROM ONLY type::record($id));
          IF $current != NONE AND $base_updated != NONE AND $current.updated > <datetime>$base_updated {
            RETURN { conflict: true, current: $current, op_id: $op_id };
          } ELSE {
            fn::delete_and_children(type::record($id));
          }
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
        // Use the schema-defined `appliesto` table (with `appliesto_changefeed`,
        // permissions, and indexes) — NOT a phantom `applies` table. The legacy
        // `->applies->` form wrote to a table that doesn't exist in the schema,
        // so edges never propagated live, weren't readable via `->appliesto->`
        // queries, and never entered `cache.appliesEdges`. Mirrors the server
        // offline_sync add_applies path and `CreateTreeBatch.appliesEdges`.
        // Idempotency guard mirrors `AddGrouping` so a replayed/duplicate op
        // returns the existing edge instead of creating a second one.
        return `
          LET $s = type::record($src);
          LET $d = type::record($dst);
          LET $existing = (SELECT * FROM appliesto WHERE in = $s AND out = $d LIMIT 1)[0];
          IF $existing != NONE {
            RETURN $existing;
          };
          RELATE $s->appliesto->$d CONTENT $payload
        `;
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
    let baseUpdated: unknown = undefined;
    if (op.kind === 'UpdateRecord' || op.kind === 'DeleteTree') {
      if ('_base_updated' in sanitized) {
        baseUpdated = sanitized._base_updated;
        delete sanitized._base_updated;
      }
    }
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
      removed_additional_ids: removedAdditionalIds,
      base_updated: baseUpdated ?? null
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
      case 'OpCancel': {
        // Another tab cancelled this op. Prune our in-memory copy (the
        // canceller already deleted it from shared IDB) and roll back the
        // optimistic rows in OUR cache too — optimistic patches were
        // broadcast cross-tab at queue time.
        const cancelled = oplog.find((o) => o.id === msg.id);
        if (cancelled && cancelled.status === 'pending') {
          cancelledOpIds.add(msg.id);
          oplog = oplog.filter((o) => o.id !== msg.id);
          rollbackOptimisticForRejection(cancelled);
        }
        removeSyncOp(config.storageNamespace, msg.id);
        break;
      }
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
      // Ops that failed during the outage are mid-backoff; without this reset
      // the eligibility filter would skip them all and this "eager" push would
      // be a no-op, stranding them until the next tick.
      for (const op of oplog) {
        if (op.status === 'pending' && op.retries > 0) op.last_attempt_at = 0;
      }
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

    // Flip the health signal to `offline` the instant the browser says so,
    // rather than waiting for the next queued/ticked pushOps() call to notice
    // (pushOps already checks navigator.onLine itself, so this listener's job
    // is purely to make the UI-facing health store reflect reality promptly).
    function handleOffline() {
      markSyncOffline(config.storageNamespace);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    schedule();
    syncLoopWake = wake;

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (retryWakeTimer) {
        clearTimeout(retryWakeTimer);
        retryWakeTimer = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
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

  function getConflictedOps(): Op[] {
    return oplog.filter(op => op.status === 'conflicted');
  }

  return {
    queueOp,
    pushOps,
    cancelOp,
    retryOp,
    resolveConflict,
    initialize,
    applyRemote,
    startSyncLoop,
    getPendingOps,
    getInflightOps,
    getConflictedOps,
    get isRunning() { return syncPromise !== null; },
    get failureCount() { return failureCount; }
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
