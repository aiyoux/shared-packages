// Composite selection token for the multi-runtime calendar scope selector.
//
// The separator is the non-printing U+241F ("symbol for unit separator") so it
// never collides with a scope record id (which contains a colon, e.g.
// `records:uuid`) or a runtimeKey (`connectionKey::userId` — colons plus the
// `::` separator). M8's composite record ids reuse the same separator, keeping
// the calendar's cross-runtime addressing scheme consistent end to end.
//
// `ALL_SCOPES_SENTINEL` is the scopeId used for "this runtime, no particular
// scope" — the multi-runtime analogue of the legacy native <select>'s "No
// scope" option. It maps to an empty `scopes` array on the fetch path.

export const COMPOSITE_SEPARATOR = '␟';
export const ALL_SCOPES_SENTINEL = '__all__';

export interface ConnectionScopeSelectScope {
  id: string;
  text: string;
}

export interface ConnectionScopeSelectGroup {
  /** `${connectionKey}::${userId}` — the runtime this group's scopes belong to. */
  runtimeKey: string;
  connectionLabel: string;
  /** OKLCH connection color (getConnectionColor); rendered as the group dot. */
  color: string;
  /** Empty when that runtime's calendar details haven't loaded yet. */
  scopes: ConnectionScopeSelectScope[];
}

export function buildScopeSelectionToken(runtimeKey: string, scopeId: string): string {
  return `${runtimeKey}${COMPOSITE_SEPARATOR}${scopeId}`;
}

export function parseScopeSelectionToken(
  token: string
): { runtimeKey: string; scopeId: string } | null {
  const idx = token.indexOf(COMPOSITE_SEPARATOR);
  if (idx < 0) return null;
  return {
    runtimeKey: token.slice(0, idx),
    scopeId: token.slice(idx + COMPOSITE_SEPARATOR.length)
  };
}