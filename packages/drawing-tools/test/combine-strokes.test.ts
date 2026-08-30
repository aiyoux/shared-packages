import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { combineStrokes } from '../src/combine.ts';
import { flattenPathData } from '../src/flatten.ts';
import { strokeToRegion } from '../src/offset.ts';
import type { PathData } from '../src/types';

const stroke = (d: string, extra: Partial<PathData> = {}): PathData => ({
	id: Math.random().toString(36).slice(2),
	d, fill: 'none', stroke: '#000', strokeWidth: 8, layerId: 'default', ...extra
});

/**
 * Does a point land on ink? Sampled from the paths' own geometry: an open
 * stroke covers everything within strokeWidth/2 of its centreline, a filled
 * shape covers its interior. This is how "pixel identical" is checked — the
 * combined result has to paint the same points as the originals.
 */
function covered(paths: PathData[], x: number, y: number): boolean {
	for (const p of paths) {
		const hasFill = !!p.fill && p.fill !== 'none';
		if (hasFill) {
			// Crossings are counted across EVERY ring of the path together. A
			// combined shape carries holes (the gaps a grid of strokes encloses),
			// and testing rings one at a time would report a hole's interior as
			// ink — which is a bug in the check, not the geometry.
			let inside = false;
			for (const sub of flattenPathData(p, 0.25)) {
				const r = sub.points;
				if (r.length < 3) continue;
				for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
					const [xi, yi] = r[i], [xj, yj] = r[j];
					if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
				}
			}
			if (inside) return true;
			continue;
		}
		for (const sub of flattenPathData(p, 0.25)) {
			if (sub.points.length < 2) continue;
			{
				const half = (p.strokeWidth || 1) / 2;
				for (let i = 1; i < sub.points.length; i++) {
					const [ax, ay] = sub.points[i - 1];
					const [bx, by] = sub.points[i];
					const vx = bx - ax, vy = by - ay;
					const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1e-12)));
					if (Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) <= half + 0.35) return true;
				}
			}
		}
	}
	return false;
}

/**
 * How far a point sits from the nearest stroke EDGE in the original artwork.
 * Samples sitting right on an edge are excluded from the comparison: the
 * combined shape approximates round caps and joins with line segments, so its
 * boundary wanders by a fraction of a unit. That is tessellation, not a change
 * in what is painted, and testing it would only measure the arc tolerance.
 */
function distanceToEdge(paths: PathData[], x: number, y: number): number {
	let best = Infinity;
	for (const p of paths) {
		if (p.fill && p.fill !== 'none') continue;
		const half = (p.strokeWidth || 1) / 2;
		for (const sub of flattenPathData(p, 0.25)) {
			for (let i = 1; i < sub.points.length; i++) {
				const [ax, ay] = sub.points[i - 1];
				const [bx, by] = sub.points[i];
				const vx = bx - ax, vy = by - ay;
				const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1e-12)));
				const d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
				best = Math.min(best, Math.abs(d - half));
			}
		}
	}
	return best;
}

/** Compare coverage over a grid — the practical form of "looks identical". */
function coverageMatches(before: PathData[], after: PathData[], box = { x0: -20, y0: -20, x1: 220, y1: 120 }, step = 3) {
	const misses: string[] = [];
	for (let x = box.x0; x <= box.x1; x += step) {
		for (let y = box.y0; y <= box.y1; y += step) {
			if (distanceToEdge(before, x, y) < 1) continue;
			const a = covered(before, x, y);
			const b = covered(after, x, y);
			if (a !== b) misses.push(`(${x},${y}) was ${a ? 'ink' : 'blank'}, now ${b ? 'ink' : 'blank'}`);
		}
	}
	return misses;
}

/**
 * Does a filled path paint (x, y) under the NONZERO rule it is emitted with?
 * `covered` above counts crossings across every ring together, which is the
 * EVEN-ODD reading — it reports a hole as a hole no matter which way the rings
 * are wound, so it cannot see a ring that renders solid. This can.
 */
function fillsUnderNonzero(p: PathData, x: number, y: number): boolean {
	let winding = 0;
	for (const sub of flattenPathData(p, 0.25)) {
		const r = sub.points;
		if (r.length < 3) continue;
		for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
			const [xi, yi] = r[i], [xj, yj] = r[j];
			const side = (xi - xj) * (y - yj) - (x - xj) * (yi - yj);
			if (yj <= y) { if (yi > y && side > 0) winding++; }
			else if (yi <= y && side < 0) winding--;
		}
	}
	return winding !== 0;
}

/** A closed polygonal circle, as an SVG subpath. */
function circleRing(cx: number, cy: number, r: number, reverse = false, steps = 48): string {
	const pts: string[] = [];
	for (let i = 0; i < steps; i++) {
		const a = ((reverse ? -i : i) / steps) * Math.PI * 2;
		pts.push(`${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`);
	}
	return `M ${pts[0]} L ${pts.slice(1).join(' L ')} Z`;
}

/** A filled annulus: outer ring plus a hole wound the other way. */
function ring(_label: string, extra: Partial<PathData>): PathData {
	return stroke(`${circleRing(100, 100, 64)} ${circleRing(100, 100, 56, true)}`, { fillRule: 'nonzero', ...extra });
}

/** One quarter of a circle, as an open stroke. `a0`/`a1` are in half-turns. */
function arcStroke(a0: number, a1: number, r = 60, cx = 100, cy = 100): PathData {
	const pts: string[] = [];
	for (let i = 0; i <= 24; i++) {
		const a = (a0 + (a1 - a0) * (i / 24)) * Math.PI;
		pts.push(`${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`);
	}
	return stroke(`M ${pts[0]} L ${pts.slice(1).join(' L ')}`);
}

describe('combineStrokes', () => {
	it('merges a stack of overlapping same-ink strokes into one shape', () => {
		const before = [
			stroke('M 0 50 L 200 50'),
			stroke('M 0 54 L 200 54'),
			stroke('M 0 46 L 200 46')
		];
		const result = combineStrokes(before);

		assert.equal(result.produced, 1, 'the stack should collapse to a single shape');
		assert.equal(result.absorbed, 3);
		assert.equal(result.paths.length, 1);
		const [combined] = result.paths;
		assert.equal(combined.stroke, 'none', 'a combined shape is filled, not stroked');
		assert.equal(combined.fill, '#000');
	});

	it('paints the same pixels it used to', () => {
		const before = [
			stroke('M 10 40 L 190 40'),
			stroke('M 10 60 L 190 60'),
			stroke('M 40 10 L 40 100'),
			stroke('M 150 10 L 150 100')
		];
		const after = combineStrokes(before).paths;
		const misses = coverageMatches(before, after);
		assert.deepEqual(misses.slice(0, 8), [], `coverage changed at ${misses.length} sample points`);
	});

	it('leaves a single stroke alone', () => {
		const before = [stroke('M 0 0 L 100 0')];
		const result = combineStrokes(before);
		assert.equal(result.produced, 0);
		assert.deepEqual(result.paths, before);
	});

	it('refuses to merge translucent ink, where overlaps composite darker', () => {
		const before = [
			stroke('M 0 50 L 200 50', { opacity: 0.5 }),
			stroke('M 0 54 L 200 54', { opacity: 0.5 })
		];
		const result = combineStrokes(before);
		assert.equal(result.produced, 0, 'translucent overlaps must not be flattened');
		assert.deepEqual(result.paths, before);
	});

	it('refuses to merge blended ink, where building up is the point', () => {
		const before = [
			stroke('M 0 50 L 200 50', { blendMode: 'multiply' }),
			stroke('M 0 54 L 200 54', { blendMode: 'multiply' })
		];
		assert.equal(combineStrokes(before).produced, 0);
	});

	it('keeps different colours apart', () => {
		const before = [
			stroke('M 0 50 L 200 50', { stroke: '#ff0000' }),
			stroke('M 0 54 L 200 54', { stroke: '#0000ff' })
		];
		assert.equal(combineStrokes(before).produced, 0, 'different inks are not interchangeable');
	});

	it('keeps separate layers apart', () => {
		const before = [
			stroke('M 0 50 L 200 50', { layerId: 'a' }),
			stroke('M 0 54 L 200 54', { layerId: 'b' })
		];
		assert.equal(combineStrokes(before).produced, 0);
	});

	it('will not hoist ink above something painted over it', () => {
		// Red sits BETWEEN the two blacks and covers where they overlap.
		// Merging the blacks would lift the lower one above the red.
		const before = [
			stroke('M 0 50 L 200 50'),
			stroke('M 90 0 L 90 100', { stroke: '#ff0000', strokeWidth: 30 }),
			stroke('M 0 54 L 200 54')
		];
		const result = combineStrokes(before);
		assert.equal(result.produced, 0, 'must not reorder across overlapping ink of another colour');
		const misses = coverageMatches(before, result.paths);
		assert.deepEqual(misses.slice(0, 5), []);
	});

	it('does merge across ink that does not overlap it', () => {
		// The red is far away, so collapsing the blacks changes no stacking.
		const before = [
			stroke('M 0 50 L 100 50'),
			stroke('M 0 300 L 100 300', { stroke: '#ff0000' }),
			stroke('M 0 54 L 100 54')
		];
		const result = combineStrokes(before);
		assert.equal(result.produced, 1, 'a distant stroke should not block combining');
		assert.equal(result.paths.length, 2);
	});

	it('keeps the hole in a ring-shaped path instead of filling it solid', () => {
		// A path whose `d` carries an outer ring AND a hole ring is ONE filled
		// shape, not two blobs — a circle that was combined once already, or a
		// stroke the eraser punched a gap in. Merging it must not paint the
		// middle in.
		const before = [
			ring('M 100 100 r 64 + hole r 56', { fill: '#000', stroke: 'none', strokeWidth: 0 }),
			stroke(circleRing(100, 36, 10), { fill: '#000', stroke: 'none', strokeWidth: 0 })
		];
		const result = combineStrokes(before);
		assert.equal(result.produced, 1, 'the ring and the blob touch, so they should merge');
		assert.equal(fillsUnderNonzero(result.paths[0], 100, 100), false,
			'the middle of the ring must stay blank');
		assert.equal(fillsUnderNonzero(result.paths[0], 100, 40), true,
			'the ink itself must still be painted');
	});

	it('is stable when run twice over the same circle', () => {
		// The user-facing shape of the bug: combine a circle drawn from a few
		// arcs, add one more stroke, combine again — the second pass used to
		// flood the circle.
		const arcs = [arcStroke(0, 0.5), arcStroke(0.5, 1), arcStroke(1, 1.5), arcStroke(1.5, 2)];
		const once = combineStrokes(arcs).paths;
		assert.equal(once.length, 1);
		assert.equal(fillsUnderNonzero(once[0], 100, 100), false, 'one pass already keeps the hole');

		const twice = combineStrokes([...once, stroke(circleRing(100, 36, 10), { fill: '#000', stroke: 'none', strokeWidth: 0 })]);
		assert.equal(twice.produced, 1);
		assert.equal(fillsUnderNonzero(twice.paths[0], 100, 100), false,
			'a second pass must not fill the circle in');
	});

	it('removes the geometry that was buried, not just the look of it', () => {
		// The point of the feature: nothing hidden survives to be revealed by a
		// fade eraser later.
		const before = Array.from({ length: 6 }, (_, i) => stroke(`M 0 ${50 + i} L 200 ${50 + i}`));
		const result = combineStrokes(before);
		assert.equal(result.paths.length, 1, `6 stacked strokes should leave 1 shape, got ${result.paths.length}`);
	});
});
