import { describe, expect, it } from 'vitest';
import { applyAnimOp, type AnimOp } from './ops.js';
import type { AnimClip, AnimDocument } from './types.js';

function clip(id: string, over: Partial<AnimClip> = {}): AnimClip {
	return {
		id,
		bind: 'clone',
		startMs: 0,
		durationMs: 4000,
		frame: { x: 0, y: 0, w: 100, h: 100 },
		...over
	} as AnimClip;
}

function doc(clips: AnimClip[] = [clip('a')]): AnimDocument {
	return { schemaVersion: 1, durationMs: 10_000, clips };
}

/** Every op must satisfy apply(apply(d, op), op) === apply(d, op) (M11). */
function expectIdempotent(d: AnimDocument, op: AnimOp): AnimDocument {
	const once = applyAnimOp(d, op);
	const twice = applyAnimOp(once, op);
	expect(twice).toEqual(once);
	return once;
}

describe('applyAnimOp — idempotence', () => {
	it('holds for every op in the vocabulary', () => {
		const base = doc([clip('a', { keyframes: [{ tMs: 0, x: 0 }, { tMs: 4000, x: 50 }] })]);
		const ops: AnimOp[] = [
			{ t: 'set-clip-frame', clipId: 'a', frame: { x: 5, y: 6, w: 7, h: 8 } },
			{ t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 1000, x: 9 } },
			{ t: 'move-keyframe', clipId: 'a', fromTMs: 4000, toTMs: 2000 },
			{ t: 'remove-keyframe', clipId: 'a', tMs: 0 },
			{ t: 'put-clip', clip: clip('b') },
			{ t: 'remove-clip', clipId: 'a' },
			{ t: 'rename-clip', clipId: 'a', name: 'Hero' },
			{ t: 'set-clip-times', clipId: 'a', startMs: 100, durationMs: 900 },
			{ t: 'set-duration', durationMs: 5000 },
			{ t: 'set-canvas', canvas: { w: 1280, h: 720 } },
			{ t: 'set-clip-snapshot', clipId: 'a', clip: clip('a', { name: 'snap' }) }
		];
		for (const op of ops) expectIdempotent(base, op);
	});
});

describe('applyAnimOp — purity', () => {
	it('never mutates the input document or its clips', () => {
		const original = doc([clip('a', { keyframes: [{ tMs: 0, x: 1 }] })]);
		const frozen = JSON.parse(JSON.stringify(original));
		applyAnimOp(original, { t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 500, x: 2 } });
		applyAnimOp(original, { t: 'remove-clip', clipId: 'a' });
		applyAnimOp(original, { t: 'set-duration', durationMs: 1 });
		expect(original).toEqual(frozen);
	});

	it('returns the same reference when nothing changed, so consumers can skip work', () => {
		const d = doc();
		expect(applyAnimOp(d, { t: 'remove-clip', clipId: 'missing' })).toBe(d);
		expect(applyAnimOp(d, { t: 'set-duration', durationMs: d.durationMs })).toBe(d);
		expect(applyAnimOp(d, { t: 'set-clip-frame', clipId: 'nope', frame: { x: 0, y: 0, w: 1, h: 1 } })).toBe(d);
	});
});

describe('keyframe ops keep the span first-to-last', () => {
	it('set-keyframe past the end grows the clip', () => {
		const d = doc([clip('a', { durationMs: 1000, keyframes: [{ tMs: 0, x: 0 }] })]);
		const next = applyAnimOp(d, { t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 3000, x: 1 } });
		expect(next.clips[0].durationMs).toBe(3000);
	});

	it('moving the final keyframe earlier SHRINKS the clip', () => {
		const d = doc([clip('a', { durationMs: 4000, keyframes: [{ tMs: 0 }, { tMs: 4000 }] })]);
		const next = applyAnimOp(d, { t: 'move-keyframe', clipId: 'a', fromTMs: 4000, toTMs: 1500 });
		expect(next.clips[0].durationMs).toBe(1500);
		expect(next.clips[0].keyframes?.map((k) => k.tMs)).toEqual([0, 1500]);
	});

	it('removing the final keyframe shrinks to the new last one', () => {
		const d = doc([clip('a', { durationMs: 4000, keyframes: [{ tMs: 0 }, { tMs: 2000 }, { tMs: 4000 }] })]);
		const next = applyAnimOp(d, { t: 'remove-keyframe', clipId: 'a', tMs: 4000 });
		expect(next.clips[0].durationMs).toBe(2000);
	});

	it('keeps keyframes sorted however they arrive', () => {
		const d = doc([clip('a', { keyframes: [{ tMs: 0 }] })]);
		let next = applyAnimOp(d, { t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 3000 } });
		next = applyAnimOp(next, { t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 1000 } });
		expect(next.clips[0].keyframes?.map((k) => k.tMs)).toEqual([0, 1000, 3000]);
	});

	it('set-keyframe upserts rather than duplicating a time', () => {
		const d = doc([clip('a', { keyframes: [{ tMs: 1000, x: 1 }] })]);
		const next = applyAnimOp(d, { t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 1000, x: 99 } });
		expect(next.clips[0].keyframes).toEqual([{ tMs: 1000, x: 99 }]);
	});
});

describe('move-keyframe edge cases', () => {
	it('is a no-op when nothing sits at the source time (the second apply)', () => {
		const d = doc([clip('a', { keyframes: [{ tMs: 0 }, { tMs: 4000 }] })]);
		const next = applyAnimOp(d, { t: 'move-keyframe', clipId: 'a', fromTMs: 1234, toTMs: 10 });
		expect(next).toBe(d);
	});

	it('refuses to collapse two keyframes into one', () => {
		const d = doc([clip('a', { keyframes: [{ tMs: 0 }, { tMs: 2000 }] })]);
		const next = applyAnimOp(d, { t: 'move-keyframe', clipId: 'a', fromTMs: 2000, toTMs: 0 });
		expect(next.clips[0].keyframes?.map((k) => k.tMs)).toEqual([0, 2000]);
	});
});

describe('clip ops', () => {
	it('put-clip appends a new clip and upserts an existing one', () => {
		const d = doc([clip('a')]);
		const added = applyAnimOp(d, { t: 'put-clip', clip: clip('b') });
		expect(added.clips.map((c) => c.id)).toEqual(['a', 'b']);
		const updated = applyAnimOp(added, { t: 'put-clip', clip: clip('b', { startMs: 500 }) });
		expect(updated.clips).toHaveLength(2);
		expect(updated.clips[1].startMs).toBe(500);
	});

	it('rename-clip clears the name on empty, restoring the derived label', () => {
		const d = doc([clip('a', { name: 'Hero' })]);
		const cleared = applyAnimOp(d, { t: 'rename-clip', clipId: 'a', name: '  ' });
		expect('name' in cleared.clips[0]).toBe(false);
	});

	it('remove-clip drops only the named clip', () => {
		const d = doc([clip('a'), clip('b')]);
		const next = applyAnimOp(d, { t: 'remove-clip', clipId: 'a' });
		expect(next.clips.map((c) => c.id)).toEqual(['b']);
	});
});

describe('applying a stream converges regardless of who authored it', () => {
	it('two replicas fed the same ops in the same order agree', () => {
		const ops: AnimOp[] = [
			{ t: 'put-clip', clip: clip('a', { keyframes: [{ tMs: 0, x: 0 }] }) },
			{ t: 'set-keyframe', clipId: 'a', keyframe: { tMs: 2000, x: 40 } },
			{ t: 'rename-clip', clipId: 'a', name: 'Hero' },
			{ t: 'move-keyframe', clipId: 'a', fromTMs: 2000, toTMs: 1000 },
			{ t: 'set-duration', durationMs: 8000 }
		];
		const start = doc([]);
		const leader = ops.reduce(applyAnimOp, start);
		// The follower also sees one duplicate delivery, which must not matter.
		const follower = [...ops, ops[3]].reduce(applyAnimOp, start);
		expect(follower).toEqual(leader);
	});
});
