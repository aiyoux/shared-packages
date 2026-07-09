import type { LiveBusMsg } from './live.ts';
import type { CacheItem, ChildEdge } from '../cache/types.ts';

/**
 * Pure mapping layer for the server changefeed. ZERO IO — every function here
 * is a deterministic transform from a SurrealDB row/notification shape to a
 * LiveBusMsg (or a CacheItem/ChildEdge). This is split out of
 * surrealdb-live.ts purely so it can be unit-tested without a socket.
 *
 * See the LIVE SYNC ARCHITECTURE note at the top of surrealdb-live.ts for the
 * rationale (single `changes` subscription, payload.after as source of truth,
 * id-refetch fallback, idempotent re-apply).
 */

export type LiveRecordPermission = {
  role: 'owner' | 'editor-adv' | 'editor' | 'viewer';
  user_id: string;
  username?: string;
  user_icon_small?: string;
};

export function normalizeLivePermissionRole(value: unknown): LiveRecordPermission['role'] | null {
  if (value === 'owner' || value === 'editor-adv' || value === 'editor' || value === 'viewer') {
    return value;
  }
  return null;
}

export function normalizeLiveDatetime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const stringified = (value as { toString?: () => string }).toString?.();
    if (stringified && stringified !== '[object Object]') return stringified;
  }
  return undefined;
}

/**
 * A record-link field (e.g. copied_from_record from fn::group_for_clone's
 * `id AS copied_from_record`) serialises as a "tb:id" string in the LIVE
 * JSON payload, but defensively handle an object form too. Returns undefined
 * when absent so mergeItem keeps any existing cached value.
 */
export function normalizeLiveThing(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const v = value as { tb?: unknown; id?: unknown };
    if (typeof v.tb === 'string' && v.id != null) return `${v.tb}:${String(v.id)}`;
    if (v.id != null) return String(v.id);
  }
  return undefined;
}

export function normalizeLiveRecordPermissions(value: unknown): LiveRecordPermission[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const permissions: LiveRecordPermission[] = [];
  for (const rawPermission of value) {
    if (!rawPermission || typeof rawPermission !== 'object') continue;
    const source = rawPermission as Record<string, unknown>;
    const role = normalizeLivePermissionRole(source.role ?? source.r);
    const userId = source.user_id ?? source.u;
    if (!role || typeof userId !== 'string' || userId.length === 0) continue;
    permissions.push({
      role,
      user_id: userId,
      username: typeof source.username === 'string' ? source.username : undefined,
      user_icon_small: typeof source.user_icon_small === 'string' ? source.user_icon_small : undefined
    });
  }
  return permissions;
}

/** Parse a (possibly multi-statement) RPC `query` result into per-statement row arrays. */
export function parseSelectResult(result: unknown): unknown[][] {
  if (!Array.isArray(result)) return [];
  return result.map((stmt: any) => {
    if (Array.isArray(stmt)) return stmt;
    if (stmt && Array.isArray(stmt.result)) return stmt.result;
    return [];
  });
}

/**
 * Build a single CacheItem core from a full `records` row. Used identically
 * for the payload.after fast-path, the id-refetch fallback, and batch rows,
 * so all three paths produce byte-identical cache writes.
 */
export function recordCoreFromRow(row: Record<string, any>): CacheItem | null {
  const id = normalizeLiveThing(row.id);
  if (!id || !id.startsWith('records:')) return null;
  return {
    id,
    text: typeof row.text === 'string' ? row.text : '',
    // Rich-text source-of-truth. Present-key/undefined-value (like the
    // timestamps below) so mergeItem updates markup when the row carries it
    // (formatting-only edits now fire the records changefeed — see
    // $has_real_change in changefeed/schema.surql) but preserves the cached
    // markup on unrelated partial updates instead of stripping it.
    markup: typeof row.markup === 'string' ? row.markup : undefined,
    show_as_header: typeof row.show_as_header === 'boolean' ? row.show_as_header : undefined,
    custom_color: typeof row.custom_color === 'number' ? row.custom_color : undefined,
    module_settings: typeof row.module_settings === 'object' && row.module_settings ? row.module_settings : undefined,
    additionals: Array.isArray(row.additionals) ? row.additionals : undefined,
    // Server-owned rollup values — must ride along or mergeItem strips them
    // (same hazard as copied_from_record below).
    computed_additionals: Array.isArray(row.computed_additionals) ? row.computed_additionals : undefined,
    // Clone/template lineage MUST be carried — mergeItem deletes any key
    // absent from the incoming payload, so omitting these strips lineage
    // from every record on every update (broke VWT clone matching).
    copied_from_record: normalizeLiveThing(row.copied_from_record),
    original_template_id: normalizeLiveThing(row.original_template_id),
    permissions: normalizeLiveRecordPermissions(row.permissions),
    // ISO strings under the json subprotocol. Undefined when absent: mergeItem
    // sees the key missing and preserves the existing cached timestamp.
    created: normalizeLiveDatetime(row.created),
    updated: normalizeLiveDatetime(row.updated),
    is_temp: false,
    dirty: false,
    sync_status: 'accepted'
  };
}

/** Build a ChildEdge from a full `graph_child_of` row. */
export function childEdgeFromRow(row: Record<string, any>): ChildEdge | null {
  const edgeId = normalizeLiveThing(row.id);
  const child = normalizeLiveThing(row.in);
  const parent = normalizeLiveThing(row.out);
  if (!edgeId || !child || !parent) return null;
  return {
    edge_id: edgeId,
    child_id: child,
    parent_id: parent,
    order: typeof row.order === 'number' ? row.order : 0,
    is_key_parent: typeof row.key_parent === 'boolean' ? row.key_parent : true,
    module_data: typeof row.module_data === 'object' && row.module_data ? row.module_data : undefined,
    clone_setting: (row.clone_setting as any) ?? null
  };
}

/**
 * Map ONE full entity row to its upsert bus message, dispatching by id
 * prefix. `groups` rows reuse GraphChildUpsert with in=group/out=member —
 * preserving the exact mapping the previous raw-LIVE path produced.
 */
export function rowToUpsertMsg(row: Record<string, any>): LiveBusMsg | null {
  const id = normalizeLiveThing(row.id);
  if (!id) return null;
  if (id.startsWith('records:')) {
    const core = recordCoreFromRow(row);
    return core ? { type: 'RecordUpsert', core } : null;
  }
  if (id.startsWith('graph_child_of:')) {
    const edge = childEdgeFromRow(row);
    return edge ? { type: 'GraphChildUpsert', edge } : null;
  }
  if (id.startsWith('groups:')) {
    const groupId = normalizeLiveThing(row.in);
    const memberId = normalizeLiveThing(row.out);
    if (!groupId || !memberId) return null;
    return {
      type: 'GraphChildUpsert',
      edge: {
        edge_id: id,
        parent_id: groupId,
        child_id: memberId,
        order: typeof row.order === 'number' ? row.order : 0,
        is_key_parent: false,
        module_data: typeof row.module_data === 'object' && row.module_data ? row.module_data : undefined,
        clone_setting: null
      }
    };
  }
  if (id.startsWith('appliesto:')) {
    const src = normalizeLiveThing(row.in);
    const dst = normalizeLiveThing(row.out);
    if (!src || !dst) return null;
    return {
      type: 'AppliesUpsert',
      edgeId: id,
      srcId: src,
      dstId: dst,
      moduleData: typeof row.module_data === 'object' && row.module_data ? (row.module_data as Record<string, unknown>) : undefined
    };
  }
  return null;
}

export function deleteMsgForId(id: string | undefined): LiveBusMsg | null {
  if (!id) return null;
  if (id.startsWith('records:')) return { type: 'RecordDelete', id };
  if (id.startsWith('graph_child_of:') || id.startsWith('groups:')) return { type: 'GraphChildDelete', edgeId: id };
  if (id.startsWith('appliesto:')) return { type: 'AppliesDelete', edgeId: id };
  return null;
}

/** Coalesce a heterogeneous batch of rows into consolidated bus messages. */
export function batchRowsToMsgs(rows: unknown[]): LiveBusMsg[] {
  const recordCores: CacheItem[] = [];
  const childEdges: ChildEdge[] = [];
  const out: LiveBusMsg[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, any>;
    const id = normalizeLiveThing(row.id);
    if (!id) continue;
    if (id.startsWith('records:')) {
      const core = recordCoreFromRow(row);
      if (core) recordCores.push(core);
    } else if (id.startsWith('graph_child_of:')) {
      const edge = childEdgeFromRow(row);
      if (edge) childEdges.push(edge);
    } else {
      // groups / appliesto have no batch variant — emit individually,
      // identical to the single-row mapping.
      const msg = rowToUpsertMsg(row);
      if (msg) out.push(msg);
    }
  }
  if (recordCores.length > 0) out.unshift({ type: 'RecordBatchUpsert', cores: recordCores });
  if (childEdges.length > 0) out.push({ type: 'GraphChildBatchUpsert', edges: childEdges });
  return out;
}
