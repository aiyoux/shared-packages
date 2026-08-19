import type { ObjectSample } from './motion.js';
import { mapSeriesGlyph, seriesPointPose } from './series.js';
import type {
	AnyMark,
	IgfxObject,
	IgfxScene,
	Mark,
	ObjectTransform,
	Scene3dMark,
	SeriesMode
} from './types.js';

export interface WorldXform {
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	opacity: number;
}

export interface LayoutBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

const PRESET_KIND_SET = new Set([
	'bar',
	'line',
	'stat',
	'text',
	'legend',
	'axis',
	'scene3d'
]);

export function childrenOf(scene: IgfxScene, id: string | null): IgfxObject[] {
	return scene.objects.filter((o) => o.parentId === id);
}

export function ancestorsOf(scene: IgfxScene, id: string): IgfxObject[] {
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	const out: IgfxObject[] = [];
	const seen = new Set<string>();
	let cur = byId.get(id);
	cur = cur?.parentId ? byId.get(cur.parentId) : undefined;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		out.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return out;
}

export function subtreeIds(scene: IgfxScene, id: string): string[] {
	const out = [id];
	for (const child of childrenOf(scene, id)) {
		out.push(...subtreeIds(scene, child.id));
	}
	return out;
}

function localPose(obj: IgfxObject, sampled: Map<string, Partial<ObjectTransform>>): WorldXform {
	const s = sampled.get(obj.id);
	return {
		x: s?.x ?? obj.transform.x,
		y: s?.y ?? obj.transform.y,
		w: s?.w ?? obj.transform.w,
		h: s?.h ?? obj.transform.h,
		rotation: s?.rotation ?? obj.transform.rotation,
		opacity: s?.opacity ?? obj.transform.opacity
	};
}

/** Root parent is origin (0, 0), θp = 0 — equivalent to returning `local` unchanged. */
function compose(parent: WorldXform | undefined, local: WorldXform): WorldXform {
	if (!parent) return local;
	const theta = (parent.rotation * Math.PI) / 180;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	return {
		x: parent.x + local.x * cos - local.y * sin,
		y: parent.y + local.x * sin + local.y * cos,
		w: local.w,
		h: local.h,
		rotation: parent.rotation + local.rotation,
		opacity: parent.opacity * local.opacity
	};
}

/**
 * One memoized pre-order pass over `scene.objects` (§4.3).
 * Do not call this per-object as a fresh ancestor walk — that is O(n²) at the 256 cap.
 */
export function worldTransforms(
	scene: IgfxScene,
	sampled: Map<string, Partial<ObjectTransform>>
): Map<string, WorldXform> {
	const worlds = new Map<string, WorldXform>();
	const kids = new Map<string | null, IgfxObject[]>();
	for (const obj of scene.objects) {
		const list = kids.get(obj.parentId) ?? [];
		list.push(obj);
		kids.set(obj.parentId, list);
	}

	const visit = (obj: IgfxObject): void => {
		if (worlds.has(obj.id)) return;
		const local = localPose(obj, sampled);
		const parentWorld = obj.parentId ? worlds.get(obj.parentId) : undefined;
		worlds.set(obj.id, compose(parentWorld, local));
		for (const child of kids.get(obj.id) ?? []) visit(child);
	};

	for (const root of kids.get(null) ?? []) visit(root);
	for (const obj of scene.objects) {
		if (!worlds.has(obj.id)) worlds.set(obj.id, localPose(obj, sampled));
	}
	return worlds;
}

export function wouldCreateCycle(
	scene: IgfxScene,
	objectId: string,
	newParentId: string | null
): boolean {
	if (newParentId === null) return false;
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	const seen = new Set<string>();
	let cur = byId.get(newParentId);
	while (cur) {
		if (cur.id === objectId) return true;
		if (seen.has(cur.id)) break;
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return false;
}

export function hasParentCycle(scene: IgfxScene, objectId: string): boolean {
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	const seen = new Set<string>();
	let cur = byId.get(objectId);
	while (cur) {
		if (seen.has(cur.id)) return true;
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return false;
}

/** Field-write `parentId`. Rejects missing ids, cycles, and `point` → non-`series`. */
export function reparent(
	scene: IgfxScene,
	objectId: string,
	newParentId: string | null
): boolean {
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	const obj = byId.get(objectId);
	if (!obj) return false;
	if (newParentId !== null) {
		const parent = byId.get(newParentId);
		if (!parent) return false;
		if (obj.kind === 'point' && parent.kind !== 'series') return false;
	} else if (obj.kind === 'point') {
		return false;
	}
	if (wouldCreateCycle(scene, objectId, newParentId)) return false;
	obj.parentId = newParentId;
	return true;
}

export function objectToMark(
	obj: IgfxObject,
	layout: { x: number; y: number; w: number; h: number } = {
		x: obj.transform.x,
		y: obj.transform.y,
		w: obj.transform.w,
		h: obj.transform.h
	}
): AnyMark | null {
	if (!PRESET_KIND_SET.has(obj.kind)) return null;
	if (obj.kind === 'scene3d') {
		const mark: Scene3dMark = {
			id: obj.id,
			kind: 'scene3d',
			layout,
			scene: obj.scene ?? {
				objects: [],
				camera: { position: [2, 2, 2], target: [0, 0, 0], fov: 50 }
			},
			bindings: {}
		};
		const values = obj.bindings?.values;
		if (values && typeof values === 'object' && 'ref' in values && typeof values.ref === 'string') {
			mark.bindings.values = { ref: values.ref };
		}
		if (obj.style) mark.style = obj.style;
		return mark;
	}
	const mark: Mark = {
		id: obj.id,
		kind: obj.kind as Mark['kind'],
		layout,
		bindings: obj.bindings ?? {}
	};
	if (obj.style) mark.style = obj.style;
	return mark;
}

/**
 * Derived glyph center in artboard px. Ignores persist `point.transform`.
 * `siblings` is visible-in-order (same list as series.ts, before the line/scatter k slice).
 */
export function mappedGlyph(
	seriesWorld: WorldXform,
	mode: SeriesMode,
	point: IgfxObject,
	sample: ObjectSample,
	siblings: { point: IgfxObject; sample: ObjectSample }[],
	opts?: { progress?: number; horizontal?: boolean }
): { x: number; y: number } {
	const poses = siblings.map((s) => seriesPointPose(s.point, s.sample));
	let index = siblings.findIndex((s) => s.point.id === point.id);
	if (index < 0) {
		poses.push(seriesPointPose(point, sample));
		index = poses.length - 1;
	}
	return mapSeriesGlyph(seriesWorld, mode, index, poses, opts);
}

export function pointHandleBox(...args: Parameters<typeof mappedGlyph>): LayoutBox {
	const { x, y } = mappedGlyph(...args);
	return { x: x - 8, y: y - 8, w: 16, h: 16 };
}
