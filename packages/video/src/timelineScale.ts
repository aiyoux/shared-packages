import { formatTimecode } from './time.js';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 50;
export const BAR_HEIGHT = 44;
export const TICK_ROW_HEIGHT = 18;
export const MIN_TRIM_SPAN = 0.1;
export const TICK_MIN_MAJOR_PX = 48;

const NICE_SECONDS = [
	0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600
];

export function pxPerSecond(duration: number, trackWidth: number): number {
	if (!(duration > 0) || !(trackWidth > 0)) return 0;
	return trackWidth / duration;
}

export function pickTickInterval(pxPerSec: number, minPx = TICK_MIN_MAJOR_PX): number {
	if (!(pxPerSec > 0)) return 60;
	for (const s of NICE_SECONDS) {
		if (s * pxPerSec >= minPx) return s;
	}
	return NICE_SECONDS[NICE_SECONDS.length - 1]!;
}

export type TimelineTick = {
	t: number;
	major: boolean;
	label: string | null;
	align: 'start' | 'center' | 'end';
};

function nearlyMultipleUs(tUs: number, stepUs: number): boolean {
	if (stepUs <= 0) return false;
	const q = Math.round(tUs / stepUs);
	return Math.abs(tUs - q * stepUs) < 2;
}

function formatTickLabel(t: number, major: number): string {
	return formatTimecode(t, major < 1);
}

export function timelineTicks(duration: number, pxPerSec: number): TimelineTick[] {
	if (!(duration > 0) || !(pxPerSec > 0)) return [];
	const major = pickTickInterval(pxPerSec);
	const majorIdx = NICE_SECONDS.indexOf(major);
	const minor = majorIdx > 0 ? NICE_SECONDS[majorIdx - 1]! : major;
	const showMinor = minor < major && minor * pxPerSec >= 8;
	const step = showMinor ? minor : major;
	const stepUs = Math.max(1, Math.round(step * 1e6));
	const majorUs = Math.max(stepUs, Math.round(major * 1e6));
	const durationUs = Math.round(duration * 1e6);
	const ticks: TimelineTick[] = [];
	for (let u = 0; u <= durationUs; u += stepUs) {
		const t = u / 1e6;
		const isMajor = nearlyMultipleUs(u, majorUs);
		const frac = t / duration;
		ticks.push({
			t,
			major: isMajor,
			label: isMajor ? formatTickLabel(t, major) : null,
			align: frac < 0.04 ? 'start' : frac > 0.96 ? 'end' : 'center'
		});
	}
	return ticks;
}

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

export function zoomToRange(opts: {
	duration: number;
	start: number;
	end: number;
	padding?: number;
	maxZoom?: number;
}): { zoom: number; startFrac: number } {
	const duration = opts.duration;
	const span = Math.max(0, opts.end - opts.start);
	if (!(duration > 0) || span <= 0) return { zoom: MIN_ZOOM, startFrac: 0 };
	const padding = opts.padding ?? 0.15;
	const frac = span / duration;
	const zoom = Math.min(opts.maxZoom ?? MAX_ZOOM, Math.max(MIN_ZOOM, 1 / (frac * (1 + padding))));
	const viewFrac = 1 / zoom;
	const padFrac = viewFrac * (padding / (1 + padding));
	const maxStart = Math.max(0, 1 - viewFrac);
	const startFrac = Math.min(maxStart, Math.max(0, opts.start / duration - padFrac));
	return { zoom, startFrac };
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
