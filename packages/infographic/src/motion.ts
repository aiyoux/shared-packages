import { v1View } from './schema.js';
import type { IgfxDocument, MotionTrack } from './types.js';

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface MarkMotion {
	progress: number;
	opacity: number;
	x: number;
	y: number;
}

const ANIMATABLE = new Set(['progress', 'opacity', 'x', 'y']);
const PROGRESS_KINDS = new Set(['bar', 'line', 'stat']);

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
export function sampleTrack(track: MotionTrack, tMs: number): number {
	const keys = track.keyframes.slice().sort((a, b) => a.tMs - b.tMs);
	if (keys.length === 0) return 0;
	if (tMs <= keys[0].tMs) return keys[0].value;
	const last = keys[keys.length - 1];
	if (tMs >= last.tMs) return last.value;
	let i = 0;
	while (i < keys.length - 1 && keys[i + 1].tMs < tMs) i += 1;
	const a = keys[i];
	const b = keys[i + 1];
	const span = b.tMs - a.tMs;
	const u = span === 0 ? 1 : (tMs - a.tMs) / span;
	const eased = applyEasing(u, a.easing);
	return a.value + (b.value - a.value) * eased;
}

export function parseTrackTarget(target: string): { markId: string; prop: string } | null {
	const m = /^mark:([^.]+)\.(.+)$/.exec(target);
	if (!m) return null;
	return { markId: m[1], prop: m[2] };
}

export function sampleMotion(
	doc: IgfxDocument,
	tMs: number
): { byMark: Map<string, MarkMotion>; warnings: string[] } {
	const view = v1View(doc);
	const byMark = new Map<string, MarkMotion>();
	const kinds = new Map<string, string>();
	for (const mark of view.marks) {
		byMark.set(mark.id, defaultMarkMotion());
		kinds.set(mark.id, mark.kind);
	}
	const warnings: string[] = [];
	for (const track of view.timeline.tracks) {
		const parsed = parseTrackTarget(track.target);
		if (!parsed) {
			warnings.push(`Track "${track.id}" has unrecognized target "${track.target}"`);
			continue;
		}
		if (!ANIMATABLE.has(parsed.prop)) {
			warnings.push(`Track "${track.id}" ignores non-animatable prop "${parsed.prop}"`);
			continue;
		}
		const motion = byMark.get(parsed.markId);
		if (!motion) {
			warnings.push(`Track "${track.id}" targets unknown mark "${parsed.markId}"`);
			continue;
		}
		const kind = kinds.get(parsed.markId);
		if (parsed.prop === 'progress' && kind && !PROGRESS_KINDS.has(kind)) {
			warnings.push(`Track "${track.id}" ignores progress on ${kind} mark "${parsed.markId}"`);
			continue;
		}
		const value = sampleTrack(track, tMs);
		if (parsed.prop === 'progress' || parsed.prop === 'opacity') {
			motion[parsed.prop] = Math.min(1, Math.max(0, value));
		} else if (parsed.prop === 'x' || parsed.prop === 'y') {
			motion[parsed.prop] = value;
		}
	}
	return { byMark, warnings };
}
