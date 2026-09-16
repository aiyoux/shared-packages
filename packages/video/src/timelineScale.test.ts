import { describe, expect, it } from 'vitest';
import {
	BAR_HEIGHT,
	MAX_ZOOM,
	MIN_ZOOM,
	clampTrimEnd,
	clampTrimStart,
	filmstripLayout,
	filmstripThumbWidth,
	frameCacheKey,
	pickTickInterval,
	pxPerSecond,
	slipRange,
	timelineTicks,
	zoomToRange
} from './timelineScale.js';

describe('pxPerSecond', () => {
	it('is track width over duration', () => {
		expect(pxPerSecond(10, 500)).toBe(50);
		expect(pxPerSecond(0, 500)).toBe(0);
	});
});

describe('pickTickInterval', () => {
	it('picks a coarser step when a second is only a few pixels', () => {
		expect(pickTickInterval(2)).toBe(30);
		expect(pickTickInterval(1.2)).toBe(60);
	});

	it('picks sub-second steps once a second is wide enough', () => {
		expect(pickTickInterval(200)).toBe(0.5);
		expect(pickTickInterval(500)).toBe(0.1);
	});
});

describe('timelineTicks', () => {
	it('emits 0 and majors with labels, minors without', () => {
		const ticks = timelineTicks(10, 80);
		expect(ticks[0]).toMatchObject({ t: 0, major: true, label: '0:00', align: 'start' });
		const majors = ticks.filter((t) => t.major);
		expect(majors.length).toBeGreaterThan(1);
		expect(majors.every((t) => t.label)).toBe(true);
		const minors = ticks.filter((t) => !t.major);
		expect(minors.length).toBeGreaterThan(0);
		expect(minors.every((t) => t.label === null)).toBe(true);
	});

	it('uses centiseconds on sub-second majors', () => {
		const ticks = timelineTicks(1.5, 400);
		const labeled = ticks.filter((t) => t.label);
		expect(labeled.some((t) => t.label?.includes('.'))).toBe(true);
	});
});

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

describe('zoomToRange', () => {
	it('zooms so the keep range fills most of the view', () => {
		const { zoom, startFrac } = zoomToRange({ duration: 10, start: 2, end: 4 });
		expect(zoom).toBeGreaterThan(MIN_ZOOM);
		expect(zoom).toBeLessThanOrEqual(MAX_ZOOM);
		expect(startFrac).toBeGreaterThan(0);
		expect(startFrac).toBeLessThan(0.2);
	});

	it('stays at 1x when the keep range is the whole clip', () => {
		const { zoom, startFrac } = zoomToRange({ duration: 10, start: 0, end: 10 });
		expect(zoom).toBe(MIN_ZOOM);
		expect(startFrac).toBe(0);
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
