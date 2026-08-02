import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sampleArc } from '../src/path.ts';
import { pathBounds } from '../src/raster.ts';
import { splitPathsByEraser } from '../src/eraser.ts';
import type { PathData } from '../src/types';

// A circle exactly as svgBake.ts emits baked round primitives (cloud puffs,
// sun glows, halos): an absolute moveto at the LEFT extreme, then two relative
// semicircular arcs. Nothing in this package used to understand `a`, so these
// shapes were invisible to both the eraser and the bounds used for the
// dirty-rect repaint and the erase spatial grid.
const bakedCircle = (cx: number, cy: number, r: number): string =>
	`M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(r * 2).toFixed(2)} 0 ` +
	`a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-r * 2).toFixed(2)} 0 Z`;

const puff = (d: string, transform?: string): PathData => ({
	id: 'puff',
	d,
	fill: '#ffffff',
	stroke: '#1d3557',
	strokeWidth: 3.8,
	layerId: 'default',
	transform
});

describe('sampleArc', () => {
	it('traces a semicircle through its true extremes', () => {
		// (0,0) -> (20,0), r=10, sweep-flag 0 is the negative-angle direction,
		// which in SVG's y-down space bulges to POSITIVE y.
		const pts = sampleArc(0, 0, 10, 10, 0, 1, 0, 20, 0);
		const ys = pts.map(p => p.y);
		assert.ok(Math.max(...ys) > 9.9, `expected the arc to reach y≈10, got ${Math.max(...ys)}`);
		assert.ok(Math.min(...ys) >= -0.001, 'the arc should not cross to the other side of the chord');
		const last = pts[pts.length - 1];
		assert.ok(Math.abs(last.x - 20) < 1e-9 && Math.abs(last.y) < 1e-9, 'must land exactly on the endpoint');
	});

	it('mirrors to the other half when the sweep flag flips', () => {
		const ys = sampleArc(0, 0, 10, 10, 0, 1, 1, 20, 0).map(p => p.y);
		assert.ok(Math.min(...ys) < -9.9, `expected the arc to reach y≈-10, got ${Math.min(...ys)}`);
	});

	it('degrades to a straight line for a zero radius', () => {
		assert.deepEqual(sampleArc(0, 0, 0, 0, 0, 0, 0, 5, 5), [{ x: 5, y: 5 }]);
	});
});

describe('pathBounds with arcs', () => {
	it('bounds a baked circle to the circle, not to its arc arguments', () => {
		// Radii and the large-arc/sweep FLAGS used to be read as coordinates,
		// which put the box nowhere near the shape.
		const b = pathBounds(puff(bakedCircle(100, 50, 20)))!;
		const margin = 3.8 / 2 + 1;
		assert.ok(Math.abs(b.x - (80 - margin)) < 0.5, `x ${b.x}`);
		assert.ok(Math.abs(b.y - (30 - margin)) < 0.5, `y ${b.y}`);
		assert.ok(Math.abs(b.width - (40 + margin * 2)) < 0.5, `width ${b.width}`);
		assert.ok(Math.abs(b.height - (40 + margin * 2)) < 0.5, `height ${b.height}`);
	});

	it('offsets an arc path by its translate transform', () => {
		const plain = pathBounds(puff(bakedCircle(100, 50, 20)))!;
		const moved = pathBounds(puff(bakedCircle(100, 50, 20), 'translate(733.96484375, 355.7265625)'))!;
		assert.ok(Math.abs(moved.x - (plain.x + 733.96484375)) < 1e-6);
		assert.ok(Math.abs(moved.y - (plain.y + 355.7265625)) < 1e-6);
	});

	it('still bounds arc-free polylines exactly as before', () => {
		assert.deepEqual(
			pathBounds({ ...puff('M 10 20 L 30 50'), strokeWidth: 4, stroke: '#000', fill: 'none' }),
			{ x: 7, y: 17, width: 26, height: 36 }
		);
	});
});

describe('erasing baked arc shapes', () => {
	const trail = (x1: number, y1: number, x2: number, y2: number, n = 12) =>
		Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));

	it('cuts a baked circle instead of leaving it untouched', () => {
		const circle = puff(bakedCircle(100, 50, 25));
		const after = splitPathsByEraser([{ ...circle }], trail(60, 50, 140, 50), 12);
		const unchanged = after.length === 1 && after[0].d === circle.d;
		assert.ok(!unchanged, 'the eraser must actually modify an arc-based baked circle');
	});

	it('leaves a baked circle alone when the eraser is nowhere near it', () => {
		const circle = puff(bakedCircle(100, 50, 25));
		const after = splitPathsByEraser([{ ...circle }], trail(400, 400, 480, 400), 12);
		assert.equal(after.length, 1);
		assert.equal(after[0].d, circle.d, 'a distant stroke must not touch it');
	});

	it('does not stroke the eraser cut edge (no "inner lines" inside an erased cloud)', () => {
		// A baked puff is a FILLED circle with an OUTLINE. Clipping the fill and
		// stroking the result traces the eraser's cut, drawing a fresh line right
		// where ink was meant to be removed. The fix splits the two: fill pieces
		// lose their stroke, and the outline is re-cut from the original rim.
		const circle = puff(bakedCircle(100, 100, 30));
		const after = splitPathsByEraser([{ ...circle }], trail(140, 100, 128, 100), 14);

		assert.ok(after.length > 1, 'expected the puff to be split into fill + outline pieces');
		// The defect, stated directly: nothing may be filled AND stroked, because
		// such a piece necessarily strokes its own clipped (cut) boundary.
		const both = after.filter(p => p.fill && p.fill !== 'none' && p.stroke && p.stroke !== 'none');
		assert.deepEqual(both.map(p => p.d), [], 'a piece is still both filled and stroked — its cut edge gets outlined');

		// Both halves survive: the fill is still there, and so is a real rim.
		assert.ok(after.some(p => p.fill === '#ffffff' && p.stroke === 'none'), 'fill piece missing');
		const rim = after.filter(p => p.fill === 'none' && p.stroke === '#1d3557');
		assert.ok(rim.length > 0, 'outline piece missing');
		// The surviving rim must stay clear of the erased region: the eraser sat
		// at x≈128..140 on the circle's right side, so no rim point may be there.
		for (const p of rim) {
			const n = p.d.match(/-?\d*\.?\d+/g)!.map(Number);
			for (let i = 0; i + 1 < n.length; i += 2) {
				const d = Math.hypot(n[i] - 134, n[i + 1] - 100);
				assert.ok(d > 14 - 1, `rim point (${n[i]}, ${n[i + 1]}) lies inside the erased region`);
			}
		}
	});

	it('cuts it through the middle of the circle, not only at its left extreme', () => {
		// The old flattener collapsed the circle to its start point (the left
		// extreme), so a stroke over the RIGHT side reached nothing at all.
		const circle = puff(bakedCircle(100, 50, 25), 'translate(200, 300)');
		const after = splitPathsByEraser([{ ...circle }], trail(318, 330, 318, 380), 12);
		assert.ok(
			after.length !== 1 || after[0].d !== circle.d,
			'a stroke crossing the right-hand side of the circle must erase something'
		);
	});
});
