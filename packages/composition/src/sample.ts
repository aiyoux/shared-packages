import type { ActiveSample, Clip, CompositionDoc } from './types.js';

function clipContains(clip: Clip, tMs: number): boolean {
	if (clip.durationMs <= 0) return false;
	const local = tMs - clip.startMs;
	// Closed at the end so a playhead paused on durationMs still samples the last frame.
	return local >= 0 && local <= clip.durationMs;
}

/**
 * Active clip per track. v1: no overlap; if overlap is ever allowed, later clips win.
 * `localMs` is pre-adjusted (`tMs - startMs + offsetMs`) so renderers never subtract `startMs`.
 */
export function sample(comp: CompositionDoc, tMs: number): ActiveSample[] {
	const out: ActiveSample[] = [];
	for (const track of comp.tracks) {
		let winner: Clip | undefined;
		for (const clip of track.clips) {
			if (clipContains(clip, tMs)) winner = clip;
		}
		if (!winner) continue;
		out.push({
			track,
			clip: winner,
			localMs: tMs - winner.startMs + winner.offsetMs
		});
	}
	return out;
}
