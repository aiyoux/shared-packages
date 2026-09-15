import { describe, expect, it } from 'vitest';
import {
	FINE_TUNE_ZOOM,
	fineTuneTransform,
	fineTuneZoom,
	loupeImageOffset,
	overlayToStage,
	placeLoupe,
	stageToOverlay
} from './cornerTune.ts';

describe('fine-tune mapping', () => {
	it('is identity when zoom is 1', () => {
		const p = { x: 40, y: 80 };
		expect(stageToOverlay(p, { x: 10, y: 10 }, { w: 200, h: 200 }, 1)).toEqual(p);
		expect(overlayToStage(p, { x: 10, y: 10 }, { w: 200, h: 200 }, 1)).toEqual(p);
		expect(fineTuneTransform({ x: 10, y: 10 }, { w: 200, h: 200 }, 1)).toBe('none');
	});

	it('round-trips a point through the zoomed stage', () => {
		const focus = { x: 50, y: 40 };
		const stage = { w: 200, h: 100 };
		const overlay = { x: 80, y: 55 };
		const onStage = overlayToStage(overlay, focus, stage, FINE_TUNE_ZOOM);
		expect(stageToOverlay(onStage, focus, stage, FINE_TUNE_ZOOM).x).toBeCloseTo(overlay.x);
		expect(stageToOverlay(onStage, focus, stage, FINE_TUNE_ZOOM).y).toBeCloseTo(overlay.y);
	});

	it('shrinks pointer travel by the zoom factor', () => {
		const focus = { x: 100, y: 100 };
		const stage = { w: 200, h: 200 };
		const a = stageToOverlay({ x: 100, y: 100 }, focus, stage, 4);
		const b = stageToOverlay({ x: 108, y: 100 }, focus, stage, 4);
		expect(b.x - a.x).toBeCloseTo(2);
	});

	it('turns Fine tune on at the published zoom', () => {
		expect(fineTuneZoom(false)).toBe(1);
		expect(fineTuneZoom(true)).toBe(FINE_TUNE_ZOOM);
	});
});

describe('loupe', () => {
	it('centers the source pixel in the loupe', () => {
		const s = loupeImageOffset({ x: 10, y: 5 }, 100, 50, 100, 50);
		expect(s.scale).toBe(2);
		expect(s.width).toBe(200);
		expect(s.height).toBe(100);
		expect(s.left).toBe(50 - 20);
		expect(s.top).toBe(50 - 10);
	});

	it('flips below the handle when there is no room above', () => {
		const pos = placeLoupe({ x: 80, y: 10 }, { w: 200, h: 200 }, 80, 16);
		expect(pos.y).toBeGreaterThan(10);
	});
});
