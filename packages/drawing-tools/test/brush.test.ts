import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	PENCIL_GRADES,
	brushMaterialProps,
	brushParams,
	buildBasicStrokePath,
	buildFreehandStrokePath,
	buildStrokeSegmentPath,
	effectiveStrokeWidth,
	normalizePencilGrade,
	pressureStrokeOpacity
} from '../src/brush.ts';

// Paths carry a non-deterministic `id` (for the erase spatial grid); strip it
// before deep-equal so the contracts assert the deterministic shape only.
const withoutId = ({ id: _id, ...rest }: { id?: string } & Record<string, unknown>) => rest;

describe('pressure-driven opacity (pencil & marker)', () => {
	it('ramps pencil from a reduced baseline up to the grade nominal as pressure rises', () => {
		// HB nominal 0.34: baseline floor = max(0.1, 0.34*0.35)=0.119 → ~0.12.
		// Light press (p=0) is lighter than the no-pressure nominal (0.34); full
		// press (p=1) reaches the nominal so heavy press matches today's darkness.
		assert.ok(pressureStrokeOpacity(0, 'pencil', 'HB') < 0.34);
		assert.equal(pressureStrokeOpacity(1, 'pencil', 'HB'), 0.34);
		assert.ok(pressureStrokeOpacity(0.5, 'pencil', 'HB') > pressureStrokeOpacity(0, 'pencil', 'HB'));
		assert.ok(pressureStrokeOpacity(0.5, 'pencil', 'HB') < 0.34);
		// Harder grade (4B, nominal 0.68) is darker across the whole range.
		assert.ok(pressureStrokeOpacity(0.5, 'pencil', '4B') > pressureStrokeOpacity(0.5, 'pencil', 'HB'));
	});

	it('ramps marker (highlighter) from a reduced baseline up to its nominal', () => {
		assert.ok(pressureStrokeOpacity(0, 'highlighter') < 0.5);
		assert.equal(pressureStrokeOpacity(1, 'highlighter'), 0.5);
		assert.ok(pressureStrokeOpacity(0.7, 'highlighter') > pressureStrokeOpacity(0.2, 'highlighter'));
	});

	it('honors a highlighterOpacity override for the nominal (and its pressure ramp)', () => {
		assert.equal(pressureStrokeOpacity(1, 'highlighter', 'HB', 0.8), 0.8);
		assert.ok(pressureStrokeOpacity(0, 'highlighter', 'HB', 0.8) < 0.8);
		// Other brush types ignore the override entirely.
		assert.equal(pressureStrokeOpacity(1, 'pen', 'HB', 0.8), 1);
	});

	it('keeps a faint floor at zero pressure so light strokes still read', () => {
		assert.ok(pressureStrokeOpacity(0, 'pencil', '2H') >= 0.1);
		assert.ok(pressureStrokeOpacity(0, 'highlighter') >= 0.1);
	});

	it('clamps out-of-range pressure to 0..1', () => {
		assert.equal(pressureStrokeOpacity(-1, 'pencil', 'HB'), pressureStrokeOpacity(0, 'pencil', 'HB'));
		assert.equal(pressureStrokeOpacity(2, 'pencil', 'HB'), pressureStrokeOpacity(1, 'pencil', 'HB'));
	});

	it('leaves pen opaque regardless of pressure (pen is not pressure-darkened)', () => {
		assert.equal(pressureStrokeOpacity(0, 'pen'), 1);
		assert.equal(pressureStrokeOpacity(1, 'pen'), 1);
	});
});

describe('brush SVG path contracts', () => {
	it('keeps pen paths opaque and unblended by omitting default material props', () => {
		assert.deepEqual(brushParams('pen'), {
			opacity: 1,
			blendMode: 'normal',
			widthMult: 1,
			thinning: 0.6,
			smoothing: 0.5,
			streamline: 0.5
		});
		assert.deepEqual(brushMaterialProps('pen'), {});
		assert.equal(effectiveStrokeWidth(6, 'pen'), 6);
	});

	it('offers pencil graphite grades that build up through transparent multiply strokes', () => {
		assert.deepEqual(PENCIL_GRADES, ['2H', 'H', 'HB', 'B', '2B', '4B']);
		assert.equal(normalizePencilGrade('6B'), 'HB');
		assert.equal(normalizePencilGrade('B'), 'B');

		assert.deepEqual(brushMaterialProps('pencil'), {
			opacity: 0.34,
			blendMode: 'multiply'
		});
		assert.deepEqual(brushMaterialProps('pencil', '2H'), {
			opacity: 0.2,
			blendMode: 'multiply'
		});
		assert.deepEqual(brushMaterialProps('pencil', '4B'), {
			opacity: 0.68,
			blendMode: 'multiply'
		});
		assert.equal(effectiveStrokeWidth(10, 'pencil'), 8.4);
		assert.equal(effectiveStrokeWidth(10, 'pencil', '4B'), 10.4);

		assert.deepEqual(withoutId(buildBasicStrokePath('M 0 0 L 10 0', '#333333', 10, 'ink', 'pencil', 'B')), {
			d: 'M 0 0 L 10 0',
			stroke: '#333333',
			fill: 'none',
			strokeWidth: 9,
			layerId: 'ink',
			opacity: 0.44,
			blendMode: 'multiply'
		});
	});

	it('makes highlighter paths wide and translucent, source-over (not multiply)', () => {
		// Multiply against committed opaque ink hid the marker under pen strokes
		// on pointer-up. Source-over + opacity keeps it on top; blendMode is
		// omitted when normal (same contract as pen).
		assert.deepEqual(brushMaterialProps('highlighter'), {
			opacity: 0.5
		});
		assert.equal(effectiveStrokeWidth(5, 'highlighter'), 20);

		assert.deepEqual(withoutId(buildStrokeSegmentPath(1, 2, 3, 4, 18, '#ffff00', 'notes', 'highlighter')), {
			d: 'M 1 2 L 3 4',
			stroke: '#ffff00',
			fill: 'none',
			strokeWidth: 18,
			layerId: 'notes',
			opacity: 0.5
		});

		// A caller-supplied strength overrides the nominal default.
		assert.deepEqual(brushMaterialProps('highlighter', 'HB', 0.8), {
			opacity: 0.8
		});
		assert.deepEqual(withoutId(buildStrokeSegmentPath(1, 2, 3, 4, 18, '#ffff00', 'notes', 'highlighter', 'HB', 0.8)), {
			d: 'M 1 2 L 3 4',
			stroke: '#ffff00',
			fill: 'none',
			strokeWidth: 18,
			layerId: 'notes',
			opacity: 0.8
		});
	});

	it('commits freehand brush strokes as filled outlines, not stroked centerlines', () => {
		const source = {
			points: [[0, 0, 0.5], [10, 0, 0.5]] as [number, number, number][],
			options: { size: 10, thinning: 0.6, smoothing: 0.5, streamline: 0.5 }
		};

		assert.deepEqual(withoutId(buildFreehandStrokePath('M 0 0 L 10 0 Z', '#000000', 'default', 'pen', source)), {
			d: 'M 0 0 L 10 0 Z',
			stroke: 'none',
			fill: '#000000',
			strokeWidth: 0,
			layerId: 'default',
			freehandSource: source
		});

		assert.deepEqual(withoutId(buildFreehandStrokePath('M 0 0 L 10 0 Z', '#ffff00', 'default', 'highlighter')), {
			d: 'M 0 0 L 10 0 Z',
			stroke: 'none',
			fill: '#ffff00',
			strokeWidth: 0,
			layerId: 'default',
			opacity: 0.5
		});

		// highlighterOpacity sets the nominal; an explicit trailing `opacity`
		// (pressure-derived per-point value) still wins over both.
		assert.deepEqual(withoutId(buildFreehandStrokePath('M 0 0 L 10 0 Z', '#ffff00', 'default', 'highlighter', undefined, 'HB', undefined, 0.8)), {
			d: 'M 0 0 L 10 0 Z',
			stroke: 'none',
			fill: '#ffff00',
			strokeWidth: 0,
			layerId: 'default',
			opacity: 0.8
		});
	});
});
