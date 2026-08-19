import { lineDomain } from './marks/line.js';
import { resolveColorToken } from './theme.js';
import type { IgfxObject, ResolvedNode, SeriesMode, Theme } from './types.js';
import { MAX_POINTS_PER_SERIES } from './types.js';

export const SERIES_GAP = 8;
export const DEFAULT_SERIES_STROKE_WIDTH = 3;
export const DEFAULT_SERIES_MARKER_R = 5;

export interface SeriesPointMotion {
	pointX?: number;
	pointY?: number;
	value?: number;
}

export interface SeriesPointSample {
	visible: boolean;
	motion: SeriesPointMotion;
}

export interface SeriesPointPose {
	px: number;
	py: number;
	pv: number;
}

export interface SeriesBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface BarRect {
	x: number;
	y: number;
	w: number;
	h: number;
	length: number;
}

function styleNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function seriesColor(obj: IgfxObject, theme: Theme): string {
	const raw = obj.style?.color;
	if (typeof raw === 'string' || typeof raw === 'number') {
		return resolveColorToken(theme, raw);
	}
	return resolveColorToken(theme, 0);
}

export function seriesPointPose(point: IgfxObject, sample?: SeriesPointSample | { motion: SeriesPointMotion }): SeriesPointPose {
	const motion = sample?.motion;
	const px = motion?.pointX ?? point.point?.x ?? 0;
	const py = motion?.pointY ?? point.point?.y ?? 0;
	const pv = motion?.value ?? point.point?.value ?? py;
	return { px, py, pv };
}

export function visiblePointChildren(
	children: IgfxObject[],
	sampled?: { get(id: string): SeriesPointSample | undefined }
): IgfxObject[] {
	const out: IgfxObject[] = [];
	for (const child of children) {
		if (child.kind !== 'point') continue;
		if (out.length >= MAX_POINTS_PER_SERIES) break;
		if (sampled) {
			const sample = sampled.get(child.id);
			if (!sample?.visible) continue;
		}
		out.push(child);
	}
	return out;
}

export function barRects(
	box: SeriesBox,
	values: number[],
	progress: number,
	horizontal = false
): BarRect[] {
	const n = values.length;
	const maxVal = Math.max(0, ...values, 0) || 1;
	const p = Number.isFinite(progress) ? progress : 1;
	const out: BarRect[] = [];
	if (n === 0) return out;
	if (horizontal) {
		const barH = Math.max(1, (box.h - SERIES_GAP * (n + 1)) / n);
		for (let i = 0; i < n; i += 1) {
			const length = (values[i] / maxVal) * box.w * p;
			const y = box.y + SERIES_GAP + i * (barH + SERIES_GAP);
			out.push({ x: box.x, y, w: Math.max(0, length), h: barH, length });
		}
		return out;
	}
	const barW = Math.max(1, (box.w - SERIES_GAP * (n + 1)) / n);
	for (let i = 0; i < n; i += 1) {
		const length = (values[i] / maxVal) * box.h * p;
		const x = box.x + SERIES_GAP + i * (barW + SERIES_GAP);
		const y = box.y + box.h - length;
		out.push({ x, y, w: barW, h: Math.max(0, length), length });
	}
	return out;
}

export function mappedLinePoints(box: SeriesBox, xs: number[], ys: number[]): { x: number; y: number }[] {
	const { x0, x1, y0, y1 } = lineDomain(xs, ys);
	const xSpan = x1 - x0 || 1;
	const ySpan = y1 - y0 || 1;
	const n = Math.min(xs.length, ys.length);
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < n; i += 1) {
		out.push({
			x: box.x + ((xs[i] - x0) / xSpan) * box.w,
			y: box.y + box.h - ((ys[i] - y0) / ySpan) * box.h
		});
	}
	return out;
}

export function mapSeriesGlyph(
	box: SeriesBox,
	mode: SeriesMode,
	index: number,
	poses: SeriesPointPose[],
	opts?: { progress?: number; horizontal?: boolean }
): { x: number; y: number } {
	if (index < 0 || index >= poses.length) return { x: box.x, y: box.y };
	if (mode === 'bars') {
		const rects = barRects(
			box,
			poses.map((p) => p.pv),
			opts?.progress ?? 1,
			opts?.horizontal === true
		);
		const rect = rects[index];
		if (!rect) return { x: box.x, y: box.y };
		return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
	}
	const pts = mappedLinePoints(
		box,
		poses.map((p) => p.px),
		poses.map((p) => p.py)
	);
	return pts[index] ?? { x: box.x, y: box.y };
}

function seriesGroup(id: string, mode: SeriesMode, children: ResolvedNode[]): ResolvedNode {
	return {
		id,
		tag: 'g',
		attrs: { opacity: '1', 'data-mode': mode },
		children
	};
}

export function renderSeries(args: {
	obj: IgfxObject;
	layout: SeriesBox;
	progress: number;
	theme: Theme;
	points: { obj: IgfxObject; sample?: SeriesPointSample }[];
}): ResolvedNode {
	const mode: SeriesMode = args.obj.series?.mode ?? 'bars';
	const color = seriesColor(args.obj, args.theme);
	const progress = Number.isFinite(args.progress) ? args.progress : 1;
	const poses = args.points.map((p) => seriesPointPose(p.obj, p.sample));
	const n = poses.length;

	if (mode === 'bars') {
		const horizontal = args.obj.style?.orientation === 'horizontal';
		const rects = barRects(
			args.layout,
			poses.map((p) => p.pv),
			progress,
			horizontal
		);
		const radius = Math.max(0, args.theme.radius);
		const children: ResolvedNode[] = rects.map((rect, i) => ({
			id: `${args.obj.id}:${i}`,
			tag: 'rect',
			attrs: {
				x: String(rect.x),
				y: String(rect.y),
				width: String(rect.w),
				height: String(rect.h),
				fill: color,
				rx: String(Math.min(radius, (horizontal ? rect.h : rect.w) / 2)),
				'data-length': String(rect.length)
			}
		}));
		return seriesGroup(args.obj.id, mode, children);
	}

	const k = Math.max(0, Math.round(n * progress));
	const drawn = mappedLinePoints(
		args.layout,
		poses.map((p) => p.px),
		poses.map((p) => p.py)
	).slice(0, k);

	if (mode === 'scatter') {
		const r = styleNumber(args.obj.style?.markerR, DEFAULT_SERIES_MARKER_R);
		const children: ResolvedNode[] = drawn.map((pt, i) => ({
			id: `${args.obj.id}:${i}`,
			tag: 'circle',
			attrs: {
				cx: String(pt.x),
				cy: String(pt.y),
				r: String(r),
				fill: color
			}
		}));
		return seriesGroup(args.obj.id, mode, children);
	}

	const pts: string[] = [];
	for (let i = 0; i < drawn.length; i += 1) {
		pts.push(`${i === 0 ? 'M' : 'L'}${drawn[i].x} ${drawn[i].y}`);
	}
	const clipW = args.layout.w * progress;
	const clipId = `${args.obj.id}-clip`;
	const strokeWidth = styleNumber(args.obj.style?.strokeWidth, DEFAULT_SERIES_STROKE_WIDTH);
	return seriesGroup(args.obj.id, mode, [
		{
			id: clipId,
			tag: 'clipPath',
			attrs: {},
			children: [
				{
					id: `${args.obj.id}:clip-rect`,
					tag: 'rect',
					attrs: {
						x: String(args.layout.x),
						y: String(args.layout.y),
						width: String(clipW),
						height: String(args.layout.h)
					}
				}
			]
		},
		{
			id: `${args.obj.id}:path`,
			tag: 'path',
			attrs: {
				d: pts.join(' '),
				fill: 'none',
				stroke: color,
				'stroke-width': String(strokeWidth),
				'stroke-linejoin': 'round',
				'stroke-linecap': 'round',
				'clip-path': `url(#${clipId})`
			}
		}
	]);
}
