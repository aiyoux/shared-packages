import {
	bakeFpsFor,
	bakeSignature,
	isScene3dMark,
	peekBake,
	peekLastBake,
	type BakedPath
} from './bakeAdapter.js';
import { bindMark, type BoundMark } from './bindings.js';
import { renderAxis } from './marks/axis.js';
import { renderBar } from './marks/bar.js';
import type { MarkRenderCtx } from './marks/context.js';
import { renderLegend } from './marks/legend.js';
import { renderLine } from './marks/line.js';
import { renderStat } from './marks/stat.js';
import { renderText } from './marks/text.js';
import { defaultMarkMotion, sampleMotion, type MarkMotion } from './motion.js';
import { v1View } from './schema.js';
import type {
	IgfxDocument,
	Mark,
	ResolvedFrame,
	ResolvedNode,
	Scene3dMark,
	Theme
} from './types.js';

function renderScene3d(
	mark: Scene3dMark,
	motion: MarkMotion,
	theme: Theme,
	tMs: number,
	fps: number,
	bound: BoundMark,
	warnings: string[]
): ResolvedNode {
	const x = mark.layout.x + motion.x;
	const y = mark.layout.y + motion.y;
	const w = mark.layout.w;
	const h = mark.layout.h;
	const signature = bakeSignature(mark, tMs, fps, bound.series?.values ?? null);
	const baked: BakedPath[] | undefined = peekBake(mark.id, signature) ?? peekLastBake(mark.id, signature);
	if (!baked || baked.length === 0) {
		warnings.push(`bake pending:${mark.id}`);
		return {
			id: mark.id,
			tag: 'g',
			attrs: { opacity: String(motion.opacity) },
			children: [
				{
					id: `${mark.id}:pending`,
					tag: 'rect',
					attrs: {
						x: String(x),
						y: String(y),
						width: String(w),
						height: String(h),
						fill: theme.surface,
						'data-bake': 'pending'
					}
				}
			]
		};
	}
	// SVGRenderer emits centered coordinates (viewBox -w/2 -h/2 w h).
	const children: ResolvedNode[] = baked.map((p, i) => ({
		id: `${mark.id}:p${i}`,
		tag: 'path',
		attrs: {
			d: p.d,
			stroke: p.stroke,
			fill: p.fill,
			'stroke-width': String(p.strokeWidth)
		}
	}));
	return {
		id: mark.id,
		tag: 'g',
		attrs: {
			opacity: String(motion.opacity),
			transform: `translate(${x + w / 2} ${y + h / 2})`,
			'data-bake': 'ready'
		},
		children
	};
}

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

	const view = v1View(doc);
	const boundById = new Map<string, BoundMark>();
	const markById = new Map<string, Mark>();
	const fps = bakeFpsFor(doc);
	for (const mark of view.marks) {
		if (!isScene3dMark(mark)) markById.set(mark.id, mark);
		boundById.set(mark.id, bindMark(doc, mark, warnings));
	}

	const sibling = (id: string) => {
		const mark = markById.get(id);
		const bound = boundById.get(id);
		if (!mark || !bound) return undefined;
		return { mark, bound };
	};

	const nodes: ResolvedNode[] = [];
	for (const mark of view.marks) {
		const bound = boundById.get(mark.id);
		if (!bound) continue;
		const markMotion = motion.byMark.get(mark.id) ?? defaultMarkMotion();
		if (isScene3dMark(mark)) {
			nodes.push(renderScene3d(mark, markMotion, doc.theme, tMs, fps, bound, warnings));
			continue;
		}
		nodes.push(
			renderMark({
				doc,
				mark,
				theme: doc.theme,
				motion: markMotion,
				bound,
				warnings,
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
