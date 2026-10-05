import { describe, expect, it } from 'vitest';
import { clampScrubTarget, scrubDisplayTime, shouldDeferScrubSeek } from './scrubSeek.js';

describe('clampScrubTarget', () => {
	it('clamps into the clip', () => {
		expect(clampScrubTarget(-1, 10)).toBe(0);
		expect(clampScrubTarget(4, 10)).toBe(4);
		expect(clampScrubTarget(99, 10)).toBe(10);
	});

	it('seeks nowhere without a duration', () => {
		expect(clampScrubTarget(4, 0)).toBe(0);
		expect(clampScrubTarget(4, NaN)).toBe(0);
		expect(clampScrubTarget(NaN, 10)).toBe(0);
		expect(clampScrubTarget(Infinity, 10)).toBe(0);
	});
});

describe('shouldDeferScrubSeek', () => {
	it('issues when the element is idle with metadata', () => {
		expect(shouldDeferScrubSeek({ seeking: false, readyState: 4 }, false)).toBe(false);
	});

	it('defers intermediate positions while a seek is in flight', () => {
		// Replacing an unfinished seek on every pointer move freezes the frame;
		// the drag queues and the release flushes.
		expect(shouldDeferScrubSeek({ seeking: true, readyState: 4 }, false)).toBe(true);
		expect(shouldDeferScrubSeek({ seeking: true, readyState: 4 }, true)).toBe(false);
	});

	it('never seeks before metadata', () => {
		expect(shouldDeferScrubSeek({ seeking: false, readyState: 0 }, false)).toBe(true);
		expect(shouldDeferScrubSeek({ seeking: false, readyState: 0 }, true)).toBe(true);
	});
});

describe('scrubDisplayTime', () => {
	it('shows the drag position while scrubbing', () => {
		expect(scrubDisplayTime(true, 7, 3)).toBe(7);
	});

	it('shows the element time otherwise', () => {
		expect(scrubDisplayTime(false, 7, 3)).toBe(3);
		expect(scrubDisplayTime(true, null, 3)).toBe(3);
	});
});
