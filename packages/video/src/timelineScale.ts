export const BAR_HEIGHT = 44;
export const TICK_ROW_HEIGHT = 12;
export const MIN_TRIM_SPAN = 0.1;

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
