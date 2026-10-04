import { describe, expect, it } from 'vitest';
import { RANGED, fileDuration, fileTime, nextRate, planSeek } from './ui/mediaClock.js';

describe('media clock', () => {
	it('a ranged file seeks anywhere natively', () => {
		expect(planSeek(RANGED, 300, [])).toEqual({ kind: 'native', elementTime: 300 });
		expect(planSeek(RANGED, -5, [])).toEqual({ kind: 'native', elementTime: 0 });
	});

	it('a converted stream seeks within what arrived, and restarts beyond it', () => {
		const tl = { start: 60, duration: 600, restartable: true };
		expect(fileTime(tl, 15)).toBe(75);
		expect(planSeek(tl, 70, [[0, 30]])).toEqual({ kind: 'native', elementTime: 10 });
		expect(planSeek(tl, 400.7, [[0, 30]])).toEqual({ kind: 'restart', at: 400 });
		// Before the stream's start: it has to restart earlier.
		expect(planSeek(tl, 30, [[0, 30]])).toEqual({ kind: 'restart', at: 30 });
		// Never past the end.
		expect(planSeek(tl, 9999, [], 600)).toEqual({ kind: 'restart', at: 600 });
	});

	it('takes the length from the timeline when the element cannot know it', () => {
		expect(fileDuration({ start: 60, duration: 600, restartable: true }, Infinity)).toBe(600);
		expect(fileDuration(RANGED, 125)).toBe(125);
		expect(fileDuration(RANGED, NaN)).toBeUndefined();
	});

	it('steps through playback speeds', () => {
		expect(nextRate(1)).toBe(1.25);
		expect(nextRate(0.75)).toBe(1);
		expect(nextRate(3)).toBe(1);
	});
});
