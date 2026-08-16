import { bindMark, type BoundMark } from './bindings.js';
import { renderAxis } from './marks/axis.js';
import { renderBar } from './marks/bar.js';
import type { MarkRenderCtx } from './marks/context.js';
import { renderLegend } from './marks/legend.js';
import { renderLine } from './marks/line.js';
import { renderStat } from './marks/stat.js';
import { renderText } from './marks/text.js';
import { defaultMarkMotion, sampleMotion } from './motion.js';
import type { IgfxDocument, Mark, ResolvedFrame, ResolvedNode } from './types.js';

function renderMark(ctx: MarkRenderCtx): ResolvedNode {
	switch (ctx.mark.kind) {
		case 'bar':
			return renderBar(ctx);
		case 'line':
			return renderLine(ctx);
		case 'stat':
			return renderStat(ctx);
		case 'text':
			return renderText(ctx);
		case 'legend':
			return renderLegend(ctx);
		case 'axis':
			return renderAxis(ctx);
	}
}

export function resolve(doc: IgfxDocument, tMs: number): ResolvedFrame {
	const warnings: string[] = [];
	const motion = sampleMotion(doc, tMs);
	warnings.push(...motion.warnings);

	const boundById = new Map<string, BoundMark>();
	const markById = new Map<string, Mark>();
	for (const mark of doc.marks) {
		markById.set(mark.id, mark);
		boundById.set(mark.id, bindMark(doc, mark, warnings));
	}

	const sibling = (id: string) => {
		const mark = markById.get(id);
		const bound = boundById.get(id);
		if (!mark || !bound) return undefined;
		return { mark, bound };
	};

	const nodes: ResolvedNode[] = [];
	for (const mark of doc.marks) {
		const bound = boundById.get(mark.id);
		if (!bound) continue;
		nodes.push(
			renderMark({
				doc,
				mark,
				theme: doc.theme,
				motion: motion.byMark.get(mark.id) ?? defaultMarkMotion(),
				bound,
				sibling
			})
		);
	}

	return {
		width: doc.artboard.width,
		height: doc.artboard.height,
		background: doc.theme.background,
		nodes,
		warnings
	};
}
