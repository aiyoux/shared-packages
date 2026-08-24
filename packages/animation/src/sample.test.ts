import { describe, expect, it } from 'vitest';
import { sampleClipFrame } from './sample.js';
import type { AnimClip } from './types.js';

const clip: AnimClip = {
	id: 'c',
	startMs: 1000,
	durationMs: 4000,
	frame: { x: 0, y: 0, w: 100, h: 50 },
	bind: 'clone',
	keyframes: [{ tMs: 2000, x: 200 }]
};

describe('sampleClipFrame', () => {
	it('returns the rest pose at clip start', () => {
		expect(sampleClipFrame(clip, 1000)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
	});

	it('lerps x at the midpoint', () => {
		const mid = sampleClipFrame(clip, 2000);
		expect(mid.x).toBe(100);
		expect(mid.y).toBe(0);
		expect(mid.w).toBe(100);
	});

	it('holds the last key after it', () => {
		expect(sampleClipFrame(clip, 4000).x).toBe(200);
	});

	it('lerps rotation when set', () => {
		const spun: AnimClip = {
			...clip,
			frame: { ...clip.frame, rotation: 0 },
			keyframes: [{ tMs: 2000, rotation: Math.PI }]
		};
		expect(sampleClipFrame(spun, 2000).rotation).toBeCloseTo(Math.PI / 2);
	});
});
