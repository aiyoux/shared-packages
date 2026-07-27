import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathBounds, rectsIntersect, unionRect } from '../src/raster.ts';
import type { PathData } from '../src/types';

const base: PathData = { d: '', stroke: '#000', fill: 'none', strokeWidth: 0, layerId: 'default' };

describe('raster geometry helpers', () => {
	it('computes a padded bbox from a polyline path', () => {
		const b = pathBounds({ ...base, d: 'M 10 20 L 30 50', strokeWidth: 4 });
		// min(10,20)..max(30,50) padded by strokeWidth/2 + 1 = 3
		assert.deepEqual(b, { x: 7, y: 17, width: 26, height: 36 });
	});

	it('offsets the bbox by a translate transform', () => {
		const b = pathBounds({ ...base, d: 'M 0 0 L 10 10', strokeWidth: 0, transform: 'translate(100, 5)' });
		assert.deepEqual(b, { x: 99, y: 4, width: 12, height: 12 });
	});

	it('returns null for a path without coordinates', () => {
		assert.equal(pathBounds({ ...base, d: '' }), null);
	});

	it('detects overlapping and disjoint rects', () => {
		const a = { x: 0, y: 0, width: 10, height: 10 };
		assert.equal(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 }), true);
		assert.equal(rectsIntersect(a, { x: 20, y: 0, width: 5, height: 5 }), false);
		// edge-touching does not count as intersecting
		assert.equal(rectsIntersect(a, { x: 10, y: 0, width: 5, height: 5 }), false);
	});

	it('unions rects into a covering rect', () => {
		assert.deepEqual(
			unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }),
			{ x: 0, y: 0, width: 30, height: 15 }
		);
		assert.deepEqual(unionRect(null, { x: 2, y: 3, width: 4, height: 5 }), { x: 2, y: 3, width: 4, height: 5 });
	});
});
