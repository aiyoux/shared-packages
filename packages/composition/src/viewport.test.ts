import { describe, expect, it } from 'vitest';
import {
	MAX_ZOOM,
	MIN_ZOOM,
	clampScrollX,
	clampZoom,
	createTimelineViewport,
	followPlayhead,
	pickTickStepMs,
	rulerTicks,
	viewportWindowFraction,
	zoomAtAnchor
} from './viewport.js';

const base = { durationMs: 10_000, viewportPx: 500, zoom: 1, scrollX: 0 };

describe('createTimelineViewport', () => {
	it('at zoom 1 lays the whole duration out in exactly one viewport width', () => {
		const vp = createTimelineViewport(base);
		expect(vp.pxPerMs).toBe(0.05);
		expect(vp.contentPx).toBe(500);
		expect(vp.maxScrollX).toBe(0);
		expect(vp.timeToPx(10_000)).toBe(500);
		expect(vp.pxToTime(250)).toBe(5000);
	});

	it('scales content width and scroll range with zoom', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4 });
		expect(vp.contentPx).toBe(2000);
		expect(vp.maxScrollX).toBe(1500);
		expect(vp.visibleStartMs).toBe(0);
		expect(vp.visibleEndMs).toBe(2500);
	});

	it('clamps scrollX into range and reflects it in the visible window', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 99_999 });
		expect(vp.scrollX).toBe(1500);
		expect(vp.visibleEndMs).toBe(10_000);
		expect(vp.visibleStartMs).toBe(7500);
	});

	it('clamps zoom to the supported band', () => {
		expect(createTimelineViewport({ ...base, zoom: 0.1 }).zoom).toBe(MIN_ZOOM);
		expect(createTimelineViewport({ ...base, zoom: 9999 }).zoom).toBe(MAX_ZOOM);
		expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
	});

	it('degrades gracefully with a zero duration', () => {
		const vp = createTimelineViewport({ ...base, durationMs: 0 });
		expect(vp.pxPerMs).toBe(0);
		expect(vp.contentPx).toBe(0);
		expect(vp.maxScrollX).toBe(0);
		expect(vp.pxToTime(100)).toBe(0);
	});
});

describe('zoomAtAnchor', () => {
	it('keeps the instant under the anchor pixel pinned there', () => {
		const vp = createTimelineViewport({ ...base, zoom: 2, scrollX: 400 });
		const anchorPx = 150;
		const timeUnder = vp.pxToTime(vp.scrollX + anchorPx);
		const next = zoomAtAnchor(vp, 5, anchorPx);
		const after = createTimelineViewport({ ...base, ...next });
		expect(after.pxToTime(after.scrollX + anchorPx)).toBeCloseTo(timeUnder, 6);
	});

	it('clamps the resulting scroll when the anchor is near an edge', () => {
		const vp = createTimelineViewport({ ...base, zoom: 2, scrollX: 0 });
		const next = zoomAtAnchor(vp, 8, 0);
		expect(next.scrollX).toBe(0);
		expect(next.zoom).toBe(8);
	});

	it('zooming back to fit returns scroll to zero', () => {
		const vp = createTimelineViewport({ ...base, zoom: 8, scrollX: 3000 });
		const next = zoomAtAnchor(vp, 1, 250);
		expect(next.zoom).toBe(1);
		expect(next.scrollX).toBe(0);
	});
});

describe('followPlayhead', () => {
	it('does nothing when the playhead is already comfortably in view', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 400 });
		// scrollX 400 → visible 400..900px → 8000..18000ms window clipped to content.
		const head = vp.pxToTime(600);
		expect(followPlayhead(vp, head)).toBe(400);
	});

	it('scrolls left to reveal a playhead that fell off the left edge', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 800 });
		const headMs = vp.pxToTime(700); // 100px left of the window
		const next = followPlayhead(vp, headMs, 24);
		expect(next).toBeLessThan(800);
		const after = createTimelineViewport({ ...base, zoom: 4, scrollX: next });
		expect(headMs * after.pxPerMs - after.scrollX).toBeCloseTo(24, 6);
	});

	it('scrolls right to chase a playhead past the right edge', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 0 });
		const headMs = vp.pxToTime(560); // 60px past the 500px window
		const next = followPlayhead(vp, headMs, 24);
		const after = createTimelineViewport({ ...base, zoom: 4, scrollX: next });
		expect(headMs * after.pxPerMs - after.scrollX).toBeCloseTo(500 - 24, 6);
	});

	it('never returns a scroll outside the valid range', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 1500 });
		const next = followPlayhead(vp, 10_000, 24);
		expect(next).toBeLessThanOrEqual(vp.maxScrollX);
		expect(next).toBeGreaterThanOrEqual(0);
	});

	it('is a no-op when the content fits the window', () => {
		const vp = createTimelineViewport(base);
		expect(followPlayhead(vp, 9000)).toBe(0);
	});
});

describe('clampScrollX', () => {
	it('bounds to [0, maxScrollX]', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4 });
		expect(clampScrollX(vp, -50)).toBe(0);
		expect(clampScrollX(vp, 5000)).toBe(1500);
		expect(clampScrollX(vp, 700)).toBe(700);
	});
});

describe('ruler ticks', () => {
	it('picks a coarser step as the scale shrinks', () => {
		expect(pickTickStepMs(0.05)).toBeGreaterThan(pickTickStepMs(0.5));
		expect(pickTickStepMs(0)).toBe(3_600_000);
	});

	it('keeps label spacing at or above the minimum gap', () => {
		const step = pickTickStepMs(0.05, 68);
		expect(step * 0.05).toBeGreaterThanOrEqual(68);
	});

	it('emits ascending ticks that span the visible window', () => {
		const vp = createTimelineViewport({ ...base, zoom: 6, scrollX: 900 });
		const ticks = rulerTicks(vp);
		expect(ticks.length).toBeGreaterThan(1);
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i].ms).toBeGreaterThan(ticks[i - 1].ms);
			expect(ticks[i].x).toBeCloseTo(ticks[i].ms * vp.pxPerMs, 6);
		}
		expect(ticks[0].ms).toBeLessThanOrEqual(vp.visibleStartMs);
		expect(ticks[ticks.length - 1].ms).toBeGreaterThanOrEqual(
			Math.min(vp.durationMs, vp.visibleEndMs)
		);
	});

	it('returns nothing for an empty timeline', () => {
		expect(rulerTicks(createTimelineViewport({ ...base, durationMs: 0 }))).toEqual([]);
	});
});

describe('viewportWindowFraction', () => {
	it('is the whole bar at fit', () => {
		expect(viewportWindowFraction(createTimelineViewport(base))).toEqual({ left: 0, width: 1 });
	});

	it('narrows and slides as zoom and scroll increase', () => {
		const vp = createTimelineViewport({ ...base, zoom: 4, scrollX: 750 });
		const { left, width } = viewportWindowFraction(vp);
		expect(width).toBeCloseTo(0.25, 6);
		expect(left).toBeCloseTo(0.375, 6);
		expect(left + width).toBeLessThanOrEqual(1);
	});
});
