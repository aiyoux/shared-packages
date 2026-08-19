import {
	bakeFpsFor,
	bakeSignature,
	isScene3dMark,
	peekBake,
	peekLastBake,
	type BakedPath
} from './bakeAdapter.js';
import { bindObject, type BoundMark } from './bindings.js';
import { renderGeometry } from './geometry.js';
import { renderAxis } from './marks/axis.js';
import { renderBar } from './marks/bar.js';
import { wrapWorld, type MarkRenderCtx } from './marks/context.js';
import { renderLegend } from './marks/legend.js';
import { renderLine } from './marks/line.js';
import { renderStat } from './marks/stat.js';
import { renderText } from './marks/text.js';
import { sampleTake, sampledLocal, type MarkMotion, type ObjectSample } from './motion.js';
import { childrenOf, objectToMark, worldTransforms, type WorldXform } from './objects.js';
import { renderSeries, visiblePointChildren } from './series.js';
import { createTake, effectiveArtboard, effectiveTheme } from './schema.js';
import { DEFAULT_DURATION_MS } from './types.js';
import type {
	IgfxDocument,
	IgfxObject,
	IgfxScene,
	Mark,
	ObjectTransform,
	ResolvedFrame,
	ResolvedNode,
	Scene3dMark,
	SceneTimeline,
	Theme
} from './types.js';

function emptyFrame(
	width: number,
	height: number,
	background: string,
	warnings: string[]
): ResolvedFrame {
	return { width, height, background, nodes: [], warnings };
}

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

function shimMotion(sample: ObjectSample): MarkMotion {
	return {
		progress: sample.motion.progress,
		opacity: 1,
		x: 0,
		y: 0
	};
}

function syntheticSeriesMark(obj: IgfxObject, world: WorldXform): Mark {
	const mark: Mark = {
		id: obj.id,
		kind: obj.series?.mode === 'bars' ? 'bar' : 'line',
		layout: { x: world.x, y: world.y, w: world.w, h: world.h },
		bindings: {}
	};
	if (obj.style) mark.style = obj.style;
	return mark;
}

function renderObject(
	obj: IgfxObject,
	world: WorldXform,
	sample: ObjectSample,
	ctx: Omit<MarkRenderCtx, 'mark' | 'motion'> & {
		tMs: number;
		fps: number;
		scene: IgfxScene;
		sampled: Map<string, ObjectSample>;
	}
): ResolvedNode | null {
	const layout = { x: world.x, y: world.y, w: world.w, h: world.h };
	const motion = shimMotion(sample);
	let inner: ResolvedNode;
	if (obj.kind === 'shape' || obj.kind === 'path') {
		inner = renderGeometry(obj, layout, ctx.theme);
	} else if (obj.kind === 'series') {
		const points = visiblePointChildren(childrenOf(ctx.scene, obj.id), ctx.sampled).map((point) => ({
			obj: point,
			sample: ctx.sampled.get(point.id)
		}));
		inner = renderSeries({
			obj,
			layout,
			progress: sample.motion.progress,
			theme: ctx.theme,
			points
		});
	} else {
		const mark = objectToMark(obj, layout);
		if (!mark) return null;
		if (isScene3dMark(mark)) {
			inner = renderScene3d(mark, motion, ctx.theme, ctx.tMs, ctx.fps, ctx.bound, ctx.warnings);
		} else {
			inner = renderMark({
				doc: ctx.doc,
				mark,
				theme: ctx.theme,
				motion,
				bound: ctx.bound,
				warnings: ctx.warnings,
				sibling: ctx.sibling
			});
		}
	}
	return wrapWorld(obj.id, world, inner);
}

export function resolveScene(
	doc: IgfxDocument,
	sceneId: string,
	tMs: number,
	timelineId?: string
): ResolvedFrame {
	const scene: IgfxScene | undefined = doc.scenes.find((s) => s.id === sceneId);
	if (!scene) {
		return emptyFrame(doc.artboard.width, doc.artboard.height, doc.theme.background, [
			`missing scene:${sceneId}`
		]);
	}

	const warnings: string[] = [];
	const takeId = timelineId ?? scene.activeTimelineId;
	let take: SceneTimeline | undefined = scene.timelines.find((t) => t.id === takeId);
	if (!take) {
		warnings.push(`missing take:${takeId}`);
		take = { ...createTake('Take'), durationMs: DEFAULT_DURATION_MS, posterMs: DEFAULT_DURATION_MS };
	}

	const theme = effectiveTheme(doc, scene);
	const artboard = effectiveArtboard(doc, scene);
	const sampled = sampleTake(scene, take, tMs);
	warnings.push(...sampled.warnings);

	const boundById = new Map<string, BoundMark>();
	const markById = new Map<string, Mark>();
	const locals = new Map<string, Partial<ObjectTransform>>();
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	for (const obj of scene.objects) {
		const sample = sampled.byObject.get(obj.id);
		if (sample) locals.set(obj.id, sampledLocal(obj, sample));
		const bound = bindObject(doc, obj, warnings, theme, { scene, sampled: sampled.byObject });
		if (sample?.motion.value !== undefined) bound.value = sample.motion.value;
		boundById.set(obj.id, bound);
	}

	const worlds = worldTransforms(scene, locals);
	const fps = bakeFpsFor(doc);

	for (const obj of scene.objects) {
		const world = worlds.get(obj.id);
		if (!world) continue;
		const mark = objectToMark(obj, { x: world.x, y: world.y, w: world.w, h: world.h });
		if (mark && !isScene3dMark(mark)) markById.set(mark.id, mark);
	}

	const sibling = (id: string) => {
		const bound = boundById.get(id);
		if (!bound) return undefined;
		const existing = markById.get(id);
		if (existing) return { mark: existing, bound };
		const obj = byId.get(id);
		const world = worlds.get(id);
		if (obj?.kind === 'series' && world) {
			return { mark: syntheticSeriesMark(obj, world), bound };
		}
		return undefined;
	};

	const nodes: ResolvedNode[] = [];
	for (const obj of scene.objects) {
		if (obj.kind === 'group' || obj.kind === 'point') continue;
		const sample = sampled.byObject.get(obj.id);
		if (!sample?.visible) continue;
		const world = worlds.get(obj.id);
		const bound = boundById.get(obj.id);
		if (!world || !bound) continue;
		const node = renderObject(obj, world, sample, {
			doc,
			theme,
			bound,
			warnings,
			sibling,
			tMs,
			fps,
			scene,
			sampled: sampled.byObject
		});
		if (node) nodes.push(node);
	}

	return {
		width: artboard.width,
		height: artboard.height,
		background: theme.background,
		nodes,
		warnings
	};
}

export function resolve(doc: IgfxDocument, tMs: number): ResolvedFrame {
	const scene = doc.scenes.find((s) => s.id === doc.activeSceneId) ?? doc.scenes[0];
	if (!scene) {
		return emptyFrame(doc.artboard.width, doc.artboard.height, doc.theme.background, [
			`missing scene:${doc.activeSceneId}`
		]);
	}
	return resolveScene(doc, scene.id, tMs, scene.activeTimelineId);
}
