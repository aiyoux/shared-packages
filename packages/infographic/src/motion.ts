import { ancestorsOf } from './objects.js';
import type {
	AnimatableProp,
	IgfxObject,
	IgfxScene,
	MotionKeyframe,
	MotionTrack,
	ObjectTransform,
	SceneTimeline,
	SceneTrack
} from './types.js';
import { ANIMATABLE_PROPS } from './types.js';

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface MarkMotion {
	progress: number;
	opacity: number;
	x: number;
	y: number;
}

export interface ObjectSample {
	visible: boolean;
	motion: {
		progress: number;
		opacity: number;
		x: number;
		y: number;
		w: number;
		h: number;
		rotation: number;
		value?: number;
		pointX?: number;
		pointY?: number;
	};
}

const ANIMATABLE = new Set<string>(ANIMATABLE_PROPS);
const PROGRESS_KINDS = new Set(['bar', 'line', 'stat', 'series']);

export function defaultMarkMotion(): MarkMotion {
	return { progress: 1, opacity: 1, x: 0, y: 0 };
}

export function applyEasing(t: number, easing?: string): number {
	const u = Math.min(1, Math.max(0, t));
	switch (easing) {
		case 'easeIn':
			return u * u;
		case 'easeOut':
			return 1 - (1 - u) * (1 - u);
		case 'easeInOut':
			return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
		default:
			return u;
	}
}

/** Hold first/last key. Linear mix in between, then the left key's easing. */
export function sampleKeyframes(keys: MotionKeyframe[], tMs: number): number {
	const sorted = keys.slice().sort((a, b) => a.tMs - b.tMs);
	if (sorted.length === 0) return 0;
	if (tMs <= sorted[0].tMs) return sorted[0].value;
	const last = sorted[sorted.length - 1];
	if (tMs >= last.tMs) return last.value;
	let i = 0;
	while (i < sorted.length - 1 && sorted[i + 1].tMs < tMs) i += 1;
	const a = sorted[i];
	const b = sorted[i + 1];
	const span = b.tMs - a.tMs;
	const u = span === 0 ? 1 : (tMs - a.tMs) / span;
	const eased = applyEasing(u, a.easing);
	return a.value + (b.value - a.value) * eased;
}

export function sampleTrack(track: MotionTrack, tMs: number): number {
	return sampleKeyframes(track.keyframes, tMs);
}

export function parseTrackTarget(target: string): { markId: string; prop: string } | null {
	const m = /^(?:mark|object):([^.]+)\.(.+)$/.exec(target);
	if (!m) return null;
	return { markId: m[1], prop: m[2] };
}

/** Closed range — match composition `clipContains` so posterMs = durationMs still samples. */
export function trackCovers(track: SceneTrack, tMs: number): boolean {
	if (track.durationMs <= 0) return false;
	const local = tMs - track.startMs;
	return local >= 0 && local <= track.durationMs;
}

function defaultObjectMotion(obj: IgfxObject): ObjectSample['motion'] {
	return {
		progress: 1,
		opacity: obj.transform.opacity,
		x: 0,
		y: 0,
		w: obj.transform.w,
		h: obj.transform.h,
		rotation: obj.transform.rotation
	};
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function applyProp(motion: ObjectSample['motion'], prop: string, value: number): void {
	switch (prop) {
		case 'progress':
			motion.progress = clamp01(value);
			break;
		case 'opacity':
			motion.opacity = clamp01(value);
			break;
		case 'x':
			motion.x = value;
			break;
		case 'y':
			motion.y = value;
			break;
		case 'w':
			motion.w = value;
			break;
		case 'h':
			motion.h = value;
			break;
		case 'rotation':
			motion.rotation = value;
			break;
		case 'value':
			motion.value = value;
			break;
		case 'pointX':
			motion.pointX = value;
			break;
		case 'pointY':
			motion.pointY = value;
			break;
	}
}

export function objectVisible(
	scene: IgfxScene,
	take: SceneTimeline,
	obj: IgfxObject,
	tMs: number
): boolean {
	if (!obj.visible) return false;
	const tracks = take.tracks;
	const linked = (id: string) => tracks.some((tr) => tr.objectId === id);
	const anyCover = (id: string) =>
		tracks.some((tr) => tr.objectId === id && trackCovers(tr, tMs));
	if (linked(obj.id) && !anyCover(obj.id)) return false;
	for (const ancestor of ancestorsOf(scene, obj.id)) {
		if (!ancestor.visible) return false;
		if (linked(ancestor.id) && !anyCover(ancestor.id)) return false;
	}
	return true;
}

export function sampleTake(
	scene: IgfxScene,
	take: SceneTimeline,
	tMs: number
): { byObject: Map<string, ObjectSample>; warnings: string[] } {
	const byId = new Map(scene.objects.map((o) => [o.id, o]));
	const warnings: string[] = [];
	const byObject = new Map<string, ObjectSample>();

	for (const obj of scene.objects) {
		byObject.set(obj.id, {
			visible: objectVisible(scene, take, obj, tMs),
			motion: defaultObjectMotion(obj)
		});
	}

	// Later tracks[] entry wins per prop. Separate from OR-visibility above.
	for (const track of take.tracks) {
		const obj = byId.get(track.objectId);
		if (!obj) {
			warnings.push(`Track "${track.id}" targets unknown object "${track.objectId}"`);
			continue;
		}
		if (!trackCovers(track, tMs)) continue;
		const sample = byObject.get(obj.id);
		if (!sample) continue;
		for (const curve of track.curves) {
			if (!ANIMATABLE.has(curve.prop)) {
				warnings.push(`Track "${track.id}" ignores non-animatable prop "${curve.prop}"`);
				continue;
			}
			if (curve.prop === 'progress' && !PROGRESS_KINDS.has(obj.kind)) {
				warnings.push(`Track "${track.id}" ignores progress on ${obj.kind} object "${obj.id}"`);
				continue;
			}
			if (curve.keyframes.length === 0) continue;
			applyProp(sample.motion, curve.prop, sampleKeyframes(curve.keyframes, tMs));
		}
	}

	return { byObject, warnings };
}

export function sampledLocal(
	obj: IgfxObject,
	sample: ObjectSample
): Partial<ObjectTransform> {
	return {
		x: obj.transform.x + sample.motion.x,
		y: obj.transform.y + sample.motion.y,
		w: sample.motion.w,
		h: sample.motion.h,
		rotation: sample.motion.rotation,
		opacity: sample.motion.opacity
	};
}

export type { AnimatableProp };
