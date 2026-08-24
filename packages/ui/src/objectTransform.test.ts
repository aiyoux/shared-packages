import { describe, expect, it } from 'vitest';
import { applyFrameResize, MIN_SIZE, type FrameRect } from './objectTransform.ts';

const BASE: FrameRect = { x: 40, y: 50, width: 100, height: 80 };

describe('applyFrameResize', () => {
	it('grows east/south by dx/dy', () => {
		expect(applyFrameResize(BASE, 'e', 20, 99)).toEqual({ ...BASE, width: 120 });
		expect(applyFrameResize(BASE, 's', 99, 15)).toEqual({ ...BASE, height: 95 });
		expect(applyFrameResize(BASE, 'se', 20, 15)).toEqual({
			...BASE,
			width: 120,
			height: 95
		});
	});

	it('clamps east/south shrinks to minSize without moving origin', () => {
		expect(applyFrameResize(BASE, 'e', -500, 0)).toEqual({ ...BASE, width: MIN_SIZE });
		expect(applyFrameResize(BASE, 's', 0, -500)).toEqual({ ...BASE, height: MIN_SIZE });
		expect(applyFrameResize(BASE, 'se', -500, -500)).toEqual({
			...BASE,
			width: MIN_SIZE,
			height: MIN_SIZE
		});
	});

	it('moves west/north origin while shrinking, clamped to minSize', () => {
		expect(applyFrameResize(BASE, 'w', 20, 0)).toEqual({
			x: 60,
			y: 50,
			width: 80,
			height: 80
		});
		expect(applyFrameResize(BASE, 'n', 0, 20)).toEqual({
			x: 40,
			y: 70,
			width: 100,
			height: 60
		});

		const westClamp = applyFrameResize(BASE, 'w', 500, 0);
		expect(westClamp).toEqual({
			x: BASE.x + (BASE.width - MIN_SIZE),
			y: 50,
			width: MIN_SIZE,
			height: 80
		});

		const northClamp = applyFrameResize(BASE, 'n', 0, 500);
		expect(northClamp).toEqual({
			x: 40,
			y: BASE.y + (BASE.height - MIN_SIZE),
			width: 100,
			height: MIN_SIZE
		});
	});

	it('grows west/north by negative dx/dy', () => {
		expect(applyFrameResize(BASE, 'w', -25, 0)).toEqual({
			x: 15,
			y: 50,
			width: 125,
			height: 80
		});
		expect(applyFrameResize(BASE, 'n', 0, -10)).toEqual({
			x: 40,
			y: 40,
			width: 100,
			height: 90
		});
	});

	it('honors an explicit minSize', () => {
		expect(applyFrameResize(BASE, 'e', -500, 0, 10).width).toBe(10);
		expect(applyFrameResize(BASE, 'w', 500, 0, 10)).toEqual({
			x: BASE.x + (BASE.width - 10),
			y: 50,
			width: 10,
			height: 80
		});
	});
});
