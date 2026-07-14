export interface CacheItem {
  id: string;
  text: string;
  markup?: string;
  show_as_header?: boolean;
  /** Inline icon for the record: raw SVG markup (`svg`) or a short text glyph
   * (`short`). Ported from wisewords; carried on CacheItem so the LIVE path and
   * inlined `grouping` records keep the icon. */
  svg?: string;
  short?: string;
  has_parent?: boolean;
  custom_color?: number;
  is_temp: boolean;
  permissions?: ItemPermissions[];
  additionals?: AdditionalWithId[];
  /**
   * Server-owned rollup values — read-only mirror of records.computed_additionals.
   * Like copied_from_record below: mergeItem deletes any key absent from an
   * incoming payload, so EVERY record source feeding the cache (fetch cores,
   * changefeed-convert's RecordUpsert core, snapshot) MUST carry this field or
   * rollup values silently vanish from the UI on the next merge.
   */
  computed_additionals?: AdditionalWithId[];
  settings?: Record<string, unknown>;
  module_settings?: Record<string, unknown>;
  version?: number;
  /**
   * Clone/template lineage — PER-NODE (this clone's own immediate source).
   * See the Item type's copied_from_record docs for the full invariant.
   * Modelled here (not just on Item) so the cache + LIVE path carry it:
   * mergeItem deletes any key absent from an incoming payload, so every
   * record source (incl. the LIVE RecordUpsert core) MUST include these or
   * server-originated clones silently lose their lineage (broke VWT).
   */
  copied_from_record?: string;
  /** See copied_from_record above — same per-node invariant. */
  original_template_id?: string;
  /** ISO timestamp; set once at server-side CREATE, never overwritten by UPDATE. */
  created?: string;
  /** ISO timestamp; refreshed on every server-side mutation. UI reads this for sort. */
  updated?: string;
  dirty: boolean;
  sync_status: SyncStatus;
}

export type CacheMutationEvent =
  | { type: 'ItemUpsert'; item: CacheItem }
  | { type: 'ItemDelete'; id: string }
  | { type: 'EdgeUpsert'; edge: ChildEdge }
  | { type: 'EdgeDelete'; edgeId: string }
  | { type: 'RecordPatchModuleSettings'; id: string; moduleSettings: Record<string, unknown> }
  | { type: 'AppliesUpsert'; edge: AppliesEdge }
  | { type: 'AppliesDelete'; edgeId: string }
  | { type: 'ScopeDayUpsert'; scope: string; bucket: string; itemIds: string[] }
  | { type: 'SyncIdle' }
  | { type: 'TempIdRemap'; tempId: string; realId: string }
  | { type: 'Clear' }
  | { type: 'RecordSyncStatus'; id: string; status: SyncStatus };

export type SyncStatus = 'pending' | 'inflight' | 'accepted' | 'rejected' | 'conflicted';

export interface ItemPermissions {
  role: 'owner' | 'editor-adv' | 'editor' | 'viewer';
  user_id: string;
  username?: string;
  user_icon_small?: string;
}

import type { AdditionalWithId } from '../types.js';
export type { AdditionalWithId };

export type CloneSetting = 'default' | 'link_to_common_clone' | 'link_to_original';

export interface ChildEdge {
  edge_id: string;
  child_id: string;
  parent_id: string;
  order: number;
  is_key_parent: boolean;
  module_data?: Record<string, unknown>;
  /**
   * How this graph_child_of relationship is treated when its subtree is
   * cloned. `default` (or absent) → clone the child. `link_to_common_clone`
   * → reuse a clone of the child if one exists in the cloned set.
   * `link_to_original` → don't clone the child; link the original child
   * under the cloned parent. Mirrors the server `clone_setting` field.
   */
  clone_setting?: CloneSetting | null;
}

export interface AppliesEdge {
  edge_id: string;
  src_id: string;
  dst_id: string;
  module_data?: Record<string, unknown>;
}

export interface ScopeBucketSlice {
  scope: string;
  bucket: string;
  item_ids: Set<string>;
  last_write_epoch: number;
}

export interface RecordKey {
  scope: string;
  bucket: string;
  id: string;
}

export interface ScopeBucketKey {
  scope: string;
  bucket: string;
}

export interface EntityMeta {
  version?: number;
  updated?: string;
  dirty: boolean;
  optimistic_id?: string;
  sync_status?: SyncStatus;
  sync_error?: string;
}

export type OpKind =
  | 'CreateRecord'
  | 'UpdateRecord'
  | 'AddChild'
  | 'RemoveChild'
  | 'MoveChild'
  | 'AddGrouping'
  | 'RemoveGrouping'
  | 'AddApplies'
  | 'RemoveApplies'
  | 'DeleteTree'
  | 'UpdateEdge'
  | 'CreateTreeBatch'
  | 'UpdateRecordsBatch'
  | 'UpdateRelationsBatch';

export interface CreateTreeBatchRecord {
  tempId: string;
  content: Record<string, unknown>;
}

export type CreateTreeBatchParentRef =
  | { kind: 'temp'; tempId: string }
  | { kind: 'real'; id: string };

export type CreateTreeBatchChildRef =
  | { kind: 'temp'; tempId: string }
  | { kind: 'real'; id: string };

export interface CreateTreeBatchEdge {
  tempEdgeId: string;
  /**
   * The cloned (temp) child this edge points at. Retained for back-compat
   * and the common `default` clone case. When `childRef` is present it takes
   * precedence (lets `link_to_original` link an existing real record under a
   * cloned parent).
   */
  childTempId: string;
  /** Optional explicit child ref; `{kind:'real'}` links an existing record. */
  childRef?: CreateTreeBatchChildRef;
  parentRef: CreateTreeBatchParentRef;
  order: number;
  key_parent: boolean;
  /** Persisted onto the recreated graph_child_of edge (default if absent). */
  cloneSetting?: CloneSetting | null;
  /** Persisted onto the recreated graph_child_of edge. */
  moduleData?: Record<string, unknown>;
}

export interface CreateTreeBatchGroupEdge {
  tempEdgeId: string;
  childTempId: string;
  groupId: string;
  /** Optional structural metadata persisted onto the recreated groups edge. */
  moduleData?: Record<string, unknown>;
}

export type CreateTreeBatchAppliesRef =
  | { kind: 'temp'; tempId: string }
  | { kind: 'real'; id: string };

export interface CreateTreeBatchAppliesEdge {
  tempEdgeId: string;
  srcRef: CreateTreeBatchAppliesRef;
  dstRef: CreateTreeBatchAppliesRef;
  moduleData?: Record<string, unknown>;
}

export interface CreateTreeBatchPayload {
  /** Client-resolved template clones to create atomically. */
  records: CreateTreeBatchRecord[];
  /** Parent/child relationships for the created records. */
  edges: CreateTreeBatchEdge[];
  /** Groups edges to recreate on cloned records (copied from source items). */
  groupEdges?: CreateTreeBatchGroupEdge[];
  /** Applies edges to recreate on cloned records (copied from source items). */
  appliesEdges?: CreateTreeBatchAppliesEdge[];
  /** Optimistic record ids inserted into the cache before the round-trip; removed on success in favor of the real ids. */
  optimisticTempIds: string[];
  /** Optimistic graph_child_of edge ids inserted into the cache before the round-trip; removed on success. */
  optimisticTempEdgeIds: string[];
  /** Optimistic groups edge ids inserted into the cache before the round-trip; removed on success. */
  optimisticGroupTempEdgeIds?: string[];
  /** Optimistic appliesto edge ids inserted into the cache before the round-trip; removed on success. */
  optimisticAppliesTempEdgeIds?: string[];
}

export interface UpdateRecordsBatchRecord {
  /** Real `records:<id>` id of the row to update. */
  id: string;
  /** Replacement additionals array (omitted ⇒ field untouched). */
  additionals?: unknown[];
  /** Replacement text (omitted ⇒ field untouched). */
  text?: string;
  /** Any other record fields to MERGE (custom_color, settings, …). */
  [field: string]: unknown;
}

export interface UpdateRecordsBatchPayload {
  /**
   * Records to field-update atomically. The whole set produces ONE
   * consolidated changefeed entry (fn::log_batch_clone) instead of one
   * `records` event per row — see LIVE SYNC ARCHITECTURE in surrealdb-live.ts.
   */
  records: UpdateRecordsBatchRecord[];
}

/**
 * Batched group/applies relation deltas for an EXISTING record. Collapses what
 * would otherwise be N `AddGrouping`/`RemoveGrouping`/`AddApplies`/
 * `RemoveApplies` ops (N HTTP transactions — the SDK has no coalescing) into a
 * single op / single SQL transaction. The prime mover: editing a calendar event
 * and applying a template that changes many `groups` memberships at once.
 *
 * Adds are idempotent on replay (each RELATE is guarded by an `in`/`out`
 * existence check, mirroring the individual `AddGrouping` op); removes are
 * plain `DELETE type::record($id)` (idempotent against an already-deleted edge).
 * Edges are NOT tagged with `_sync_op_id` — idempotency comes from the `in`/`out`
 * guard, not the op-id marker, so this kind is excluded from `shouldStampMarker`.
 * Each RELATE/DELETE emits its own changefeed event (no `skip_changefeed`), so
 * live propagation to other tabs/devices is identical to the per-op path — only
 * the op count and HTTP request count drop.
 */
export interface UpdateRelationsBatchPayload {
  /** `RELATE <group>->groups-><member>` deltas. `src` is the group, `dst` the member. */
  addGroups: { src: string; dst: string }[];
  /** `DELETE groups:<id>` — concrete `groups:` edge ids from the cache. */
  removeGroups: { id: string }[];
  /** `RELATE <src>->appliesto-><dst>` deltas. */
  addApplies: { src: string; dst: string }[];
  /** `DELETE appliesto:<id>` — concrete `appliesto:` edge ids from the cache. */
  removeApplies: { id: string }[];
}

export type OpStatus = 'pending' | 'inflight' | 'accepted' | 'rejected' | 'conflicted';

export interface Op {
  id: string;
  kind: OpKind;
  payload: unknown;
  status: OpStatus;
  /** epoch ms when queued. Set once. */
  created: number;
  retries: number;
  last_error?: string;
  /**
   * Classification of `last_error`, stamped at catch time (not re-derived from
   * the persisted string later — error object shape, e.g. TypeError/AbortError,
   * is only reliable at the original catch site). Drives which backoff curve
   * `backoffForOp` uses and whether the op is exempt from `MAX_RETRIES`:
   * `network` (offline / fetch failure / timeout) and `conflict` (SurrealDB
   * transaction conflict) both retry forever; `server` (validation, bad SQL,
   * genuine rejection) keeps the finite retry cap.
   */
  last_error_kind?: 'network' | 'conflict' | 'server';
  last_attempt_at?: number;
  /** epoch ms; refreshed on every status transition. */
  updated?: number;
  /**
   * Set only when `status === 'conflicted'`: the server's authoritative
   * current row (or edge) at conflict time, as returned by the field-stamp
   * CAS check in `build_op_sql`. Consumed by `resolveConflict` — 'take-theirs'
   * applies this to the cache; 'keep-mine' re-stamps `base_updated` from its
   * `updated` field and re-queues.
   */
  conflictCurrent?: Record<string, unknown> | null;
}

export function make_record_key(scope: string, bucket: string, id: string): RecordKey {
  return { scope, bucket, id };
}

export function scope_bucket_key(scope: string, bucket: string): string {
  return `${scope}:${bucket}`;
}

export function date_to_bucket_key(year: number, month: number, day: number): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${year.toString().padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/**
 * Bucket key (`YYYY-MM-DD`) for the **local** calendar day of a `Date`.
 *
 * Calendar bucketing keys on the user's LOCAL Y/M/D, not UTC — so for a user in
 * UTC+10, an instant of `2026-07-04T14:00:00Z` buckets to `2026-07-05`. Both the
 * date-range hydrator and the optimistic-placement reconciler MUST funnel
 * through this single helper so their buckets always agree; divergence here
 * silently drops/duplicates events across the day boundary.
 */
export function date_to_local_bucket(date: Date): string {
  return date_to_bucket_key(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function scope_key_from_list(scope_ids: string[] | null | undefined): string {
  if (!scope_ids || scope_ids.length === 0) {
    return '';
  }
  const sorted = [...scope_ids].sort();
  return sorted.join(',');
}
