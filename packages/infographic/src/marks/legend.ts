import type { ResolvedNode } from '../types.js';
import { fontSizeOf, origin, rootGroup, type MarkRenderCtx } from './context.js';

export function renderLegend(ctx: MarkRenderCtx): ResolvedNode {
	if (ctx.bound.missing || !ctx.bound.forMark) {
		return rootGroup(ctx, [], { 'data-hidden': 'true' });
	}
	const sibling = ctx.sibling(ctx.bound.forMark);
	if (!sibling?.bound.series) {
		return rootGroup(ctx, [], { 'data-hidden': 'true' });
	}

	const { x, y } = origin(ctx);
	const size = fontSizeOf(ctx, 18);
	const swatch = Math.max(10, size * 0.8);
	const color = sibling.bound.series.color;
	const label = ctx.bound.title || sibling.bound.series.datasetLabel || sibling.mark.id;
	const children: ResolvedNode[] = [
		{
			id: `${ctx.mark.id}:swatch`,
			tag: 'rect',
			attrs: {
				x: String(x),
				y: String(y + 2),
				width: String(swatch),
				height: String(swatch),
				rx: String(Math.min(4, ctx.theme.radius)),
				fill: color
			}
		},
		{
			id: `${ctx.mark.id}:label`,
			tag: 'text',
			attrs: {
				x: String(x + swatch + 10),
				y: String(y + size),
				fill: ctx.theme.text,
				'font-family': ctx.theme.fontFamily,
				'font-size': String(size)
			},
			text: label
		}
	];
	return rootGroup(ctx, children);
}
