/**
 * Presence colour and name clamp, shared by every collab product.
 *
 * Colour is a design-system categorical token, not a hex: a token resolves in
 * the receiving app's theme, so a peer stays legible on light and dark. The
 * 31-hash is stable for the life of a clientId and costs no round trip.
 */

export const PRESENCE_COLORS = [
	'var(--cat-blue)',
	'var(--cat-emerald)',
	'var(--cat-amber)',
	'var(--cat-violet)',
	'var(--cat-rose)'
] as const;

/** A remote name is drawn as-is; clamp it so a peer cannot paint a banner. */
export const MAX_PRESENCE_NAME = 24;

export function colorForClient(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}
