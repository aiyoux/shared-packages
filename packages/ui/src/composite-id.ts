// Composite record id for the aggregated (multi-runtime) calendar.
//
// When the calendar renders events from several runtimes (connections) in one
// view, a bare item id (`records:uuid` / `temp:uuid`) is no longer unique — two
// connections can each own a `records:<same-uuid>`. We disambiguate by prefixing
// the item id with its owning `runtimeKey` (`connectionKey::userId`) using the
// same non-printing `COMPOSITE_SEPARATOR` (U+241F) the scope-selection token
// uses. Neither a runtimeKey (`::` + colons) nor an item id (colons) contains
// `␟`, so splitting on the FIRST `␟` is unambiguous. With a single runtime
// selected the `runtimeKey␟` prefix is constant, so a composite-keyed structure
// is isomorphic to the legacy bare-id one — single-connection behavior stays
// byte-for-byte. See [[m7-aggregated-calendar]] / M8.

import { COMPOSITE_SEPARATOR } from './connection-scope-select.ts';

export function buildCompositeId(runtimeKey: string, itemId: string): string {
  return `${runtimeKey}${COMPOSITE_SEPARATOR}${itemId}`;
}

export function isCompositeId(cId: string): boolean {
  return cId.indexOf(COMPOSITE_SEPARATOR) !== -1;
}

export function parseCompositeId(
  cId: string
): { runtimeKey: string; itemId: string } | null {
  const idx = cId.indexOf(COMPOSITE_SEPARATOR);
  if (idx < 0) return null;
  return {
    runtimeKey: cId.slice(0, idx),
    itemId: cId.slice(idx + COMPOSITE_SEPARATOR.length)
  };
}

/** Dev guard: throws if `cId` is not a composite id (missing the separator). */
export function assertCompositeId(cId: string): void {
  if (!isCompositeId(cId)) {
    throw new Error(`assertCompositeId: expected a composite id (runtimeKey␟itemId), got: ${cId}`);
  }
}