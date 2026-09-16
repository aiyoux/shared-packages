/**
 * Timeline viewport algebra — the maths behind a horizontally scrollable,
 * zoomable timeline whose content is wider than the window it shows through.
 * Includes fit-to-duration and zoom-to-range helpers used by the video trimmer.
 *
 * Framework-agnostic and stateless: callers hold `zoom` + `scrollX`, feed them
 * in with the measured `viewportPx` and the `durationMs` being laid out, and get
 * back the derived scale, clamps, and time↔pixel maps. All pixel values are in
 * CSS pixels of *content space* (before the `-scrollX` translate); screen x is
 * `timeToPx(ms) - scrollX`.
 *
 * `zoom` is a multiplier over a fixed reference scale ({@link BASE_PX_PER_MS}),
 * not over fit-to-width: `zoom === 1` always lays out the same amount of time
 * per pixel, so a wider window simply shows more of the timeline rather than
 * squeezing the same duration into less space. A shorter clip and a longer one
 * look identically dense at the same zoom — only the content width (and thus
 * how much you need to scroll) differs.
 */

/** Reference scale at `zoom === 1`: ~10s spans a typical widescreen timeline
 *  pane. Independent of `viewportPx` and `durationMs` — halving the pane width
 *  halves the visible duration instead of re-fitting the whole clip. */
export const BASE_PX_PER_MS = 0.12;
/** Multiplier bounds for {@link clampZoom}, symmetric around the 1x reference
 *  scale (64x in, 64x out). */
export const MIN_ZOOM = 1 / 64;
export const MAX_ZOOM = 64;
/** Factor a single zoom-in / zoom-out button press multiplies / divides by. */
export const ZOOM_STEP = 1.5;

/** Candidate ruler tick spacings, ascending. {@link pickTickStepMs} walks these. */
export const TICK_STEPS_MS = [
	10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000,
	60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface TimelineViewportInput {
	/** Length of the content being laid out, in milliseconds. */
	durationMs: number;
	/** Measured width of the visible window, in CSS pixels. */
	viewportPx: number;
	/** Zoom multiplier over the fixed reference scale (see module docs). Clamped
	 *  on the way in. */
	zoom: number;
	/** Horizontal scroll offset in content pixels. Clamped to `[0, maxScrollX]`. */
	scrollX: number;
}

export interface TimelineViewport extends TimelineViewportInput {
	/** Reference scale at `zoom === 1` — always {@link BASE_PX_PER_MS}. */
	basePxPerMs: number;
	/** Effective scale actually in use: `basePxPerMs * zoom` (0 when duration is 0). */
	pxPerMs: number;
	/** Total laid-out width of the content, in pixels. */
	contentPx: number;
	/** Largest valid `scrollX` — 0 when the content fits the window. */
	maxScrollX: number;
	/** First / last millisecond currently visible through the window. */
	visibleStartMs: number;
	visibleEndMs: number;
	/** Content-space pixel x for a time (no scroll applied). */
	timeToPx(ms: number): number;
	/** Time for a content-space pixel x (no scroll applied). */
	pxToTime(px: number): number;
}

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return MIN_ZOOM;
	return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Resolve raw `{ durationMs, viewportPx, zoom, scrollX }` into the full derived
 * viewport. `zoom` and `scrollX` are clamped, so the result is always coherent.
 */
export function createTimelineViewport(input: TimelineViewportInput): TimelineViewport {
	const durationMs = Math.max(0, input.durationMs);
	const viewportPx = Math.max(0, input.viewportPx);
	const zoom = clampZoom(input.zoom);
	const basePxPerMs = BASE_PX_PER_MS;
	const pxPerMs = durationMs > 0 ? basePxPerMs * zoom : 0;
	const contentPx = durationMs * pxPerMs;
	const maxScrollX = Math.max(0, contentPx - viewportPx);
	const scrollX = clamp(input.scrollX, 0, maxScrollX);
	const timeToPx = (ms: number) => ms * pxPerMs;
	const pxToTime = (px: number) => (pxPerMs > 0 ? px / pxPerMs : 0);
	return {
		durationMs,
		viewportPx,
		zoom,
		scrollX,
		basePxPerMs,
		pxPerMs,
		contentPx,
		maxScrollX,
		visibleStartMs: pxToTime(scrollX),
		visibleEndMs: pxToTime(scrollX + viewportPx),
		timeToPx,
		pxToTime
	};
}

/** Clamp an arbitrary scroll offset to this viewport's valid range. */
export function clampScrollX(vp: TimelineViewport, scrollX: number): number {
	return clamp(scrollX, 0, vp.maxScrollX);
}

/** Zoom that lays the whole duration into `viewportPx` (`contentPx === viewportPx`). */
export function zoomToFitDuration(durationMs: number, viewportPx: number): number {
	if (!(durationMs > 0) || !(viewportPx > 0)) return clampZoom(1);
	return clampZoom(viewportPx / (durationMs * BASE_PX_PER_MS));
}

/**
 * Zoom + scroll so `[startMs, endMs]` fills the window, with `padding` extra
 * space (0.15 = 15% of the window) around the range.
 */
export function zoomToTimeRange(
	durationMs: number,
	viewportPx: number,
	startMs: number,
	endMs: number,
	padding = 0.15
): { zoom: number; scrollX: number } {
	const span = Math.max(0, Math.min(durationMs, endMs) - Math.max(0, startMs));
	if (!(durationMs > 0) || !(viewportPx > 0) || span <= 0) {
		return { zoom: zoomToFitDuration(durationMs, viewportPx), scrollX: 0 };
	}
	const zoom = clampZoom(viewportPx / (span * BASE_PX_PER_MS * (1 + padding)));
	const vp = createTimelineViewport({ durationMs, viewportPx, zoom, scrollX: 0 });
	const padPx = vp.viewportPx * (padding / (1 + padding));
	return { zoom, scrollX: clampScrollX(vp, vp.timeToPx(Math.max(0, startMs)) - padPx) };
}

/**
 * New `{ zoom, scrollX }` for a zoom change that keeps the instant currently
 * under `anchorPx` (a screen x, measured from the window's left edge) pinned to
 * that same pixel. This is the wheel / pinch "zoom towards the pointer" gesture.
 */
export function zoomAtAnchor(
	vp: TimelineViewport,
	nextZoom: number,
	anchorPx: number
): { zoom: number; scrollX: number } {
	const zoom = clampZoom(nextZoom);
	const nextPxPerMs = vp.durationMs > 0 ? vp.basePxPerMs * zoom : 0;
	const timeAtAnchor = vp.pxToTime(vp.scrollX + anchorPx);
	const nextContentPx = vp.durationMs * nextPxPerMs;
	const nextMaxScrollX = Math.max(0, nextContentPx - vp.viewportPx);
	const scrollX = clamp(timeAtAnchor * nextPxPerMs - anchorPx, 0, nextMaxScrollX);
	return { zoom, scrollX };
}

/**
 * Scroll offset that brings `playheadMs` back inside the window, leaving at least
 * `marginPx` of breathing room at whichever edge it crossed. Returns the current
 * `scrollX` untouched when the playhead is already comfortably in view — so it is
 * safe to call every animation frame.
 */
export function followPlayhead(
	vp: TimelineViewport,
	playheadMs: number,
	marginPx = 24
): number {
	if (vp.maxScrollX <= 0) return vp.scrollX;
	const headPx = playheadMs * vp.pxPerMs;
	const margin = Math.min(marginPx, vp.viewportPx / 2);
	const leftBound = vp.scrollX + margin;
	const rightBound = vp.scrollX + vp.viewportPx - margin;
	let next = vp.scrollX;
	if (headPx < leftBound) next = headPx - margin;
	else if (headPx > rightBound) next = headPx - (vp.viewportPx - margin);
	return clamp(next, 0, vp.maxScrollX);
}

/**
 * Smallest {@link TICK_STEPS_MS} entry whose on-screen spacing is at least
 * `minLabelGapPx`. Falls back to the coarsest step when even that is too tight.
 */
export function pickTickStepMs(pxPerMs: number, minLabelGapPx = 68): number {
	if (pxPerMs <= 0) return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
	for (const step of TICK_STEPS_MS) {
		if (step * pxPerMs >= minLabelGapPx) return step;
	}
	return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

export interface RulerTick {
	/** Tick time in milliseconds. */
	ms: number;
	/** Content-space pixel x (apply `-scrollX` for screen position). */
	x: number;
}

/**
 * Evenly spaced ruler ticks covering the visible window (plus one step of
 * overscan each side so labels don't pop at the edges). Spacing adapts to zoom
 * via {@link pickTickStepMs}.
 */
export function rulerTicks(
	vp: TimelineViewport,
	opts: { minLabelGapPx?: number } = {}
): RulerTick[] {
	if (vp.durationMs <= 0 || vp.pxPerMs <= 0) return [];
	const step = pickTickStepMs(vp.pxPerMs, opts.minLabelGapPx);
	const first = Math.max(0, Math.floor(vp.visibleStartMs / step) * step - step);
	const last = Math.min(vp.durationMs, vp.visibleEndMs + step);
	const out: RulerTick[] = [];
	for (let ms = first; ms <= last + 0.5; ms += step) {
		out.push({ ms, x: ms * vp.pxPerMs });
	}
	return out;
}

/**
 * Position and width, as fractions `[0, 1]` of the full duration, of the slice
 * currently visible through the window. Drives a minimap's viewport rectangle.
 */
export function viewportWindowFraction(vp: TimelineViewport): { left: number; width: number } {
	if (vp.contentPx <= 0) return { left: 0, width: 1 };
	const width = clamp(vp.viewportPx / vp.contentPx, 0, 1);
	const left = clamp(vp.scrollX / vp.contentPx, 0, 1 - width);
	return { left, width };
}
