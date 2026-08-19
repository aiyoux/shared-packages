import { trackCovers } from './motion.js';
import { newId } from './schema.js';
import {
	MAX_KEYS_PER_CURVE,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	type AnimatableProp,
	type IgfxScene,
	type MotionKeyframe,
	type PropertyCurve,
	type SceneTimeline,
	type SceneTrack
} from './types.js';

function isFullSpan(track: SceneTrack, takeDurationMs: number): boolean {
	return track.startMs === 0 && track.durationMs === takeDurationMs;
}

function roundMs(value: number): number {
	return Math.round(value);
}

function findTrack(take: SceneTimeline, trackId: string): SceneTrack | undefined {
	return take.tracks.find((tr) => tr.id === trackId);
}

function laterCoveringTrack(take: SceneTimeline, objectId: string, tMs: number): SceneTrack | undefined {
	let found: SceneTrack | undefined;
	for (const track of take.tracks) {
		if (track.objectId === objectId && trackCovers(track, tMs)) found = track;
	}
	return found;
}

function laterFullSpanTrack(take: SceneTimeline, objectId: string): SceneTrack | undefined {
	let found: SceneTrack | undefined;
	for (const track of take.tracks) {
		if (track.objectId === objectId && isFullSpan(track, take.durationMs)) found = track;
	}
	return found;
}

function pushTrack(take: SceneTimeline, track: SceneTrack): SceneTrack {
	if (take.tracks.length >= MAX_TRACKS_PER_TAKE) return track;
	take.tracks.push(track);
	return track;
}

/** Place (`P`): 2 s visibility clip at the playhead. Does not auto-place descendants. */
export function placeObjectAtPlayhead(
	take: SceneTimeline,
	objectId: string,
	playheadMs: number,
	durationMs?: number
): SceneTrack {
	const startMs = Math.max(0, roundMs(playheadMs));
	const remaining = take.durationMs - startMs;
	const requested = durationMs === undefined ? Math.min(2000, remaining) : roundMs(durationMs);
	const track: SceneTrack = {
		id: newId('track'),
		objectId,
		startMs,
		durationMs: Math.max(1, requested),
		curves: []
	};
	return pushTrack(take, track);
}

/** First curve on an unlinked object: full-span track (v1 motion). Does not convert a place clip. */
export function ensureFullSpanTrack(take: SceneTimeline, objectId: string): SceneTrack {
	const existing = laterFullSpanTrack(take, objectId);
	if (existing) return existing;
	return pushTrack(take, {
		id: newId('track'),
		objectId,
		startMs: 0,
		durationMs: take.durationMs,
		curves: []
	});
}

/**
 * Writes a key onto the later covering track when `key.tMs` falls in one;
 * otherwise `ensureFullSpanTrack` (does not create a second 2 s clip).
 */
export function addKeyframe(
	take: SceneTimeline,
	objectId: string,
	prop: AnimatableProp,
	key: MotionKeyframe
): SceneTrack {
	const tMs = Math.min(take.durationMs, Math.max(0, roundMs(key.tMs)));
	const covering = Number.isFinite(tMs) ? laterCoveringTrack(take, objectId, tMs) : undefined;
	const track = covering ?? ensureFullSpanTrack(take, objectId);
	if (!Number.isFinite(tMs) || !Number.isFinite(key.value)) return track;
	if (!take.tracks.includes(track)) return track;

	let curve: PropertyCurve | undefined;
	for (const c of track.curves) {
		if (c.prop === prop) curve = c;
	}
	if (!curve) {
		curve = { id: `${objectId}-${prop}`, prop, keyframes: [] };
		track.curves.push(curve);
	}

	const next: MotionKeyframe = { tMs, value: key.value };
	if (key.easing) next.easing = key.easing;

	const existing = curve.keyframes.findIndex((k) => k.tMs === tMs);
	if (existing >= 0) {
		curve.keyframes[existing] = next;
	} else if (curve.keyframes.length >= MAX_KEYS_PER_CURVE) {
		return track;
	} else {
		curve.keyframes.push(next);
	}
	curve.keyframes.sort((a, b) => a.tMs - b.tMs);
	return track;
}

export function moveTrack(take: SceneTimeline, trackId: string, startMs: number): void {
	const track = findTrack(take, trackId);
	if (!track) return;
	track.startMs = Math.max(0, roundMs(startMs));
}

export function trimTrack(
	take: SceneTimeline,
	trackId: string,
	startMs: number,
	durationMs: number
): void {
	const track = findTrack(take, trackId);
	if (!track) return;
	track.startMs = Math.max(0, roundMs(startMs));
	track.durationMs = Math.max(0, roundMs(durationMs));
}

export function unlinkTrack(take: SceneTimeline, trackId: string): void {
	const i = take.tracks.findIndex((tr) => tr.id === trackId);
	if (i < 0) return;
	take.tracks.splice(i, 1);
}

/** Full-span tracks follow; place clips do not. Pin poster to the new end when it was the old end. */
export function setTakeDuration(take: SceneTimeline, durationMs: number): void {
	const old = take.durationMs;
	const nextMs = Math.max(0, roundMs(durationMs));
	for (const track of take.tracks) {
		if (isFullSpan(track, old)) track.durationMs = nextMs;
	}
	take.durationMs = nextMs;
	if (take.posterMs === old) take.posterMs = nextMs;
	else take.posterMs = Math.min(nextMs, Math.max(0, take.posterMs));
}

export function setTakePoster(take: SceneTimeline, posterMs: number): void {
	take.posterMs = Math.min(take.durationMs, Math.max(0, roundMs(posterMs)));
}

/** New take id, cloned tracks, becomes the scene's active take. */
export function duplicateTake(scene: IgfxScene, takeId: string): SceneTimeline {
	const source = scene.timelines.find((t) => t.id === takeId);
	if (!source) {
		return (
			scene.timelines.find((t) => t.id === scene.activeTimelineId) ??
			scene.timelines[0] ??
			{ id: newId('take'), name: 'Take 1', durationMs: 0, posterMs: 0, tracks: [] }
		);
	}
	if (scene.timelines.length >= MAX_TAKES_PER_SCENE) return source;
	const copy: SceneTimeline = {
		id: newId('take'),
		name: `${source.name} copy`,
		durationMs: source.durationMs,
		posterMs: source.posterMs,
		tracks: structuredClone(source.tracks)
	};
	scene.timelines.push(copy);
	scene.activeTimelineId = copy.id;
	return copy;
}
