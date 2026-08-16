import { describe, expect, it } from 'vitest';
import { applyEasing, sampleTrack } from './motion.js';
import type { MotionTrack } from './types.js';

describe('motion', () => {
	it('holds the first and last keyframe', () => {
		const track: MotionTrack = {
			id: 't',
			target: 'mark:m.progress',
			keyframes: [
				{ tMs: 100, value: 0.2 },
				{ tMs: 300, value: 0.8 }
			]
		};
		expect(sampleTrack(track, 0)).toBe(0.2);
		expect(sampleTrack(track, 100)).toBe(0.2);
		expect(sampleTrack(track, 300)).toBe(0.8);
		expect(sampleTrack(track, 8000)).toBe(0.8);
	});

	it('treats unknown easing as linear', () => {
		expect(applyEasing(0.5, 'not-a-curve')).toBe(0.5);
		expect(applyEasing(0.5, 'linear')).toBe(0.5);
		expect(applyEasing(0.5, 'easeOut')).toBeGreaterThan(0.5);
	});
});
