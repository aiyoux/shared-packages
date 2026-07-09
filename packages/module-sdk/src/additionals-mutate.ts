import type { AdditionalWithId } from './types.ts';
import { validateAdditionals } from './additional-validate.ts';

/**
 * Single write surface for authored-additionals mutations.
 *
 * The wire format is a per-id TOMBSTONE MERGE (see fn::merge_additionals):
 * an UpdateRecord payload carries only the UPSERTED entries plus an explicit
 * `removed_additional_ids` list — omission never deletes, so two devices
 * editing different additionals on one record don't clobber each other.
 * Locally the cache stays full-array: this helper computes the next full
 * array for the optimistic patch AND the merge-shaped op payload in one step,
 * so the two can't drift.
 *
 * Every upsert is stamped with a client-clock `updated_at` (the server's
 * per-id LWW comparand — edit time, not arrival time, wins for offline
 * queues) and server-computed entries are refused outright.
 */

export interface AdditionalsMutation {
  /** Entries to add or replace (matched by id). */
  upserts?: AdditionalWithId[];
  /** Ids to delete — the ONLY way an entry is ever removed. */
  removedIds?: string[];
}

export interface AdditionalsMutationResult {
  /** The full post-mutation array for optimistic cache patching. */
  nextAdditionals: AdditionalWithId[];
  /** Merge-shaped UpdateRecord payload fields (spread into the op payload). */
  opPayload: {
    additionals?: AdditionalWithId[];
    removed_additional_ids?: string[];
  };
}

function isComputedEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>).computed === true);
}

/** Stamp a client-clock updated_at unless the caller already provided one. */
export function stampAdditionalUpdatedAt(entry: AdditionalWithId, now = new Date()): AdditionalWithId {
  const raw = entry as unknown as Record<string, unknown>;
  if (raw.updated_at !== undefined && raw.updated_at !== null) return entry;
  return { ...raw, updated_at: now.toISOString() } as unknown as AdditionalWithId;
}

/**
 * Pure local mirror of fn::merge_additionals: in-place upsert by id (order
 * preserved, unknown ids append), then removals win unconditionally. No LWW
 * comparison locally — the local caller IS the latest edit.
 */
export function mergeAdditionalsLocal(
  current: AdditionalWithId[] | null | undefined,
  upserts: AdditionalWithId[],
  removedIds: string[]
): AdditionalWithId[] {
  const base = current ?? [];
  const byId = new Map(upserts.map((entry) => [String(entry.id), entry]));
  const replaced = base.map((entry) => byId.get(String(entry.id)) ?? entry);
  const baseIds = new Set(base.map((entry) => String(entry.id)));
  const appended = upserts.filter((entry) => !baseIds.has(String(entry.id)));
  const removed = new Set(removedIds.map(String));
  return [...replaced, ...appended].filter((entry) => !removed.has(String(entry.id)));
}

export function applyAdditionalsMutation(
  item: { additionals?: AdditionalWithId[] } | null | undefined,
  mutation: AdditionalsMutation,
  now = new Date()
): AdditionalsMutationResult {
  const rawUpserts = mutation.upserts ?? [];
  const computed = rawUpserts.filter(isComputedEntry);
  if (computed.length > 0) {
    throw new Error(
      'applyAdditionalsMutation: refusing to queue server-computed entries ' +
      '(rollup values are server-owned; author a mode:"rollup" marker instead)'
    );
  }
  const invalidReason = validateAdditionals(rawUpserts);
  if (invalidReason) {
    // Mirrors the server chokepoint: queueing this would strand the op as a
    // sync_ops rejection and wedge the item's sync indicator.
    throw new Error(`applyAdditionalsMutation: ${invalidReason}`);
  }
  const upserts = rawUpserts.map((entry) => stampAdditionalUpdatedAt(entry, now));
  const removedIds = (mutation.removedIds ?? []).map(String);

  const nextAdditionals = mergeAdditionalsLocal(item?.additionals, upserts, removedIds);

  const opPayload: AdditionalsMutationResult['opPayload'] = {};
  if (upserts.length > 0) opPayload.additionals = upserts;
  if (removedIds.length > 0) opPayload.removed_additional_ids = removedIds;

  return { nextAdditionals, opPayload };
}
