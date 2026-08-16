import type { ResolvedNode } from '../types.js';
import { fontSizeOf, origin, rootGroup, type MarkRenderCtx } from './context.js';

export function renderStat(ctx: MarkRenderCtx): ResolvedNode {
	const { x, y, h } = origin(ctx);
	const valueSize = fontSizeOf(ctx, Math.min(72, Math.max(28, h * 0.35)));
	const labelSize = Math.max(14, valueSize * 0.35);
	const children: ResolvedNode[] = [];

	let display: string;
	if (ctx.bound.missing || ctx.bound.value === null) {
		display = '—';
	} else {
		display = String(Math.round(ctx.bound.value * ctx.motion.progress));
	}

	const valueText = `${ctx.bound.prefix}${display}${ctx.bound.suffix}`;
	children.push({
		id: `${ctx.mark.id}:value`,
		tag: 'text',
		attrs: {
			x: String(x),
			y: String(y + valueSize),
			fill: ctx.theme.text,
			'font-family': ctx.theme.fontFamily,
			'font-size': String(valueSize),
			'font-weight': '700',
			'data-raw': display
		},
		text: valueText
	});

	if (ctx.bound.label) {
		children.push({
			id: `${ctx.mark.id}:label`,
			tag: 'text',
			attrs: {
				x: String(x),
				y: String(y + valueSize + labelSize + 12),
				fill: ctx.theme.muted,
				'font-family': ctx.theme.fontFamily,
				'font-size': String(labelSize)
			},
			text: ctx.bound.label
		});
	}

	return rootGroup(ctx, children);
}
