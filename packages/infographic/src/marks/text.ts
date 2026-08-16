import type { ResolvedNode } from '../types.js';
import { fontSizeOf, origin, rootGroup, type MarkRenderCtx } from './context.js';

export function renderText(ctx: MarkRenderCtx): ResolvedNode {
	const { x, y, h } = origin(ctx);
	const size = fontSizeOf(ctx, Math.min(64, Math.max(16, h * 0.7)));
	return rootGroup(ctx, [
		{
			id: `${ctx.mark.id}:text`,
			tag: 'text',
			attrs: {
				x: String(x),
				y: String(y + size),
				fill: typeof ctx.mark.style?.fill === 'string' ? String(ctx.mark.style.fill) : ctx.theme.text,
				'font-family': ctx.theme.fontFamily,
				'font-size': String(size),
				'font-weight': '700'
			},
			text: ctx.bound.text
		}
	]);
}
