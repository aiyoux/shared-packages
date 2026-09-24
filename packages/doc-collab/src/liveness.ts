/**
 * How a collab peer stays "still here" when one tab is in the background.
 *
 * A hidden tab's timers are clamped — about a minute, once the browser
 * decides the tab is idle. A sweep that only trusts those timers drops a
 * live peer and then draws it again when a late tick arrives. That is the
 * Documents tree dot blinking, a Creative cursor vanishing, and a call's
 * gateway looking gone so a sibling elects a second sequencer.
 *
 * The rule, in one place:
 * - Re-announce on `COLLAB_HEARTBEAT_MS` while the tab is visible.
 * - Also ASK. The other tab answers from its message handler, which still
 *   runs when its timers do not.
 * - Forget a peer only after `COLLAB_STALE_MS` of silence. That is longer
 *   than one clamped timer tick, so a single missed answer is not a leave.
 * - An explicit release is immediate and does not wait out the stale window.
 */

export const COLLAB_HEARTBEAT_MS = 4_000;

/** Longer than a background tab's clamped timer (~1 min), with room for one miss. */
export const COLLAB_STALE_MS = 90_000;

/** Ids last heard before `now - staleMs`. Does not mutate `seen`. */
export function staleIds(
	seen: ReadonlyMap<string, number>,
	now: number,
	staleMs = COLLAB_STALE_MS
): string[] {
	const cutoff = now - staleMs;
	const gone: string[] = [];
	for (const [id, at] of seen) if (at < cutoff) gone.push(id);
	return gone;
}
