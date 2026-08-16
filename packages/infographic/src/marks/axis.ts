import { lineDomain } from './line.js';
import type { ResolvedNode } from '../types.js';
import { fontSizeOf, origin, rootGroup, type MarkRenderCtx } from './context.js';

function niceTicks(min: number, max: number, count = 4): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
	if (min === max) return [min];
	const span = max - min;
	const step = span / count;
	const ticks: number[] = [];
	for (let i = 0; i <= count; i += 1) ticks.push(min + step * i);
	return ticks;
}

function formatTick(n: number): string {
	if (Number.isInteger(n)) return String(n);
	const abs = Math.abs(n);
	if (abs >= 100) return n.toFixed(0);
	if (abs >= 10) return n.toFixed(1);
	return n.toFixed(2);
}

export function renderAxis(ctx: MarkRenderCtx): ResolvedNode {
	if (ctx.bound.missing || !ctx.bound.forMark) {
		return rootGroup(ctx, [], { 'data-hidden': 'true' });
	}
	const sibling = ctx.sibling(ctx.bound.forMark);
	if (!sibling?.bound.series) {
		return rootGroup(ctx, [], { 'data-hidden': 'true' });
	}

	const { x, y, w, h } = origin(ctx);
	const size = fontSizeOf(ctx, 14);
	const series = sibling.bound.series;
	const horizontal = sibling.mark.style?.orientation === 'horizontal';
	const children: ResolvedNode[] = [];

	children.push({
		id: `${ctx.mark.id}:x`,
		tag: 'line',
		attrs: {
			x1: String(x),
			y1: String(y + h),
			x2: String(x + w),
			y2: String(y + h),
			stroke: ctx.theme.grid,
			'stroke-width': '1'
		}
	});
	children.push({
		id: `${ctx.mark.id}:y`,
		tag: 'line',
		attrs: {
			x1: String(x),
			y1: String(y),
			x2: String(x),
			y2: String(y + h),
			stroke: ctx.theme.grid,
			'stroke-width': '1'
		}
	});

	if (sibling.mark.kind === 'bar' && series.categories.length > 0) {
		const n = series.categories.length;
		const gap = 8;
		if (horizontal) {
			const barH = Math.max(1, (h - gap * (n + 1)) / n);
			for (let i = 0; i < n; i += 1) {
				const ty = y + gap + i * (barH + gap) + barH / 2 + size / 3;
				children.push({
					id: `${ctx.mark.id}:cat:${i}`,
					tag: 'text',
					attrs: {
						x: String(x - 8),
						y: String(ty),
						fill: ctx.theme.muted,
						'font-family': ctx.theme.fontFamily,
						'font-size': String(size),
						'text-anchor': 'end'
					},
					text: series.categories[i]
				});
			}
		} else {
			const barW = Math.max(1, (w - gap * (n + 1)) / n);
			for (let i = 0; i < n; i += 1) {
				const tx = x + gap + i * (barW + gap) + barW / 2;
				children.push({
					id: `${ctx.mark.id}:cat:${i}`,
					tag: 'text',
					attrs: {
						x: String(tx),
						y: String(y + h + size + 6),
						fill: ctx.theme.muted,
						'font-family': ctx.theme.fontFamily,
						'font-size': String(size),
						'text-anchor': 'middle'
					},
					text: series.categories[i]
				});
			}
		}
		const maxVal = Math.max(0, ...series.values, 0) || 1;
		const ticks = niceTicks(0, maxVal);
		for (let i = 0; i < ticks.length; i += 1) {
			const t = ticks[i];
			if (horizontal) {
				const tx = x + (t / maxVal) * w;
				children.push({
					id: `${ctx.mark.id}:tick:${i}`,
					tag: 'text',
					attrs: {
						x: String(tx),
						y: String(y + h + size + 4),
						fill: ctx.theme.muted,
						'font-family': ctx.theme.fontFamily,
						'font-size': String(size),
						'text-anchor': 'middle'
					},
					text: formatTick(t)
				});
			} else {
				const ty = y + h - (t / maxVal) * h;
				children.push({
					id: `${ctx.mark.id}:tick:${i}`,
					tag: 'text',
					attrs: {
						x: String(x - 8),
						y: String(ty + size / 3),
						fill: ctx.theme.muted,
						'font-family': ctx.theme.fontFamily,
						'font-size': String(size),
						'text-anchor': 'end'
					},
					text: formatTick(t)
				});
			}
		}
	} else if (sibling.mark.kind === 'line') {
		const domain = lineDomain(series.xs, series.ys);
		const xt = niceTicks(domain.x0, domain.x1);
		const yt = niceTicks(domain.y0, domain.y1);
		const xSpan = domain.x1 - domain.x0 || 1;
		const ySpan = domain.y1 - domain.y0 || 1;
		for (let i = 0; i < xt.length; i += 1) {
			const tx = x + ((xt[i] - domain.x0) / xSpan) * w;
			children.push({
				id: `${ctx.mark.id}:xt:${i}`,
				tag: 'text',
				attrs: {
					x: String(tx),
					y: String(y + h + size + 6),
					fill: ctx.theme.muted,
					'font-family': ctx.theme.fontFamily,
					'font-size': String(size),
					'text-anchor': 'middle'
				},
				text: formatTick(xt[i])
			});
		}
		for (let i = 0; i < yt.length; i += 1) {
			const ty = y + h - ((yt[i] - domain.y0) / ySpan) * h;
			children.push({
				id: `${ctx.mark.id}:yt:${i}`,
				tag: 'text',
				attrs: {
					x: String(x - 8),
					y: String(ty + size / 3),
					fill: ctx.theme.muted,
					'font-family': ctx.theme.fontFamily,
					'font-size': String(size),
					'text-anchor': 'end'
				},
				text: formatTick(yt[i])
			});
		}
	}

	if (ctx.bound.title) {
		children.push({
			id: `${ctx.mark.id}:title`,
			tag: 'text',
			attrs: {
				x: String(x + w / 2),
				y: String(y - 8),
				fill: ctx.theme.muted,
				'font-family': ctx.theme.fontFamily,
				'font-size': String(size),
				'text-anchor': 'middle'
			},
			text: ctx.bound.title
		});
	}

	return rootGroup(ctx, children);
}
