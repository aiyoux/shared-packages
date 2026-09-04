/**
 * The animation document's op vocabulary and reducer.
 *
 * Every mutation — local or arriving from another tab — goes through
 * `applyAnimOp`, which is the single seam the live-document layer plugs into
 * (`reduce` in `createLiveSession`). See Phase 2 of scratch-pad
 * `docs/design/live-documents.md`.
 *
 * Two properties every op here must keep:
 *
 *  - **Idempotent.** Applying the same op twice must equal applying it once.
 *    That is what lets self-echo be filtered at the transport instead of
 *    tracked per-op ("did I originate this?" bookkeeping), and it makes a
 *    replayed or duplicated frame harmless (M11). Note this is why poses are
 *    absolute rather than relative: `set-clip-frame` states where the clip IS,
 *    never how far it moved.
 *
 *  - **One user action = one op.** A drag emits transient previews while it
 *    runs and exactly ONE op on release. Emitting per-pointermove ops floods
 *    every replica and bloats undo (M10/L7).
 */

import type { AnimCanvas, AnimClip, AnimDocument, AnimFrame, AnimKeyframe } from './types.js';

export type AnimOp =
	/** Absolute pose for a clip's static frame. */
	| { t: 'set-clip-frame'; clipId: string; frame: AnimFrame }
	/** Upsert a keyframe at `tMs` (absolute pose channels). */
	| { t: 'set-keyframe'; clipId: string; keyframe: AnimKeyframe }
	/** Retime an existing keyframe. No-op if nothing sits at `fromTMs`. */
	| { t: 'move-keyframe'; clipId: string; fromTMs: number; toTMs: number }
	| { t: 'remove-keyframe'; clipId: string; tMs: number }
	/** Upsert a whole clip (drop/bind, or an undo restoring one). */
	| { t: 'put-clip'; clip: AnimClip }
	| { t: 'remove-clip'; clipId: string }
	/** Empty name clears it, restoring the derived label. */
	| { t: 'rename-clip'; clipId: string; name: string }
	| { t: 'set-clip-times'; clipId: string; startMs: number; durationMs: number }
	| { t: 'set-duration'; durationMs: number }
	| { t: 'set-canvas'; canvas: AnimCanvas }
	/** Re-point a snapshot-bound clip at freshly read source bytes. */
	| { t: 'set-clip-snapshot'; clipId: string; clip: AnimClip };

/**
 * An object's span on the timeline is strictly first-to-last keyframe, so any
 * op that changes the keyframe set recomputes the duration from it rather than
 * only growing it. Dragging the final keyframe earlier must shrink the clip,
 * not leave a dead tail past it.
 */
function withKeyframes(clip: AnimClip, keyframes: AnimKeyframe[]): AnimClip {
	const sorted = [...keyframes].sort((a, b) => a.tMs - b.tMs);
	if (sorted.length === 0) return { ...clip, keyframes: sorted };
	return { ...clip, keyframes: sorted, durationMs: sorted[sorted.length - 1]!.tMs };
}

/**
 * Replace one clip by id.
 *
 * Returns the ORIGINAL document reference when the clip was missing or the
 * callback handed back the same object — an op that changes nothing must not
 * produce a new identity, or every no-op (including the second delivery of an
 * idempotent op) would invalidate reactive consumers and re-render for free.
 */
function mapClip(
	doc: AnimDocument,
	clipId: string,
	fn: (clip: AnimClip) => AnimClip
): AnimDocument {
	let changed = false;
	const clips = doc.clips.map((c) => {
		if (c.id !== clipId) return c;
		const next = fn(c);
		if (next !== c) changed = true;
		return next;
	});
	return changed ? { ...doc, clips } : doc;
}

export function applyAnimOp(doc: AnimDocument, op: AnimOp): AnimDocument {
	switch (op.t) {
		case 'set-clip-frame':
			return mapClip(doc, op.clipId, (clip) => ({ ...clip, frame: { ...op.frame } }));

		case 'set-keyframe':
			return mapClip(doc, op.clipId, (clip) => {
				const rest = (clip.keyframes ?? []).filter((k) => k.tMs !== op.keyframe.tMs);
				return withKeyframes(clip, [...rest, { ...op.keyframe }]);
			});

		case 'move-keyframe':
			return mapClip(doc, op.clipId, (clip) => {
				const keys = clip.keyframes ?? [];
				const target = keys.find((k) => k.tMs === op.fromTMs);
				// Already moved (or never existed): applying twice is a no-op,
				// which is what keeps this op idempotent.
				if (!target) return clip;
				// Refuse to collapse two keyframes into one.
				if (op.toTMs !== op.fromTMs && keys.some((k) => k.tMs === op.toTMs)) return clip;
				const rest = keys.filter((k) => k.tMs !== op.fromTMs);
				return withKeyframes(clip, [...rest, { ...target, tMs: op.toTMs }]);
			});

		case 'remove-keyframe':
			return mapClip(doc, op.clipId, (clip) => {
				const keys = clip.keyframes ?? [];
				if (!keys.some((k) => k.tMs === op.tMs)) return clip;
				return withKeyframes(
					clip,
					keys.filter((k) => k.tMs !== op.tMs)
				);
			});

		case 'put-clip': {
			const exists = doc.clips.some((c) => c.id === op.clip.id);
			if (exists) return mapClip(doc, op.clip.id, () => ({ ...op.clip }));
			return { ...doc, clips: [...doc.clips, { ...op.clip }] };
		}

		case 'remove-clip': {
			if (!doc.clips.some((c) => c.id === op.clipId)) return doc;
			return { ...doc, clips: doc.clips.filter((c) => c.id !== op.clipId) };
		}

		case 'rename-clip':
			return mapClip(doc, op.clipId, (clip) => {
				const next = op.name.trim();
				if ((clip.name ?? '') === next) return clip;
				if (!next) {
					const { name: _drop, ...rest } = clip;
					return rest as AnimClip;
				}
				return { ...clip, name: next };
			});

		case 'set-clip-times':
			return mapClip(doc, op.clipId, (clip) => ({
				...clip,
				startMs: op.startMs,
				durationMs: op.durationMs
			}));

		case 'set-duration':
			return doc.durationMs === op.durationMs ? doc : { ...doc, durationMs: op.durationMs };

		case 'set-canvas':
			return { ...doc, canvas: { ...op.canvas } };

		case 'set-clip-snapshot':
			return mapClip(doc, op.clipId, () => ({ ...op.clip }));

		default: {
			// Exhaustiveness: a new op must be handled, not silently ignored —
			// a dropped op means replicas diverge with nothing to show for it.
			const never: never = op;
			void never;
			return doc;
		}
	}
}
