import type { AdditionalWithId } from './types.ts';

/**
 * Single read surface for the server-owned `computed_additionals` field.
 *
 * Rollup values (pg/duration/distance/stock_level/account_balance with
 * `computed: true`) live ONLY here — never in the authored `additionals`
 * array, which carries `mode: 'rollup'` marker entries instead. UI code must
 * read through these helpers rather than hand-rolling `item.computed_additionals`
 * access, so the shape can evolve in one place.
 *
 * Clients NEVER write this field to the server; optimistic local mirrors (if
 * any) must stay cache-only.
 */

type ItemLike = { computed_additionals?: unknown; additionals?: unknown } | null | undefined;

/** All server-computed value entries on an item (empty array when none). */
export function readComputedAdditionals(item: ItemLike): AdditionalWithId[] {
  const raw = (item as { computed_additionals?: unknown } | null | undefined)?.computed_additionals;
  return Array.isArray(raw) ? (raw as AdditionalWithId[]) : [];
}

/** The single computed value entry of a type (balance: first currency match). */
export function readComputedAdditional(
  item: ItemLike,
  type: string,
  currency?: string
): AdditionalWithId | null {
  for (const entry of readComputedAdditionals(item)) {
    const e = entry as Record<string, unknown>;
    if (e.type !== type) continue;
    if (currency !== undefined && typeof e.currency === 'string' && e.currency.toUpperCase() !== currency.toUpperCase()) continue;
    return entry;
  }
  return null;
}

/** True when an authored additional is a rollup opt-in marker. */
export function isRollupMarker(additional: unknown): boolean {
  return Boolean(
    additional &&
    typeof additional === 'object' &&
    (additional as Record<string, unknown>).mode === 'rollup'
  );
}

/**
 * Resolve the DISPLAY entry for an authored additional: manual entries render
 * themselves; a rollup marker renders the matching server-computed value
 * entry (same type) when it exists, falling back to the marker so config-only
 * fields (weight/desc/unit) still show before the first server round-trip.
 */
export function resolveAdditionalForDisplay(
  item: ItemLike,
  additional: AdditionalWithId
): AdditionalWithId {
  if (!isRollupMarker(additional)) return additional;
  const type = (additional as Record<string, unknown>).type as string;
  return readComputedAdditional(item, type) ?? additional;
}
