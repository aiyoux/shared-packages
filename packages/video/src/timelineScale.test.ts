import { describe, expect, it } from 'vitest';
import {
	BAR_HEIGHT,
	clampTrimEnd,
	clampTrimStart,
	filmstripLayout,
	playheadNear,
	setTrimFromPlayhead,
	filmstripThumbWidth,
	frameCacheKey,
	slipRange
} from './timelineScale.js';

describe('filmstripLayout', () => {
	it('covers the visible window with cells the thumbnail width', () => {
		const thumbW = filmstripThumbWidth(BAR_HEIGHT, 16 / 9);
		const cells = filmstripLayout({
			duration: 10,
			trackWidth: 1000,
			viewLeft: 0,
			viewWidth: 400,
			thumbHeight: BAR_HEIGHT,
			aspect: 16 / 9,
			overscanPx: 0
		});
		expect(cells.length).toBeGreaterThan(0);
		expect(cells[0]!.left).toBe(0);
		expect(cells[0]!.width * 1000).toBeCloseTo(thumbW, 5);
		const last = cells[cells.length - 1]!;
		expect((last.left + last.width) * 1000).toBeGreaterThanOrEqual(400);
	});

	it('starts at the scrolled window, not 0', () => {
		const cells = filmstripLayout({
			duration: 10,
			trackWidth: 2000,
			viewLeft: 800,
			viewWidth: 400,
			thumbHeight: BAR_HEIGHT,
			aspect: 1,
			overscanPx: 0
		});
		expect(cells[0]!.left).toBeGreaterThan(0.3);
	});
});

describe('frameCacheKey', () => {
	it('quantizes time so nearby samples share a frame', () => {
		expect(frameCacheKey(1.0, 64, 44)).toBe(frameCacheKey(1.02, 64, 44));
		expect(frameCacheKey(1.0, 64, 44)).not.toBe(frameCacheKey(1.2, 64, 44));
	});
});

describe('slipRange / clamp', () => {
	it('slides a window without changing its length', () => {
		expect(slipRange(2, 5, 1, 10)).toEqual({ start: 3, end: 6 });
		expect(slipRange(2, 5, -10, 10)).toEqual({ start: 0, end: 3 });
		expect(slipRange(2, 5, 20, 10)).toEqual({ start: 7, end: 10 });
	});

	it('keeps a minimum span on each handle', () => {
		expect(clampTrimStart(9, 5, 10)).toBe(4.9);
		expect(clampTrimStart(-1, 5, 10)).toBe(0);
		expect(clampTrimEnd(0, 5, 10)).toBe(5.1);
		expect(clampTrimEnd(99, 5, 10)).toBe(10);
	});
});

describe('setTrimFromPlayhead', () => {
	it('sets end and pulls start back a second if the playhead is before start', () => {
		expect(setTrimFromPlayhead('end', 3, 5, 9, 20)).toEqual({ start: 2, end: 3 });
	});

	it('sets start and pushes end forward a second if the playhead is after end', () => {
		expect(setTrimFromPlayhead('start', 8, 1, 4, 20)).toEqual({ start: 8, end: 9 });
	});

	it('keeps the other edge when the playhead is inside the keep range', () => {
		expect(setTrimFromPlayhead('end', 6, 2, 9, 20)).toEqual({ start: 2, end: 6 });
		expect(setTrimFromPlayhead('start', 6, 2, 9, 20)).toEqual({ start: 6, end: 9 });
	});

	it('clamps a 1s gap to the clip bounds', () => {
		expect(setTrimFromPlayhead('end', 0.4, 5, 9, 20)).toEqual({ start: 0, end: 0.4 });
		expect(setTrimFromPlayhead('start', 19.7, 1, 4, 20)).toEqual({ start: 19.7, end: 20 });
	});

	it('treats the playhead as near a handle within a frame', () => {
		expect(playheadNear(1, 1.02)).toBe(true);
		expect(playheadNear(1, 1.2)).toBe(false);
	});
});
