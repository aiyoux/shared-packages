import {
	ANIMATABLE_PROPS,
	DEFAULT_DURATION_MS,
	IGFX_SCHEMA_VERSION,
	MARK_KINDS,
	type AnimatableProp,
	type AnyMark,
	type BindingRef,
	type IgfxObject,
	type IgfxTimeline,
	type MarkKind,
	type MediaBed,
	type MotionKeyframe,
	type MotionTrack,
	type PropertyCurve,
	type Scene3dCamera,
	type Scene3dMark,
	type Scene3dObject,
	type SceneTrack
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFinite(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

const MARK_KIND_SET = new Set<string>(MARK_KINDS);
const EASINGS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
const SCENE3D_PRIMITIVES = new Set(['box', 'sphere', 'cylinder', 'bar3d']);
const ANIMATABLE_SET = new Set<string>(ANIMATABLE_PROPS);

function parseBindingValue(raw: unknown): BindingRef | string | number | undefined {
	if (typeof raw === 'string' || typeof raw === 'number') return raw;
	if (isRecord(raw) && typeof raw.ref === 'string') return { ref: raw.ref };
	return undefined;
}

function parseVec3(raw: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(raw) || raw.length < 3) return fallback;
	return [asFinite(raw[0], fallback[0]), asFinite(raw[1], fallback[1]), asFinite(raw[2], fallback[2])];
}

function parseScene3dObject(raw: unknown): Scene3dObject | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (!SCENE3D_PRIMITIVES.has(raw.primitive as string)) return null;
	const obj: Scene3dObject = {
		id: raw.id,
		primitive: raw.primitive as Scene3dObject['primitive'],
		position: parseVec3(raw.position, [0, 0, 0]),
		rotation: parseVec3(raw.rotation, [0, 0, 0]),
		scale: parseVec3(raw.scale, [1, 1, 1])
	};
	if (typeof raw.color === 'string') obj.color = raw.color;
	return obj;
}

function parseStyle(raw: unknown): Record<string, string | number | boolean> | undefined {
	if (!isRecord(raw)) return undefined;
	const style: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			style[key] = value;
		}
	}
	return Object.keys(style).length > 0 ? style : undefined;
}

function parseScene3dMark(raw: Record<string, unknown>): Scene3dMark | null {
	if (typeof raw.id !== 'string' || !raw.id) return null;
	const sceneRaw = isRecord(raw.scene) ? raw.scene : {};
	const camRaw = isRecord(sceneRaw.camera) ? sceneRaw.camera : {};
	const camera: Scene3dCamera = {
		position: parseVec3(camRaw.position, [2, 2, 2]),
		target: parseVec3(camRaw.target, [0, 0, 0]),
		fov: asFinite(camRaw.fov, 50)
	};
	const objects = (Array.isArray(sceneRaw.objects) ? sceneRaw.objects : [])
		.map(parseScene3dObject)
		.filter((o): o is Scene3dObject => !!o);
	const bindings: Scene3dMark['bindings'] = {};
	const bindingsRaw = isRecord(raw.bindings) ? raw.bindings : {};
	if (isRecord(bindingsRaw.values) && typeof bindingsRaw.values.ref === 'string') {
		bindings.values = { ref: bindingsRaw.values.ref };
	}
	const style = parseStyle(raw.style);
	const layoutRaw = isRecord(raw.layout) ? raw.layout : {};
	return {
		id: raw.id,
		kind: 'scene3d',
		layout: {
			x: asFinite(layoutRaw.x, 0),
			y: asFinite(layoutRaw.y, 0),
			w: asFinite(layoutRaw.w, 100),
			h: asFinite(layoutRaw.h, 100)
		},
		scene: { objects, camera },
		bindings,
		...(style ? { style } : {})
	};
}

function parseMark(raw: unknown): AnyMark | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (raw.kind === 'scene3d') return parseScene3dMark(raw);
	if (!MARK_KIND_SET.has(raw.kind as string)) return null;
	const layoutRaw = isRecord(raw.layout) ? raw.layout : {};
	const bindingsRaw = isRecord(raw.bindings) ? raw.bindings : {};
	const bindings: Record<string, BindingRef | string | number> = {};
	for (const [key, value] of Object.entries(bindingsRaw)) {
		const parsed = parseBindingValue(value);
		if (parsed !== undefined) bindings[key] = parsed;
	}
	const style = parseStyle(raw.style);
	return {
		id: raw.id,
		kind: raw.kind as MarkKind,
		layout: {
			x: asFinite(layoutRaw.x, 0),
			y: asFinite(layoutRaw.y, 0),
			w: asFinite(layoutRaw.w, 100),
			h: asFinite(layoutRaw.h, 100)
		},
		bindings,
		...(style ? { style } : {})
	};
}

function parseKeyframe(raw: unknown): MotionKeyframe | null {
	if (!isRecord(raw)) return null;
	const tMs = asFinite(raw.tMs, NaN);
	const value = asFinite(raw.value, NaN);
	if (!Number.isFinite(tMs) || !Number.isFinite(value)) return null;
	const key: MotionKeyframe = { tMs, value };
	if (typeof raw.easing === 'string' && EASINGS.has(raw.easing)) {
		key.easing = raw.easing as MotionKeyframe['easing'];
	}
	return key;
}

function parseTrack(raw: unknown): MotionTrack | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (typeof raw.target !== 'string' || !raw.target) return null;
	const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : [])
		.map(parseKeyframe)
		.filter((k): k is MotionKeyframe => !!k);
	return { id: raw.id, target: raw.target, keyframes };
}

function parseTimeline(raw: unknown): IgfxTimeline {
	if (!isRecord(raw)) {
		return { durationMs: DEFAULT_DURATION_MS, posterMs: DEFAULT_DURATION_MS, tracks: [] };
	}
	const durationMs = Math.max(0, asFinite(raw.durationMs, DEFAULT_DURATION_MS));
	const posterMs = asFinite(raw.posterMs, durationMs);
	const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
		.map(parseTrack)
		.filter((t): t is MotionTrack => !!t);
	return { durationMs, posterMs, tracks };
}

function parseMediaBed(raw: unknown): MediaBed | undefined {
	if (!isRecord(raw) || typeof raw.nodeId !== 'string' || !raw.nodeId) return undefined;
	return {
		nodeId: raw.nodeId,
		offsetMs: asFinite(raw.offsetMs, 0),
		durationMs: asFinite(raw.durationMs, 0)
	};
}

export function isV1(raw: Record<string, unknown>): boolean {
	const ver = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
	return ver < 2 || (!Array.isArray(raw.scenes) && Array.isArray(raw.marks));
}

function markToObject(mark: AnyMark): IgfxObject {
	const obj: IgfxObject = {
		id: mark.id,
		name: mark.id,
		parentId: null,
		kind: mark.kind,
		visible: true,
		transform: { ...mark.layout, rotation: 0, opacity: 1 },
		bindings: mark.bindings
	};
	if (mark.style) obj.style = mark.style;
	if (mark.kind === 'scene3d') obj.scene = mark.scene;
	return obj;
}

function parseV1Target(target: string): { objectId: string; prop: string } | null {
	const m = /^(?:mark|object):([^.]+)\.(.+)$/.exec(target);
	if (!m) return null;
	return { objectId: m[1], prop: m[2] };
}

function foldTracks(timeline: IgfxTimeline): SceneTrack[] {
	const byObject = new Map<string, SceneTrack>();
	const order: string[] = [];
	for (const v1 of timeline.tracks) {
		const parsed = parseV1Target(v1.target);
		if (!parsed || !ANIMATABLE_SET.has(parsed.prop)) continue;
		let track = byObject.get(parsed.objectId);
		if (!track) {
			track = {
				id: `track-${parsed.objectId}`,
				objectId: parsed.objectId,
				startMs: 0,
				durationMs: timeline.durationMs,
				curves: []
			};
			byObject.set(parsed.objectId, track);
			order.push(parsed.objectId);
		}
		const curve: PropertyCurve = {
			id: `${parsed.objectId}-${parsed.prop}`,
			prop: parsed.prop as AnimatableProp,
			keyframes: v1.keyframes
		};
		const existing = track.curves.findIndex((c) => c.prop === parsed.prop);
		if (existing >= 0) track.curves[existing] = curve;
		else track.curves.push(curve);
	}
	return order.map((id) => byObject.get(id)!);
}

export function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
	const marks = (Array.isArray(raw.marks) ? raw.marks : [])
		.map(parseMark)
		.filter((m): m is AnyMark => !!m);
	const timeline = parseTimeline(raw.timeline);
	const mediaBed = parseMediaBed(raw.mediaBed);
	const objects = marks.map(markToObject);
	const tracks = foldTracks(timeline);
	const scene: Record<string, unknown> = {
		id: 'scene-default',
		name: 'Scene',
		objects,
		timelines: [
			{
				id: 'take-1',
				name: 'Take 1',
				durationMs: timeline.durationMs,
				posterMs: timeline.posterMs,
				tracks
			}
		],
		activeTimelineId: 'take-1'
	};
	if (mediaBed) scene.mediaBed = mediaBed;
	const next: Record<string, unknown> = { ...raw };
	delete next.marks;
	delete next.timeline;
	delete next.mediaBed;
	delete next.scenes;
	next.schemaVersion = IGFX_SCHEMA_VERSION;
	next.scenes = [scene];
	next.activeSceneId = 'scene-default';
	return next;
}
