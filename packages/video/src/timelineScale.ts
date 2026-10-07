import { zoomToFitDuration } from '@shared-packages/composition';

export const BAR_HEIGHT = 44;
export const TICK_ROW_HEIGHT = 12;
export const MIN_TRIM_SPAN = 0.1;
/** Below the shared zoom floor, so a long clip can still fit the trim window. */
export const TRIM_MIN_ZOOM = 1e-6;
/** Gap used when Set as end lands before start (or Set as start after end). */
export const PLAYHEAD_TRIM_GAP = 1;
export const PLAYHEAD_NEAR_S = 0.05;

export function filmstripThumbWidth(thumbHeight: number, aspect: number): number {
	const a = aspect > 0 ? aspect : 16 / 9;
	return Math.max(24, Math.min(96, thumbHeight * a));
}

export type FilmstripCell = {
	t: number;
	left: number;
	width: number;
};

export function filmstripLayout(opts: {
	duration: number;
	trackWidth: number;
	viewLeft: number;
	viewWidth: number;
	thumbHeight: number;
	aspect: number;
	overscanPx?: number;
}): FilmstripCell[] {
	const { duration, trackWidth, viewLeft, viewWidth, thumbHeight } = opts;
	if (!(duration > 0) || trackWidth <= 0 || viewWidth <= 0 || thumbHeight <= 0) return [];
	const thumbW = filmstripThumbWidth(thumbHeight, opts.aspect);
	const overscan = opts.overscanPx ?? 80;
	const left = Math.max(0, viewLeft - overscan);
	const right = Math.min(trackWidth, viewLeft + viewWidth + overscan);
	const startIndex = Math.floor(left / thumbW);
	const endIndex = Math.ceil(right / thumbW);
	const cells: FilmstripCell[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const x = i * thumbW;
		if (x >= trackWidth) break;
		const w = Math.min(thumbW, trackWidth - x);
		const t = Math.min(duration, ((x + w / 2) / trackWidth) * duration);
		cells.push({ t, left: x / trackWidth, width: w / trackWidth });
	}
	return cells;
}

export function frameCacheKey(t: number, width: number, height: number): string {
	return `${(Math.round(t * 20) / 20).toFixed(2)}@${width}x${height}`;
}

export function slipRange(
	start: number,
	end: number,
	delta: number,
	duration: number
): { start: number; end: number } {
	const span = Math.max(0, end - start);
	if (span <= 0 || !(duration > 0)) return { start, end };
	const next = Math.max(0, Math.min(duration - span, start + delta));
	return { start: next, end: next + span };
}

export function clampTrimStart(
	t: number,
	trimEnd: number,
	_duration: number,
	minSpan = MIN_TRIM_SPAN
): number {
	return Math.max(0, Math.min(trimEnd - minSpan, t));
}

export function clampTrimEnd(
	t: number,
	trimStart: number,
	duration: number,
	minSpan = MIN_TRIM_SPAN
): number {
	return Math.max(trimStart + minSpan, Math.min(duration, t));
}

const FIT_ZOOM_EPS = 1e-4;

/**
 * Zoom a trim timeline should adopt for this duration and window.
 * A new duration always refits. A width change refits only while the zoom
 * is still the fit for the width measured last — the first layout pass is
 * often narrower than the settled popup, and keeping that zoom parks the
 * end handle part-way along the waveform. A zoom the user chose is kept.
 * Returns null when nothing should change.
 */
export function nextTrimFit(args: {
	durationMs: number;
	viewportPx: number;
	zoom: number;
	fittedDurationMs: number;
	fittedWidth: number;
}): { zoom: number; fittedDurationMs: number; fittedWidth: number } | null {
	const { durationMs, viewportPx, zoom, fittedDurationMs, fittedWidth } = args;
	if (!(durationMs > 0) || !(viewportPx > 0)) return null;
	const durationChanged = durationMs !== fittedDurationMs;
	const widthChanged = Math.abs(viewportPx - fittedWidth) >= 1;
	if (!durationChanged && !widthChanged) return null;
	if (!durationChanged && fittedWidth > 0) {
		const previous = zoomToFitDuration(durationMs, fittedWidth, TRIM_MIN_ZOOM);
		if (Math.abs(zoom - previous) > FIT_ZOOM_EPS) return null;
	}
	return {
		zoom: zoomToFitDuration(durationMs, viewportPx, TRIM_MIN_ZOOM),
		fittedDurationMs: durationMs,
		fittedWidth: viewportPx
	};
}

export function playheadNear(t: number, at: number, eps = PLAYHEAD_NEAR_S): boolean {
	return Math.abs(t - at) <= eps;
}

export function setTrimFromPlayhead(
	which: 'start' | 'end',
	playhead: number,
	trimStart: number,
	trimEnd: number,
	duration: number,
	gap = PLAYHEAD_TRIM_GAP
): { start: number; end: number } {
	const t = Math.max(0, Math.min(duration, playhead));
	if (which === 'end') {
		let end = t;
		let start = trimStart;
		if (end <= start) start = Math.max(0, end - gap);
		if (end - start < MIN_TRIM_SPAN) start = Math.max(0, end - MIN_TRIM_SPAN);
		return { start, end };
	}
	let start = t;
	let end = trimEnd;
	if (start >= end) end = Math.min(duration, start + gap);
	if (end - start < MIN_TRIM_SPAN) end = Math.min(duration, start + MIN_TRIM_SPAN);
	return { start, end };
}
