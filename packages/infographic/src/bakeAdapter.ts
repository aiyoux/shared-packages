import { bindMark } from './bindings.js';
import { DEFAULT_EXPORT_FPS, SCENE3D_EXPORT_FPS } from './types.js';
import type { AnyMark, IgfxDocument, Scene3dMark, Scene3dObject } from './types.js';

export type BakedPath = { d: string; stroke: string; fill: string; strokeWidth: number };

export type { Scene3dCamera, Scene3dMark, Scene3dObject } from './types.js';

export interface Live3dContext {
	canvas: HTMLCanvasElement;
	setSceneFromMark(mark: Scene3dMark, tMs: number, boundValues?: number[] | null): void;
	waitSettled(): Promise<void>;
	renderTo(target: OffscreenCanvas | HTMLCanvasElement): void;
	dispose(): void;
}

export interface BakeAdapter {
	encodeToSvg(input: {
		mark: Scene3dMark;
		tMs: number;
		width: number;
		height: number;
	}): Promise<BakedPath[]>;
	acquireLive(): Promise<Live3dContext>;
}

const cache = new Map<string, BakedPath[]>();
const lastByMark = new Map<string, { signature: string; paths: BakedPath[] }>();
let adapter: BakeAdapter | null = null;

export function isScene3dMark(mark: AnyMark): mark is Scene3dMark {
	return mark.kind === 'scene3d';
}

export function documentHasScene3d(doc: Pick<IgfxDocument, 'marks'>): boolean {
	return doc.marks.some(isScene3dMark);
}

/** 12 whenever any scene3d is present (preview + export share cache keys). Else lastExport.fps || 30. */
export function bakeFpsFor(doc: Pick<IgfxDocument, 'marks' | 'lastExport'>, _forExport = false): number {
	if (documentHasScene3d(doc)) return SCENE3D_EXPORT_FPS;
	return doc.lastExport?.fps ?? DEFAULT_EXPORT_FPS;
}

export function setBakeAdapter(next: BakeAdapter | null): void {
	adapter = next;
}

export function getBakeAdapter(): BakeAdapter | null {
	return adapter;
}

export function clearBakeCache(): void {
	cache.clear();
	lastByMark.clear();
}

export function bakeSignature(
	mark: Scene3dMark,
	tMs: number,
	fps: number,
	boundValues?: number[] | null
): string {
	const step = 1000 / Math.max(1, fps);
	const q = Math.round(tMs / step);
	return JSON.stringify({
		cam: mark.scene.camera,
		objs: mark.scene.objects,
		values: boundValues ?? mark.bindings.values ?? null,
		style: mark.style ?? null,
		q,
		fps
	});
}

function cacheKey(markId: string, signature: string): string {
	return `${markId}@${signature}`;
}

export function peekBake(markId: string, signature: string): BakedPath[] | undefined {
	return cache.get(cacheKey(markId, signature));
}

/** Last bake only if its stored signature still matches — never a stale poster frame. */
export function peekLastBake(markId: string, signature: string): BakedPath[] | undefined {
	const last = lastByMark.get(markId);
	if (!last || last.signature !== signature) return undefined;
	return last.paths;
}

export function applyBar3dHeights(objects: Scene3dObject[], values?: number[] | null): Scene3dObject[] {
	if (!values || values.length === 0) return objects;
	let i = 0;
	return objects.map((obj) => {
		if (obj.primitive !== 'bar3d') return obj;
		const h = values[i] ?? obj.scale[1];
		i += 1;
		return { ...obj, scale: [obj.scale[0], h, obj.scale[2]] };
	});
}

export function markWithBoundValues(mark: Scene3dMark, boundValues?: number[] | null): Scene3dMark {
	if (!boundValues || boundValues.length === 0) return mark;
	return {
		...mark,
		scene: { ...mark.scene, objects: applyBar3dHeights(mark.scene.objects, boundValues) }
	};
}

export function defaultScene3dMark(
	id: string,
	layout: { x: number; y: number; w: number; h: number } = { x: 80, y: 80, w: 480, h: 360 }
): Scene3dMark {
	return {
		id,
		kind: 'scene3d',
		layout,
		scene: {
			objects: [
				{
					id: `${id}-box`,
					primitive: 'box',
					position: [0, 0, 0],
					rotation: [0.35, 0.6, 0],
					scale: [1, 1, 1],
					color: '#2563eb'
				}
			],
			camera: { position: [2.4, 1.8, 2.4], target: [0, 0, 0], fov: 45 }
		},
		bindings: {}
	};
}

export async function ensureBaked(
	mark: Scene3dMark,
	tMs: number,
	fps = DEFAULT_EXPORT_FPS,
	boundValues?: number[] | null
): Promise<BakedPath[]> {
	const signature = bakeSignature(mark, tMs, fps, boundValues);
	const key = cacheKey(mark.id, signature);
	const hit = cache.get(key);
	if (hit) return hit;
	if (!adapter) return [];
	const paths = await adapter.encodeToSvg({
		mark: markWithBoundValues(mark, boundValues),
		tMs,
		width: Math.max(1, mark.layout.w),
		height: Math.max(1, mark.layout.h)
	});
	cache.set(key, paths);
	lastByMark.set(mark.id, { signature, paths });
	return paths;
}

export async function ensureDocumentBaked(doc: IgfxDocument, tMs: number, fps?: number): Promise<void> {
	const useFps = fps ?? bakeFpsFor(doc);
	for (const mark of doc.marks) {
		if (!isScene3dMark(mark)) continue;
		await ensureBaked(mark, tMs, useFps, scene3dBoundValues(doc, mark));
	}
}

/** Same bound-value array `resolve` / `ensureBaked` use (`bindMark` + `coerceNumber`). */
export function scene3dBoundValues(doc: IgfxDocument, mark: Scene3dMark): number[] | null {
	return bindMark(doc, mark, []).series?.values ?? null;
}
