import { describe, expect, it } from 'vitest';
import {
	BAR_HEIGHT,
	clampTrimEnd,
	clampTrimStart,
	filmstripLayout,
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
