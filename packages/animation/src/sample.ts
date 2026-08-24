import type { AnimClip, AnimFrame, AnimKeyframe } from './types.js';

function lerp(a: number, b: number, u: number): number {
	return a + (b - a) * u;
}

type Pose = { x: number; y: number; w: number; h: number; rotation: number };

function poseFromFrame(frame: AnimFrame): Pose {
	return {
		x: frame.x,
		y: frame.y,
		w: frame.w,
		h: frame.h,
		rotation: frame.rotation ?? 0
	};
}

function applyKey(prev: Pose, key: AnimKeyframe): Pose {
	return {
		x: key.x ?? prev.x,
		y: key.y ?? prev.y,
		w: key.w ?? prev.w,
		h: key.h ?? prev.h,
		rotation: key.rotation ?? prev.rotation
	};
}

function toFrame(pose: Pose): AnimFrame {
	return pose.rotation
		? { x: pose.x, y: pose.y, w: pose.w, h: pose.h, rotation: pose.rotation }
		: { x: pose.x, y: pose.y, w: pose.w, h: pose.h };
}

/**
 * Interpolate `clip.frame` plus optional `keyframes` at composition time `timeMs`.
 * Key times are relative to `clip.startMs`. The rest pose is an implicit key at 0.
 */
export function sampleClipFrame(clip: AnimClip, timeMs: number): AnimFrame {
	const local = Math.max(0, timeMs - clip.startMs);
	const rest = poseFromFrame(clip.frame);
	const keys = [...(clip.keyframes ?? [])].sort((a, b) => a.tMs - b.tMs);
	if (keys.length === 0) return toFrame(rest);

	const poses: Array<Pose & { tMs: number }> = [{ tMs: 0, ...rest }];
	for (const key of keys) {
		if (key.tMs <= 0) {
			const next = applyKey(poses[0], key);
			poses[0] = { tMs: 0, ...next };
			continue;
		}
		const prev = poses[poses.length - 1];
		poses.push({ tMs: key.tMs, ...applyKey(prev, key) });
	}

	if (local <= poses[0].tMs) return toFrame(poses[0]);
	const last = poses[poses.length - 1];
	if (local >= last.tMs) return toFrame(last);

	let i = 1;
	while (i < poses.length && poses[i].tMs < local) i += 1;
	const a = poses[i - 1];
	const b = poses[i];
	const span = b.tMs - a.tMs;
	const u = span <= 0 ? 1 : (local - a.tMs) / span;
	return toFrame({
		x: lerp(a.x, b.x, u),
		y: lerp(a.y, b.y, u),
		w: lerp(a.w, b.w, u),
		h: lerp(a.h, b.h, u),
		rotation: lerp(a.rotation, b.rotation, u)
	});
}
