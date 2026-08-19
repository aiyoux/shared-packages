import type { AnyMark, IgfxObject, IgfxScene, Mark, ObjectTransform, Scene3dMark } from './types.js';

export interface WorldXform {
	x: number;
	y: number;
	w: number;
	h: number;
	rotation: number;
	opacity: number;
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

/**
 * One pre-order memoized pass over `scene.objects`.
 * S2 keeps identity parents (rotation compose lands in S3).
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
		// Identity parent: world = sampled local pose. S3 composes rotation.
		worlds.set(obj.id, localPose(obj, sampled));
		for (const child of kids.get(obj.id) ?? []) visit(child);
	};

	for (const root of kids.get(null) ?? []) visit(root);
	for (const obj of scene.objects) {
		if (!worlds.has(obj.id)) worlds.set(obj.id, localPose(obj, sampled));
	}
	return worlds;
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
