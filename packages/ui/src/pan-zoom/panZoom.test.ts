import { describe, expect, it } from 'vitest';
import {
	canvasView,
	clampScale,
	fitScale,
	pointerDistance,
	wheelZoomFactor,
	widthScale
} from './panZoom.ts';

describe('panZoom', () => {
	it('fits the shorter axis', () => {
		expect(fitScale(200, 100, 400, 100)).toBeCloseTo(0.5);
		expect(fitScale(200, 100, 100, 400)).toBeCloseTo(0.25);
	});

	it('width mode fills the stage width', () => {
		expect(widthScale(300, 100)).toBe(3);
	});

	it('centers content and adds pan', () => {
		const view = canvasView({
			mode: 'manual',
			manualScale: 2,
			pan: { x: 10, y: -4 },
			stageW: 200,
			stageH: 200,
			contentW: 50,
			contentH: 50
		});
		expect(view.scale).toBe(2);
		expect(view.offsetX).toBe(10 + (200 - 100) / 2);
		expect(view.offsetY).toBe(-4 + (200 - 100) / 2);
	});

	it('clamps junk scales', () => {
		expect(clampScale(0)).toBe(0.05);
		expect(clampScale(99)).toBe(8);
		expect(clampScale(Number.NaN)).toBe(1);
	});

	it('wheel zoom grows as the wheel rolls up', () => {
		expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100)).toBeLessThan(1);
	});

	it('measures pinch distance', () => {
		expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});
});
