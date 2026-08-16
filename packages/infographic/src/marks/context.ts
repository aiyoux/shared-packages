import type { BoundMark } from '../bindings.js';
import type { MarkMotion } from '../motion.js';
import type { IgfxDocument, Mark, ResolvedNode, Theme } from '../types.js';

export interface MarkRenderCtx {
	doc: IgfxDocument;
	mark: Mark;
	theme: Theme;
	motion: MarkMotion;
	bound: BoundMark;
	sibling: (id: string) => { mark: Mark; bound: BoundMark } | undefined;
}

export function origin(ctx: MarkRenderCtx): { x: number; y: number; w: number; h: number } {
	return {
		x: ctx.mark.layout.x + ctx.motion.x,
		y: ctx.mark.layout.y + ctx.motion.y,
		w: ctx.mark.layout.w,
		h: ctx.mark.layout.h
	};
}

export function rootGroup(
	ctx: MarkRenderCtx,
	children: ResolvedNode[],
	extra: Record<string, string> = {}
): ResolvedNode {
	return {
		id: ctx.mark.id,
		tag: 'g',
		attrs: {
			opacity: String(ctx.motion.opacity),
			...extra
		},
		children
	};
}

export function fontSizeOf(ctx: MarkRenderCtx, fallback: number): number {
	const raw = ctx.mark.style?.fontSize;
	if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
	return fallback;
}
