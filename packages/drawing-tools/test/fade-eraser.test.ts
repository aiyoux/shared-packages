import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitPathsByEraser, splitTrailIntoPasses, fadeSequence, fadeForIntensity, DEFAULT_FADE, quantizeFade, fadedOpacity } from '../src/eraser.ts';
import { intersection, union } from '../src/clipping.ts';
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
	it('gives every intensity its own run of passes, each ending in deletion', () => {
		const runs = [1, 2, 3, 4, 5].map(i => fadeSequence(fadeForIntensity(i)));
		for (const [i, seq] of runs.entries()) {
			assert.equal(seq[seq.length - 1], 0, `intensity ${i + 1} never deletes: ${seq.join(', ')}`);
			for (let k = 1; k < seq.length; k++) {
				assert.ok(seq[k] < seq[k - 1], `intensity ${i + 1} not monotonic: ${seq.join(', ')}`);
			}
		}
		const lengths = runs.map(l => l.length);
		for (let i = 1; i < lengths.length; i++) {
			assert.ok(lengths[i] <= lengths[i - 1], `intensity ${i + 1} is not harsher: ${lengths.join(', ')}`);
		}
		assert.ok(lengths[4] < lengths[0], `the harshest setting should need fewer passes: ${lengths.join(', ')}`);
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

	// A hook: out along one line, then back along another far enough away that the
	// two never touch the same ink. Reversing the heading is not by itself a second
	// pass, and seaming there put a round cap at each side of the join — a disc of
	// double-strength erase stamped just after every corner.
	const hook = (returnY: number) => {
		const out: { x: number; y: number }[] = [];
		for (let i = 0; i <= 20; i++) out.push({ x: (i * 200) / 20, y: 0 });
		for (let i = 1; i <= 6; i++) out.push({ x: 200, y: (i * returnY) / 6 });
		for (let i = 1; i <= 20; i++) out.push({ x: 200 - (i * 200) / 20, y: returnY });
		return out;
	};

	it('does not split at a corner the trail turns away from', () => {
		const passes = splitTrailIntoPasses(hook(120), 20);
		assert.equal(passes.length, 1, `a hook is one sweep, got ${passes.length}`);
	});

	it('still splits when the return comes back over its own path', () => {
		const passes = splitTrailIntoPasses(hook(8), 20);
		assert.equal(passes.length, 2, `a retrace is two sweeps, got ${passes.length}`);
	});

	// Where the cut goes matters as much as whether there is one. The backtrack
	// only ADDS UP to a radius well after the trail turned, and cutting there
	// leaves the tip beyond the turn inside one pass while the ink around it is
	// inside two — a disc of lighter ink stamped at the turn. Cut at the apex and
	// both passes cap on the same point, so the tip matches its surroundings.
	it('cuts a reversal at the apex, not a radius past it', () => {
		const [first, second] = splitTrailIntoPasses(scrub(0, 200, 0, 2), 20);
		assert.equal(first[first.length - 1].x, 200, 'the outward pass must end AT the turn');
		assert.equal(second[0].x, 200, 'and the return must start there — the apex is shared');
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

	// What erases is the whole disc, not the line its centre travels. Rubbing
	// ALONGSIDE a pile — the body of the eraser over it, the centre beside it —
	// covers every layer just the same, and used to measure a depth of 1: the
	// option silently did nothing, which is how it reads as broken. Nothing
	// makes a user aim the exact middle of a 40px eraser at the ink.
	const fadeBeside = (paths: PathData[], normalizeStack: boolean) =>
		splitPathsByEraser(paths, trail(-40, -25, 240, -25, 24), 40, () => false, {
			fade: { ...DEFAULT_FADE, normalizeStack }
		});

	it('normalises a stack the eraser covers with its body, not its centre', () => {
		const after = fadeBeside(stack(3), true);
		assert.ok(
			after.every(p => (p.opacity ?? 1) < 1),
			'the whole stack should have been under the eraser'
		);
		const seen = composite(after);
		assert.ok(
			Math.abs(seen - 0.55) < 0.08,
			`a stack rubbed off-centre should still land on the ladder, got ${seen.toFixed(2)}`
		);
	});

	// The symptom that started this: rubbing once over a solid black scribble
	// turned it grey AND drew every stroke that built it. Fading a pile in
	// lockstep cannot do otherwise — where four strokes crossed, four faded
	// strokes still composite darker than the two beside them, so the structure
	// under the black comes up as the ink comes down. One layer means ONE shape
	// over the rubbed area, at one opacity.
	// Ribbons crossing each other, the way a scribble piles up. Each is a filled
	// quad so the test can read the area back out of the `d` directly.
	const ribbonAt = (id: string, y: number, tilt: number): PathData => ({
		id, d: `M 0 ${y - 5} L 200 ${y - 5 + tilt} L 200 ${y + 5 + tilt} L 0 ${y + 5} Z`,
		fill: '#000', stroke: 'none', strokeWidth: 0, layerId: 'default'
	});
	const ringsOf = (p: PathData) => p.d.split('M').filter(Boolean).map(part => {
		const n = (part.match(/-?\d*\.?\d+/g) || []).map(Number);
		const ring: [number, number][] = [];
		for (let i = 0; i + 1 < n.length; i += 2) ring.push([n[i], n[i + 1]]);
		if (ring.length > 2) ring.push(ring[0]);
		return ring;
	}).filter(r => r.length > 3);
	const areaOf = (mp: number[][][][]) => mp.reduce((sum, poly) => sum + poly.reduce((s, ring) => {
		let a = 0;
		for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
		return s + Math.abs(a) / 2;
	}, 0), 0);

	it('lightens a scribble evenly instead of drawing the strokes that built it', () => {
		const scribble = [
			ribbonAt('k0', 0, 0), ribbonAt('k1', 4, -8), ribbonAt('k2', -3, 9),
			ribbonAt('k3', 6, 3), ribbonAt('k4', -6, -4)
		];
		const after = splitPathsByEraser(scribble, trail(60, 0, 140, 0, 16), 30, () => false, {
			fade: { ...DEFAULT_FADE, normalizeStack: true }
		});
		const faded = after.filter(p => (p.opacity ?? 1) < 1);
		assert.ok(faded.length > 0, 'the rub should have faded something');
		// One rung, and one THICKNESS: no two faded pieces may paint the same
		// spot, or that spot composites darker and the scribble shows through.
		assert.deepEqual([...new Set(faded.map(p => p.opacity))], [quantizeFade(DEFAULT_FADE.factor)]);
		for (let i = 0; i < faded.length; i++) {
			for (let j = i + 1; j < faded.length; j++) {
				const shared = areaOf(intersection(ringsOf(faded[i]).map(r => [r]), ringsOf(faded[j]).map(r => [r])) as number[][][][]);
				// Coordinates are quantised to 0.1, so pieces that meet along an
				// edge share a sub-pixel sliver. Anything visible is a failure.
				assert.ok(
					shared < 5,
					`faded pieces ${i} and ${j} overlap by ${shared.toFixed(1)}px² — that overlap is a visible line`
				);
			}
		}
	});

	it('leaves the same picture behind, at one layer instead of several', () => {
		const scribble = [ribbonAt('a', 0, 0), ribbonAt('b', 4, -8), ribbonAt('c', -3, 9)];
		const plain = splitPathsByEraser(scribble, trail(60, 0, 140, 0, 16), 30, () => false, { fade: DEFAULT_FADE });
		const flat = splitPathsByEraser(scribble, trail(60, 0, 140, 0, 16), 30, () => false, {
			fade: { ...DEFAULT_FADE, normalizeStack: true }
		});
		// Same ink covered either way — flattening removes hidden overlap, not area.
		const covered = (paths: PathData[]) => {
			const faded = paths.filter(p => (p.opacity ?? 1) < 1).map(p => ringsOf(p).map(r => [r]));
			if (faded.length === 0) return 0;
			const merged = faded.length === 1 ? faded[0] : union(faded[0], ...faded.slice(1));
			return areaOf(merged as unknown as number[][][][]);
		};
		const a = covered(plain), b = covered(flat);
		assert.ok(Math.abs(a - b) / a < 0.02, `flattening changed the faded area: ${a.toFixed(0)} vs ${b.toFixed(0)}`);
	});

	// Ink drawn with the default brush is a closed filled OUTLINE, not a stroked
	// centreline, and a stack of those is the case that has to keep working: the
	// probes cannot be taken on the outline itself, because a vertex of one
	// stroke sits exactly on the boundary of the identical stroke beneath it.
	it('normalises a stack of filled outlines, off-centre like the rest', () => {
		const ribbon = (id: string): PathData => ({
			id, d: 'M 0 -4 L 200 -4 L 200 4 L 0 4 Z',
			fill: '#000', stroke: 'none', strokeWidth: 0, layerId: 'default'
		});
		const filled = ['a', 'b', 'c'].map(ribbon);
		const seen = composite(fadeBeside(filled, true));
		assert.ok(
			Math.abs(seen - 0.55) < 0.08,
			`a stack of filled outlines should land on the ladder, got ${seen.toFixed(2)}`
		);
	});

	// The flip side: ink lying side by side under one wide eraser is not
	// stacked, however much of it the disc covers. Counting it as depth 3 would
	// fade each stroke to 0.23 in a single pass — erasing far more than one rub
	// should. Each probe counts the layers painting ONE point, so it doesn't.
	it('leaves ink that merely shares the eraser, unstacked, on the plain ladder', () => {
		const sideBySide = [-30, 0, 30].map((dy, i) =>
			line(`M 0 ${dy} L 200 ${dy}`, { id: `p${i}` })
		);
		const normalised = fadeBeside(sideBySide, true).map(p => p.opacity ?? 1);
		const plain = fadeBeside(sideBySide, false).map(p => p.opacity ?? 1);
		assert.deepEqual(normalised, plain);
	});
});

// A rub committed while it is still happening ("apply while erasing") reaches
// the same ink several times: consecutive chunks overlap because each sweeps a
// radius past its own ends. `sweepId` is what keeps that from counting as
// several rubs.
// Fading removes NOTHING — it only changes strength — so the ink must still
// cover exactly what it covered before. The cutting modes drop sliver polygons
// as numerical dust, which is right when the area is going away anyway; doing it
// while fading left holes with nothing to paint them, and repeated rubs turned
// those into the white speckling down a much-erased area.
describe('fade eraser keeps every scrap of ink', () => {
	const ringsOf = (p: PathData) => p.d.split('M').filter(Boolean).map(part => {
		const n = (part.match(/-?\d*\.?\d+/g) || []).map(Number);
		const ring: [number, number][] = [];
		for (let i = 0; i + 1 < n.length; i += 2) ring.push([n[i], n[i + 1]]);
		if (ring.length > 2) ring.push(ring[0]);
		return ring;
	}).filter(r => r.length > 3);
	// The pieces a fade pass leaves are disjoint (it splits, and flattening trims
	// what would overlap), so their areas simply add up.
	const areaOf = (paths: PathData[]) => paths.reduce((sum, p) => sum + ringsOf(p).reduce((s, ring) => {
		let a = 0;
		for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
		return s + Math.abs(a) / 2;
	}, 0), 0);
	const blob = (): PathData[] => [{
		id: 'blob', d: 'M 20 20 L 280 20 L 280 120 L 20 120 Z',
		fill: '#000', stroke: 'none', strokeWidth: 0, layerId: 'default'
	}];

	it('covers the same area after a rub as before it', () => {
		const before = blob();
		const after = splitPathsByEraser(before, trail(40, 70, 260, 70, 20), 24, () => false, {
			fade: { ...DEFAULT_FADE, normalizeStack: true, rubId: 'r', sweepId: 's' }
		});
		assert.ok(after.some(p => (p.opacity ?? 1) < 1), 'the rub should have faded something');
		const lost = areaOf(before) - areaOf(after);
		assert.ok(
			lost < areaOf(before) * 0.001,
			`fading lost ${lost.toFixed(1)}px² of ink — every scrap it drops is a hole nothing paints`
		);
	});

	it('still covers the same area after many rubs', () => {
		const before = blob();
		let paths = before;
		for (let rub = 1; rub <= 12; rub++) {
			const y = 70 + Math.sin(rub) * 25;
			paths = splitPathsByEraser(paths, trail(40, y, 260, y, 20), 24, () => false, {
				fade: { ...DEFAULT_FADE, normalizeStack: true, rubId: 'r' + rub, sweepId: 's' + rub }
			});
			// Ink stays put; only its strength changes. Reset so it survives to be
			// re-split, which is what accumulates the damage.
			paths = paths.map(p => ({ ...p, opacity: undefined }));
		}
		const lost = areaOf(before) - areaOf(paths);
		assert.ok(
			lost < areaOf(before) * 0.002,
			`twelve rubs lost ${lost.toFixed(1)}px² of ink: that is what the cracks are made of`
		);
	});
});

describe('fade eraser sweep stamping', () => {
	const fade = { ...DEFAULT_FADE, accumulate: true };

	// One straight rub along a horizontal stroke, committed in `chunks` pieces
	// that overlap the way the store's travel-batched increments do.
	const rubInChunks = (chunks: number, sweepId?: string) => {
		let paths: PathData[] = [line('M 0 0 L 300 0')];
		const span = 300 / chunks;
		for (let c = 0; c < chunks; c++) {
			// Each chunk starts a little before the previous one ended.
			const from = Math.max(0, c * span - 6);
			const to = (c + 1) * span;
			paths = splitPathsByEraser(
				paths,
				trail(from, 0, to, 0),
				4,
				() => false,
				{ fade: sweepId ? { ...fade, sweepId } : fade }
			);
		}
		return paths;
	};

	it('over-fades the seams without the stamp — which is why it exists', () => {
		const unstamped = rubInChunks(6);
		const faded = unstamped.filter(p => (p.opacity ?? 1) < 1).map(p => p.opacity ?? 1);
		assert.ok(
			Math.min(...faded) < fadedOpacity(1, fade)!,
			'unstamped chunks should double-fade their overlaps'
		);
	});

	it('leaves a new sweep free to wear the same ink down further', () => {
		let paths = rubInChunks(4, 'sweep-a');
		const first = Math.min(...paths.filter(p => (p.opacity ?? 1) < 1).map(p => p.opacity ?? 1));
		paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 4, () => false, {
			fade: { ...fade, sweepId: 'sweep-b' }
		});
		const second = Math.min(...paths.filter(p => (p.opacity ?? 1) < 1).map(p => p.opacity ?? 1));
		assert.ok(second < first, `second sweep did not wear further: ${first} -> ${second}`);
	});

	// A rub that crosses its own path used to walk the whole ladder: every
	// reversal is a new sweep, every sweep took a full rung, and the overlap
	// between two sweeps is shaped like the eraser — so a scrub left a pile of
	// discs at 0.55, 0.3, 0.17, 0.09 while the ink beside them sat at 0.55.
	// A rub now has a ceiling (one more rung) that repeat sweeps ease toward,
	// the way a painting tool's stroke opacity caps its flow.
	describe('within one rub', () => {
		const rubbed = (sweeps: number, opts: Partial<typeof DEFAULT_FADE> = {}) => {
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			for (let s = 0; s < sweeps; s++) {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, ...opts, rubId: 'rub-1', sweepId: `sweep-${s}` }
				});
			}
			return Math.min(...paths.map(p => p.opacity ?? 1));
		};

		it('takes a full rung on the first sweep, exactly as before', () => {
			assert.equal(rubbed(1), fadedOpacity(1, DEFAULT_FADE));
		});
		// Every pass multiplies by the same amount, so a rub that crosses its own
		// path keeps biting at full strength. It used to ease off after the first
		// sweep, which made the eraser feel like it was running out the longer you
		// held it down.
		it('takes the same bite on every sweep of a rub', () => {
			const seen: number[] = [];
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			for (let sweep = 0; sweep < 5 && paths.length > 0; sweep++) {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, rubId: 'one-rub', sweepId: `sweep-${sweep}` }
				});
				if (paths.length) seen.push(Math.min(...paths.map(p => p.opacity ?? 1)));
			}
			assert.ok(seen.length >= 3, `expected several sweeps, got ${seen.join(', ')}`);
			for (let i = 1; i < seen.length; i++) {
				const ratio = seen[i] / seen[i - 1];
				assert.ok(
					Math.abs(ratio - DEFAULT_FADE.factor) < 0.02,
					`sweep ${i + 1} left ${(ratio * 100).toFixed(0)}% instead of ${(DEFAULT_FADE.factor * 100).toFixed(0)}%: ${seen.join(', ')}`
				);
			}
		});

		// Rubbing at a mark until it is GONE is the whole gesture. An earlier
		// version capped each rub one rung down, so a scrub stalled around 40%
		// erased and you had to lift and start again to finish the job.
		it('wears the ink away completely without lifting', () => {
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			for (let sweep = 0; sweep < 80 && paths.length > 0; sweep++) {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, rubId: 'one-rub', sweepId: `sweep-${sweep}` }
				});
			}
			assert.deepEqual(paths, [], 'one rub, however long, must be able to finish the job');
		});

		it('gets there faster at a harsher intensity', () => {
			const sweepsToClear = (intensity: number) => {
				let paths: PathData[] = [line('M 0 0 L 300 0')];
				let n = 0;
				while (paths.length > 0 && n < 200) {
					paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
						fade: { ...fadeForIntensity(intensity), rubId: 'r', sweepId: `s${n}` }
					});
					n++;
				}
				return n;
			};
			assert.ok(
				sweepsToClear(5) < sweepsToClear(3) && sweepsToClear(3) < sweepsToClear(1),
				`intensity did not order the effort: ${[1, 3, 5].map(sweepsToClear).join(', ')}`
			);
		});
		// A pass is a multiply, which is exactly what a mask stroke does to what is
		// under it — and that is what lets the drag show a mask while the geometry
		// is worked out, then swap the real thing in without the picture moving.
		it('leaves the same fraction a mask stroke of the same strength would', () => {
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			let expected = 1;
			for (let sweep = 0; sweep < 4 && paths.length > 0; sweep++) {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, rubId: 'r', sweepId: `s${sweep}` }
				});
				expected *= DEFAULT_FADE.factor;
				const seen = Math.min(...paths.map(p => p.opacity ?? 1));
				assert.ok(
					Math.abs(seen - expected) < 1e-9,
					`after ${sweep + 1} passes the ink is at ${seen}, a mask would leave ${expected}`
				);
			}
		});
		it('does not care whether the pen was lifted — a pass is a pass', () => {
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			const rub = (id: string) => {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, rubId: id, sweepId: id + '-0' }
				});
				return Math.min(...paths.map(p => p.opacity ?? 1));
			};
			const first = rub('rub-1');
			const second = rub('rub-2');
			assert.ok(Math.abs(second / first - DEFAULT_FADE.factor) < 1e-9);
		});
		it('needs no rub or sweep id to behave', () => {
			let paths: PathData[] = [line('M 0 0 L 300 0')];
			for (let s = 0; s < 2; s++) {
				paths = splitPathsByEraser(paths, trail(0, 0, 300, 0), 8, () => false, {
					fade: { ...DEFAULT_FADE, sweepId: `sweep-${s}` }
				});
			}
			const seen = Math.min(...paths.map(p => p.opacity ?? 1));
			assert.ok(Math.abs(seen - DEFAULT_FADE.factor ** 2) < 1e-9);
		});
	});
});
