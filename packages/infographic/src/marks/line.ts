import type { ResolvedNode } from '../types.js';
import { origin, rootGroup, type MarkRenderCtx } from './context.js';

function extent(values: number[], fallback = 1): { min: number; max: number } {
	if (values.length === 0) return { min: 0, max: fallback };
	let min = values[0];
	let max = values[0];
	for (const v of values) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	if (min === max) {
		if (min === 0) return { min: 0, max: fallback };
		return { min: min - Math.abs(min) * 0.1, max: max + Math.abs(max) * 0.1 };
	}
	return { min, max };
}

export function lineDomain(xs: number[], ys: number[]): {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
} {
	const xe = extent(xs);
	const ye = extent(ys);
	return { x0: xe.min, x1: xe.max, y0: ye.min, y1: ye.max };
}

export function renderLine(ctx: MarkRenderCtx): ResolvedNode {
	const series = ctx.bound.series;
	if (ctx.bound.missing || !series || series.xs.length === 0) {
		return rootGroup(ctx, [
			{
				id: `${ctx.mark.id}:path`,
				tag: 'path',
				attrs: { d: '', fill: 'none', stroke: ctx.theme.text }
			}
		]);
	}

	const { x, y, w, h } = origin(ctx);
	const { x0, x1, y0, y1 } = lineDomain(series.xs, series.ys);
	const xSpan = x1 - x0 || 1;
	const ySpan = y1 - y0 || 1;
	const pts: string[] = [];
	for (let i = 0; i < series.xs.length; i += 1) {
		const px = x + ((series.xs[i] - x0) / xSpan) * w;
		const py = y + h - ((series.ys[i] - y0) / ySpan) * h;
		pts.push(`${i === 0 ? 'M' : 'L'}${px} ${py}`);
	}

	const clipW = w * ctx.motion.progress;
	const clipId = `${ctx.mark.id}-clip`;
	return rootGroup(ctx, [
		{
			id: clipId,
			tag: 'clipPath',
			attrs: {},
			children: [
				{
					id: `${ctx.mark.id}:clip-rect`,
					tag: 'rect',
					attrs: {
						x: String(x),
						y: String(y),
						width: String(clipW),
						height: String(h)
					}
				}
			]
		},
		{
			id: `${ctx.mark.id}:path`,
			tag: 'path',
			attrs: {
				d: pts.join(' '),
				fill: 'none',
				stroke: series.color,
				'stroke-width': '3',
				'stroke-linejoin': 'round',
				'stroke-linecap': 'round',
				'clip-path': `url(#${clipId})`
			}
		}
	]);
}
