import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitPathsByEraser, splitTrailIntoPasses, fadeSequence, fadeForIntensity, DEFAULT_FADE, quantizeFade, fadedOpacity } from '../src/eraser.ts';
import type { PathData } from '../src/types';

const line = (d: string, extra: Partial<PathData> = {}): PathData => ({
	id: 'l', d, fill: 'none', stroke: '#000', strokeWidth: 2, layerId: 'default', ...extra
});

const trail = (x1: number, y1: number, x2: number, y2: number, n = 16) =>
	Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));

const inkLength = (paths: PathData[]) => paths.reduce((sum, p) => {
	const n = (p.d.match(/-?\d*\.?\d+/g) || []).map(Number);
	let len = 0;
	for (let i = 0; i + 3 < n.length; i += 2) len += Math.hypot(n[i + 2] - n[i], n[i + 3] - n[i + 1]);
	return sum + len;
}, 0);

describe('fade eraser opacity ladder', () => {
	it('rounds so repeated passes are repeatable and pieces can merge', () => {
		assert.equal(quantizeFade(1), 1);
		assert.equal(quantizeFade(0.5512), 0.55);
		assert.equal(quantizeFade(0.3025), 0.3);
		// Same input, same output — that repeatability is what lets two pieces
		// faded the same number of times merge back into one path.
		assert.equal(quantizeFade(0.3025), quantizeFade(0.30249));
	});

	it('gives every intensity its own ladder, each ending in deletion', () => {
		const ladders = [1, 2, 3, 4, 5].map(i => fadeSequence(fadeForIntensity(i)));
		for (const [i, seq] of ladders.entries()) {
			assert.equal(seq[seq.length - 1], 0, `intensity ${i + 1} never deletes: ${seq.join(', ')}`);
			for (let k = 1; k < seq.length; k++) {
				assert.ok(seq[k] < seq[k - 1], `intensity ${i + 1} not monotonic: ${seq.join(', ')}`);
			}
		}
		// Gentler settings must take strictly more rubbing to wear through.
		const lengths = ladders.map(l => l.length);
		for (let i = 1; i < lengths.length; i++) {
			assert.ok(lengths[i] < lengths[i - 1], `intensity ${i + 1} is not harsher: ${lengths.join(', ')}`);
		}
	});

	it('steps down on each pass and eventually reports worn through', () => {
		let opacity: number | null = 1;
		const seen: number[] = [];
		for (let i = 0; i < 12 && opacity !== null; i++) {
			opacity = fadedOpacity(opacity, DEFAULT_FADE);
			if (opacity !== null) seen.push(opacity);
		}
		assert.ok(seen.length >= 3, `expected several fade steps, got ${seen.join(', ')}`);
		assert.deepEqual(seen, [...seen].sort((a, b) => b - a), 'opacity must decrease monotonically');
		assert.equal(opacity, null, 'the ladder must terminate rather than loop at the bottom');
	});
});

describe('fade eraser on open strokes', () => {
	it('dims the covered stretch instead of removing it', () => {
		const original = line('M 0 0 L 100 0');
		const after = splitPathsByEraser([{ ...original }], trail(45, 0, 55, 0), 8, () => false, { fade: DEFAULT_FADE });

		// Nothing is cut away: the total ink still spans the original stroke.
		assert.ok(Math.abs(inkLength(after) - 100) < 2, `ink length changed: ${inkLength(after)}`);
		const dimmed = after.filter(p => (p.opacity ?? 1) < 1);
		const full = after.filter(p => (p.opacity ?? 1) === 1);
		assert.ok(dimmed.length > 0, 'the covered stretch should have been dimmed');
		assert.ok(full.length > 0, 'the untouched ends should keep full opacity');
		assert.equal(dimmed[0].opacity, quantizeFade(DEFAULT_FADE.factor));
	});

	it('leaves a stroke the eraser never reached completely alone', () => {
		const original = line('M 0 0 L 100 0');
		const after = splitPathsByEraser([{ ...original }], trail(0, 400, 100, 400), 8, () => false, { fade: DEFAULT_FADE });
		assert.equal(after.length, 1);
		assert.equal(after[0].d, original.d);
		assert.equal(after[0].opacity, undefined);
	});

	it('re-issues a fully covered stroke unsplit, so scrubbing does not multiply paths', () => {
		let paths = [line('M 0 0 L 20 0')];
		const counts: number[] = [];
		for (let pass = 0; pass < 4; pass++) {
			paths = splitPathsByEraser(paths, trail(-30, 0, 50, 0), 40, () => false, { fade: DEFAULT_FADE });
			counts.push(paths.length);
		}
		assert.ok(counts.every(c => c <= 1), `path count grew while scrubbing: ${counts.join(', ')}`);
	});

	it('wears a stroke away entirely after enough passes', () => {
		let paths = [line('M 0 0 L 20 0')];
		for (let pass = 0; pass < 12 && paths.length > 0; pass++) {
			paths = splitPathsByEraser(paths, trail(-30, 0, 50, 0), 40, () => false, { fade: DEFAULT_FADE });
		}
		assert.deepEqual(paths, [], 'repeated passes must eventually remove the stroke');
	});

	it('still cuts cleanly when no fade option is supplied', () => {
		const after = splitPathsByEraser([line('M 0 0 L 100 0')], trail(45, 0, 55, 0), 8);
		assert.ok(inkLength(after) < 95, 'without fade the covered stretch must be removed');
		assert.ok(after.every(p => (p.opacity ?? 1) === 1), 'clean cut must not dim anything');
	});
});

describe('fade preview ladder', () => {
	// The live preview fades by compositing one destination-out stroke per pass,
	// so its cumulative result is a PRODUCT of per-pass alphas. Deriving each
	// alpha from this sequence is what keeps the preview and the commit in step;
	// a fixed alpha gives a smooth factor^n that drifts badly (by the third pass
	// the commit is ~28% darker, and on the fourth the preview still shows ink
	// the commit has deleted).
	it('ends at zero so the ink is deleted, not left invisible', () => {
		const seq = fadeSequence(DEFAULT_FADE);
		assert.equal(seq[seq.length - 1], 0, `ladder must terminate in deletion: ${seq.join(', ')}`);
		assert.ok(seq.length >= 3, `expected a few visible steps, got ${seq.join(', ')}`);
	});

	it('descends monotonically', () => {
		const seq = fadeSequence(DEFAULT_FADE);
		for (let i = 1; i < seq.length; i++) {
			assert.ok(seq[i] < seq[i - 1], `ladder went up at step ${i}: ${seq.join(', ')}`);
		}
	});

	it('composes back to the ladder when used as per-pass preview alphas', () => {
		// This is the arithmetic the preview relies on: stroking pass k at
		// (1 - L[k]/L[k-1]) and compositing leaves exactly L[k].
		const seq = fadeSequence(DEFAULT_FADE);
		let cumulative = 1;
		seq.forEach((target, i) => {
			const previous = i === 0 ? 1 : seq[i - 1];
			const alpha = previous <= 0 ? 1 : 1 - target / previous;
			cumulative *= 1 - alpha;
			assert.ok(
				Math.abs(cumulative - target) < 1e-9,
				`pass ${i + 1}: preview composed to ${cumulative}, commit lands on ${target}`
			);
		});
	});

	it('matches what repeated committed passes actually produce', () => {
		const seq = fadeSequence(DEFAULT_FADE);
		let paths = [line('M 0 0 L 20 0')];
		const committed: number[] = [];
		for (let i = 0; i < seq.length; i++) {
			paths = splitPathsByEraser(paths, trail(-40, 0, 60, 0), 40, () => false, { fade: DEFAULT_FADE });
			committed.push(paths.length === 0 ? 0 : Math.min(...paths.map(p => p.opacity ?? 1)));
		}
		assert.deepEqual(committed, seq, 'the ladder must describe the real commit sequence');
	});
});

describe('fade eraser emits lines, not dots', () => {
	// A path barely longer than its own round caps renders as a filled DISC.
	// Scrubbing used to leave a row of those at assorted opacities — the ink
	// read as "batches of circles" rather than a clean faded band — because
	// slivers between the fade bands were re-emitted as their own paths.
	const scrubOver = (strokeWidth: number) => {
		const pts: { x: number; y: number }[] = [];
		for (let sweep = 0; sweep < 6; sweep++) {
			const [from, to] = sweep % 2 === 0 ? [40, 260] : [260, 40];
			for (let i = 0; i <= 14; i++) pts.push({ x: from + ((to - from) * i) / 14, y: 0 });
		}
		return splitPathsByEraser(
			[line('M 0 0 L 300 0', { strokeWidth })], pts, 30, () => false,
			{ fade: { ...DEFAULT_FADE, accumulate: true } }
		);
	};

	for (const strokeWidth of [2, 6, 16]) {
		it(`leaves no dot-sized fragments on a ${strokeWidth}-wide stroke`, () => {
			const runt = scrubOver(strokeWidth)
				.map(p => {
					const n = (p.d.match(/-?\d*\.?\d+/g) || []).map(Number);
					let len = 0;
					for (let i = 0; i + 3 < n.length; i += 2) len += Math.hypot(n[i + 2] - n[i], n[i + 3] - n[i + 1]);
					return { d: p.d, len, opacity: p.opacity ?? 1 };
				})
				// A run shorter than the stroke is thick is swallowed by its own
				// caps and paints as a blob.
				.filter(p => p.len < strokeWidth / 2);
			assert.deepEqual(
				runt.map(p => `${p.d} (len ${p.len.toFixed(1)}, opacity ${p.opacity})`),
				[],
				'dot-sized fragments survived the scrub'
			);
		});
	}
});

describe('fade eraser accumulation within one drag', () => {
	// A scrub back and forth without lifting the pointer should keep wearing the
	// ink down. Unioned into a single pass the second sweep changes nothing, so
	// the trail is cut into passes at its reversals.
	const scrub = (x1: number, x2: number, y: number, sweeps: number) => {
		const pts: { x: number; y: number }[] = [];
		for (let s = 0; s < sweeps; s++) {
			const [from, to] = s % 2 === 0 ? [x1, x2] : [x2, x1];
			for (let i = 0; i <= 12; i++) pts.push({ x: from + ((to - from) * i) / 12, y });
		}
		return pts;
	};

	it('splits a to-and-fro trail into one pass per sweep', () => {
		const passes = splitTrailIntoPasses(scrub(0, 200, 0, 3), 20);
		assert.equal(passes.length, 3, `expected 3 sweeps, got ${passes.length}`);
	});

	it('keeps a straight sweep as a single pass despite jitter', () => {
		const jittery = Array.from({ length: 40 }, (_, i) => ({ x: i * 5, y: (i % 2) * 0.6 }));
		assert.equal(splitTrailIntoPasses(jittery, 20).length, 1);
	});

	it('fades further the more you scrub over the same spot', () => {
		const opacityAfter = (sweeps: number) => {
			const out = splitPathsByEraser(
				[line('M 0 0 L 20 0')], scrub(-40, 60, 0, sweeps), 40, () => false,
				{ fade: { ...DEFAULT_FADE, accumulate: true } }
			);
			return out.length === 0 ? 0 : Math.min(...out.map(p => p.opacity ?? 1));
		};
		const one = opacityAfter(1);
		const three = opacityAfter(3);
		assert.ok(one > 0, 'a single sweep should leave the ink partly visible');
		assert.ok(three < one, `scrubbing 3x should fade further than 1x (${three} vs ${one})`);
	});

	it('applies exactly one step per drag when accumulation is off', () => {
		const once = splitPathsByEraser(
			[line('M 0 0 L 20 0')], scrub(-40, 60, 0, 1), 40, () => false,
			{ fade: { ...DEFAULT_FADE, accumulate: false } }
		);
		const scrubbed = splitPathsByEraser(
			[line('M 0 0 L 20 0')], scrub(-40, 60, 0, 4), 40, () => false,
			{ fade: { ...DEFAULT_FADE, accumulate: false } }
		);
		assert.equal(
			Math.min(...scrubbed.map(p => p.opacity ?? 1)),
			Math.min(...once.map(p => p.opacity ?? 1)),
			'without accumulation a scrub must land on the same single step as one sweep'
		);
	});

	it('reports removals and additions against the ORIGINAL paths, not intermediates', () => {
		const original = line('M 0 0 L 20 0');
		const untouched = line('M 0 500 L 20 500', { id: 'far' });
		const sync = { removed: [] as PathData[], added: [] as PathData[] };
		const before = [original, untouched];
		const after = splitPathsByEraser(before, scrub(-40, 60, 0, 3), 40, () => false,
			{ fade: { ...DEFAULT_FADE, accumulate: true }, sync });

		// The far stroke is carried through as the SAME object and must not show
		// up in the diff at all.
		assert.ok(after.includes(untouched), 'the untouched stroke should pass through by identity');
		assert.ok(!sync.removed.includes(untouched), 'untouched stroke wrongly reported as removed');
		assert.ok(!sync.added.includes(untouched), 'untouched stroke wrongly reported as added');
		// And no intermediate piece may leak into the diff.
		for (const p of sync.added) assert.ok(after.includes(p), 'an intermediate piece leaked into sync.added');
		for (const p of sync.removed) assert.ok(before.includes(p), 'a non-original path leaked into sync.removed');
	});
});

describe('fade eraser on filled shapes', () => {
	const rect = (): PathData => ({
		id: 'r', d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
		fill: '#000', stroke: 'none', strokeWidth: 0, layerId: 'default'
	});

	it('keeps the overlap at a lower opacity rather than punching a hole', () => {
		const after = splitPathsByEraser([rect()], trail(50, 50, 60, 50), 15, () => false, { fade: DEFAULT_FADE });
		const dimmed = after.filter(p => (p.opacity ?? 1) < 1);
		assert.ok(dimmed.length > 0, 'the overlapped region should survive, dimmed');
		assert.ok(after.some(p => (p.opacity ?? 1) === 1), 'the rest of the shape keeps full opacity');
	});

	it('leaves a distant filled shape untouched', () => {
		const original = rect();
		const after = splitPathsByEraser([{ ...original }], trail(500, 500, 520, 500), 15, () => false, { fade: DEFAULT_FADE });
		assert.equal(after.length, 1);
		assert.equal(after[0].d, original.d);
	});
});

describe('fade eraser normalising a stack', () => {
	// Ink drawn over itself is the case the plain ladder handles badly: three
	// opaque strokes faded once are each 0.55, but stacked they still composite
	// to 1-(1-0.55)^3 = 0.91 — the pile looks untouched, and further rubbing
	// thins the top one first so the lines underneath are REVEALED rather than
	// erased. Normalising fades each to whatever makes the stack itself land on
	// the ladder.
	const stack = (n: number) =>
		Array.from({ length: n }, (_, i) => line('M 0 0 L 200 0', { id: `s${i}` }));

	const composite = (paths: PathData[]) =>
		1 - paths.reduce((acc, p) => acc * (1 - (p.opacity ?? 1)), 1);

	const fadeStack = (paths: PathData[], normalizeStack: boolean) =>
		splitPathsByEraser(paths, trail(-40, 0, 240, 0, 24), 40, () => false, {
			fade: { ...DEFAULT_FADE, normalizeStack }
		});

	it('leaves a stack looking barely touched without it', () => {
		const after = fadeStack(stack(3), false);
		assert.ok(
			composite(after) > 0.85,
			`plain fade should leave the stack near-opaque, got ${composite(after).toFixed(2)}`
		);
	});

	it('lightens the whole stack together with it', () => {
		const after = fadeStack(stack(3), true);
		const seen = composite(after);
		assert.ok(
			Math.abs(seen - 0.55) < 0.08,
			`normalised fade should take the stack to ~0.55, got ${seen.toFixed(2)}`
		);
	});

	it('keeps every layer at the same strength, so none is revealed', () => {
		const after = fadeStack(stack(4), true);
		const opacities = after.map(p => p.opacity ?? 1);
		assert.ok(
			Math.max(...opacities) - Math.min(...opacities) < 0.02,
			`layers drifted apart: ${opacities.join(', ')}`
		);
	});

	it('behaves exactly like the plain ladder on unstacked ink', () => {
		const plain = fadeStack([line('M 0 0 L 200 0')], false).map(p => p.opacity ?? 1);
		const normalised = fadeStack([line('M 0 0 L 200 0')], true).map(p => p.opacity ?? 1);
		assert.deepEqual(normalised, plain);
	});

	it('still wears the stack away completely', () => {
		let paths = stack(3);
		for (let i = 0; i < 12 && paths.length > 0; i++) paths = fadeStack(paths, true);
		assert.deepEqual(paths, [], 'a normalised stack must still erase to nothing');
	});
});
