import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	difference,
	union,
	intersection,
	setClipper2Module,
	setClipper2Enabled,
	setMartinezFallbackEnabled,
	isMartinezFallbackEnabled,
	clipFallbacks,
} from '../src/clipping.ts';

/** A square, as a Polygon (one closed ring). */
const square = (x: number, y: number, s: number) => [[
	[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y],
]] as unknown as Parameters<typeof difference>[0];

/** A stand-in Clipper2 module whose very first call blows up — the shape of a
 *  wasm build that loaded but cannot actually clip. */
const brokenClipper2 = {
	ClipperD: class { constructor() { throw new Error('boom'); } },
	MakePathD: () => { throw new Error('unused'); },
	PathsD: class {},
	PolyPathD: class {},
	FillRule: { NonZero: 0, EvenOdd: 1, Positive: 2, Negative: 3 },
	ClipType: { Intersection: 1, Union: 2, Difference: 3, Xor: 4 },
};

describe('clip engine failure handling', () => {
	afterEach(() => {
		// Uninstall the broken module and restore the shipped defaults, or every
		// later test in the run would clip through a stub that throws.
		setClipper2Module(null);
		setClipper2Enabled(true);
		setMartinezFallbackEnabled(false);
	});

	it('leaves the automatic Martinez fallback off', () => {
		assert.equal(isMartinezFallbackEnabled(), false);
	});

	it('lets a Clipper2 failure through instead of quietly running Martinez', () => {
		setClipper2Module(brokenClipper2);
		// Loud, not silent: the caller (the erase worker) turns this into an
		// `ok: false` reply and leaves the drawing untouched.
		assert.throws(() => difference(square(0, 0, 10), square(4, 4, 10)), /boom/);
		assert.throws(() => union(square(0, 0, 10), square(4, 4, 10)), /boom/);
		assert.throws(() => intersection(square(0, 0, 10), square(4, 4, 10)), /boom/);
	});

	it('counts the failure so the debug popover can show a struggling engine', () => {
		setClipper2Module(brokenClipper2);
		const before = clipFallbacks.count;
		assert.throws(() => difference(square(0, 0, 10), square(4, 4, 10)));
		assert.equal(clipFallbacks.count, before + 1);
	});

	it('does not disable Clipper2 for the rest of the session', () => {
		setClipper2Module(brokenClipper2);
		assert.throws(() => difference(square(0, 0, 10), square(4, 4, 10)));
		// The old behaviour flipped the engine off here, so every later erase ran
		// on Martinez — correct-looking, an order of magnitude slower, invisible.
		// A second call must still attempt Clipper2 (and so still throw).
		assert.throws(() => difference(square(0, 0, 10), square(4, 4, 10)), /boom/);
	});

	it('still routes to Martinez when the fallback is deliberately switched on', () => {
		setClipper2Module(brokenClipper2);
		setMartinezFallbackEnabled(true);
		const res = difference(square(0, 0, 10), square(20, 20, 5));
		// Disjoint clip: the subject survives whole, which only Martinez could
		// have produced here.
		assert.equal(res.length, 1);
	});

	it('uses Martinez untouched when Clipper2 was never installed', () => {
		// The Node test suite's normal state — no wasm module, no throwing.
		const res = difference(square(0, 0, 10), square(20, 20, 5));
		assert.equal(res.length, 1);
	});
});
