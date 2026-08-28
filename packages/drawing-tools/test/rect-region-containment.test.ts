import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { eraserSweptRegionPolygon, rectRegionContainment } from '../src/eraser.ts';
import { union } from '../src/clipping.ts';
import type { Point } from '../src/eraser.ts';

/**
 * The vector fade preview classifies each path's bounds against each live
 * stand-in's region: 'inside' lets the path render with element opacity —
 * exactly what masking it produces — 'outside' skips the mask, 'partial'
 * keeps it. The classification must be conservative in exactly one direction:
 * anything that is not PROVABLY inside or outside reads 'partial', because a
 * wrong 'inside' would thin ink the commit leaves at full strength.
 */

const line = (x0: number, y0: number, x1: number, y1: number): Point[] => {
	const pts: Point[] = [];
	for (let i = 0; i <= 20; i++) pts.push({ x: x0 + ((x1 - x0) * i) / 20, y: y0 + ((y1 - y0) * i) / 20 });
	return pts;
};
const regionOf = (pts: Point[], r: number) => union(eraserSweptRegionPolygon(pts, r)!);
const rect = (x: number, y: number, w: number, h: number) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });

describe('rectRegionContainment', () => {
	const corridor = regionOf(line(100, 500, 700, 500), 40);

	it('a rect well inside the corridor is inside', () => {
		assert.equal(rectRegionContainment(rect(300, 480, 50, 40), corridor), 'inside');
	});

	it('a rect well clear of the corridor is outside', () => {
		assert.equal(rectRegionContainment(rect(300, 700, 50, 40), corridor), 'outside');
	});

	it('a rect crossing the corridor edge is partial', () => {
		assert.equal(rectRegionContainment(rect(300, 520, 50, 40), corridor), 'partial');
	});

	it('a rect against the corridor boundary is never inside', () => {
		// bbox flush with the cap's extreme — rounding may shave it; it must
		// not read 'inside' unless the geometry gives the whole rect back.
		const state = rectRegionContainment(rect(100 - 40, 500 - 40, 80, 80), corridor);
		assert.notEqual(state, 'partial' === state ? 'inside' : 'inside');
		assert.ok(state === 'inside' || state === 'partial');
	});

	it('degenerate rects are partial', () => {
		assert.equal(rectRegionContainment(rect(300, 500, 0, 40), corridor), 'partial');
	});

	it('null regions are partial', () => {
		assert.equal(rectRegionContainment(rect(0, 0, 10, 10), null), 'partial');
	});

	it('a self-crossing trail resolves to the filled region, not the shoelace area', () => {
		// A trail that loops back over itself: the ring overlaps itself, and a
		// rect inside the loop's double-covered lobe is still inside the
		// region the nonzero fill paints.
		const pts: Point[] = [];
		for (let i = 0; i <= 10; i++) pts.push({ x: 100 + i * 10, y: 500 });
		for (let i = 10; i >= 0; i--) pts.push({ x: 100 + i * 10, y: 512 });
		const looped = regionOf(pts, 40);
		assert.equal(rectRegionContainment(rect(130, 490, 40, 30), looped), 'inside');
	});
});
