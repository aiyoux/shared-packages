/**
 * Coalesced scrub seeking for the editor transports.
 *
 * The file preview's player (`FeVideoPlayer`) scrubs smoothly by letting each
 * in-flight seek decode its frame before the drag's latest position replaces
 * it, pausing during the drag and resuming at the exact release point. The
 * editor's transports (video, crop preview, audio) share that behaviour
 * through these pure decisions; the components own the pointer capture, the
 * animation frame and the element itself.
 */

/** Clamp a scrub target into the clip. A clip without duration seeks nowhere. */
export function clampScrubTarget(target: number, duration: number): number {
	if (!(duration > 0)) return 0;
	if (!Number.isFinite(target)) return 0;
	return Math.max(0, Math.min(duration, target));
}

export type ScrubElementState = {
	/** The element is still decoding a previous seek. */
	seeking: boolean;
	/** `HTMLMediaElement.readyState`; 0 means no metadata yet. */
	readyState: number;
};

/**
 * Whether a queued scrub seek must wait. A drag that replaces an unfinished
 * seek on every pointer move can leave the element frozen on its old frame,
 * so intermediate positions defer while the element is seeking; the release
 * (`final`) always applies the latest position. Nothing seeks before the
 * element knows its metadata.
 */
export function shouldDeferScrubSeek(state: ScrubElementState, final: boolean): boolean {
	if (state.readyState === 0) return true;
	if (state.seeking && !final) return true;
	return false;
}

/**
 * What the clock shows: the drag's live position while scrubbing, otherwise
 * the element's time. Mirrors the preview player's displayed time.
 */
export function scrubDisplayTime(
	scrubbing: boolean,
	hoverTime: number | null,
	elementTime: number
): number {
	return scrubbing && hoverTime !== null ? hoverTime : elementTime;
}
