import type { ResolvedNode } from '../types.js';
import { origin, rootGroup, type MarkRenderCtx } from './context.js';

export function renderBar(ctx: MarkRenderCtx): ResolvedNode {
	const series = ctx.bound.series;
	if (ctx.bound.missing || !series || series.categories.length === 0) {
		return rootGroup(ctx, []);
	}

	const { x, y, w, h } = origin(ctx);
	const horizontal = ctx.mark.style?.orientation === 'horizontal';
	const n = series.categories.length;
	const gap = 8;
	const maxVal = Math.max(0, ...series.values, 0) || 1;
	const progress = ctx.motion.progress;
	const radius = Math.max(0, ctx.theme.radius);
	const children: ResolvedNode[] = [];

	if (horizontal) {
		const barH = Math.max(1, (h - gap * (n + 1)) / n);
		for (let i = 0; i < n; i += 1) {
			const length = (series.values[i] / maxVal) * w * progress;
			const by = y + gap + i * (barH + gap);
			children.push({
				id: `${ctx.mark.id}:${i}`,
				tag: 'rect',
				attrs: {
					x: String(x),
					y: String(by),
					width: String(Math.max(0, length)),
					height: String(barH),
					fill: series.color,
					rx: String(Math.min(radius, barH / 2)),
					'data-length': String(length)
				}
			});
		}
	} else {
		const barW = Math.max(1, (w - gap * (n + 1)) / n);
		for (let i = 0; i < n; i += 1) {
			const length = (series.values[i] / maxVal) * h * progress;
			const bx = x + gap + i * (barW + gap);
			const by = y + h - length;
			children.push({
				id: `${ctx.mark.id}:${i}`,
				tag: 'rect',
				attrs: {
					x: String(bx),
					y: String(by),
					width: String(barW),
					height: String(Math.max(0, length)),
					fill: series.color,
					rx: String(Math.min(radius, barW / 2)),
					'data-length': String(length)
				}
			});
		}
	}

	return rootGroup(ctx, children);
}
