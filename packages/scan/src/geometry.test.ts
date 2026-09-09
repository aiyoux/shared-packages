import { describe, expect, it } from 'vitest';
import {
	containRect,
	displayToImage,
	dist,
	imageToDisplay,
	orderCorners,
	outputSize,
	quadArea,
	quadOrthogonality,
	quadsClose
} from './geometry.js';
import { QuadLock } from './lock.js';

describe('orderCorners', () => {
	it('sorts a shuffled rectangle', () => {
		const [tl, tr, br, bl] = orderCorners([
			{ x: 80, y: 10 },
			{ x: 10, y: 90 },
			{ x: 10, y: 10 },
			{ x: 80, y: 90 }
		]);
		expect(tl).toEqual({ x: 10, y: 10 });
		expect(tr).toEqual({ x: 80, y: 10 });
		expect(br).toEqual({ x: 80, y: 90 });
		expect(bl).toEqual({ x: 10, y: 90 });
	});
});

describe('quadArea / quadsClose / outputSize', () => {
	const q = orderCorners([
		{ x: 0, y: 0 },
		{ x: 100, y: 0 },
		{ x: 100, y: 50 },
		{ x: 0, y: 50 }
	]);

	it('computes area', () => {
		expect(quadArea(q)).toBe(5000);
	});

	it('treats nearby quads as stable', () => {
		const shifted = cloneShift(q, 1);
		expect(quadsClose(q, shifted, 2)).toBe(true);
		expect(quadsClose(q, cloneShift(q, 8), 2)).toBe(false);
	});

	it('picks even output dimensions from edge lengths', () => {
		const size = outputSize(q, 200);
		expect(size.width).toBe(100);
		expect(size.height).toBe(50);
	});
});

describe('containRect mapping', () => {
	it('round-trips a point through display space', () => {
		const box = containRect(200, 100, 400, 400);
		expect(box.scale).toBe(2);
		expect(box.x).toBe(0);
		expect(box.y).toBe(100);
		const img = { x: 50, y: 25 };
		const disp = imageToDisplay(img, box);
		expect(disp).toEqual({ x: 100, y: 150 });
		expect(displayToImage(disp, box, 200, 100)).toEqual(img);
	});
});

describe('QuadLock', () => {
	it('locks after enough close frames', () => {
		const lock = new QuadLock({ needed: 3, maxMoveRatio: 0.05 });
		const q = orderCorners([
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 10, y: 90 }
		]);
		expect(lock.observe(q, 100, 100).locked).toBe(false);
		expect(lock.observe(cloneShift(q, 1), 100, 100).progress).toBeCloseTo(2 / 3);
		expect(lock.observe(cloneShift(q, 1), 100, 100).locked).toBe(true);
	});

	it('holds the previous overlay when the quad jumps, then switches after agreement', () => {
		const lock = new QuadLock({ needed: 3, maxMoveRatio: 0.02, maxMisses: 0, switchNeeded: 3 });
		const q = orderCorners([
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 10, y: 90 }
		]);
		lock.observe(q, 100, 100);
		expect(lock.observe(null, 100, 100).progress).toBe(0);
		lock.observe(q, 100, 100);
		const jumped = orderCorners([
			{ x: 0, y: 0 },
			{ x: 40, y: 0 },
			{ x: 40, y: 40 },
			{ x: 0, y: 40 }
		]);
		const held = lock.observe(jumped, 100, 100);
		expect(held.quad).toEqual(q);
		expect(held.progress).toBe(0);
		lock.observe(jumped, 100, 100);
		const switched = lock.observe(jumped, 100, 100);
		expect(switched.quad?.[0]?.x).toBeCloseTo(0, 5);
		expect(switched.progress).toBeCloseTo(1, 5);
	});

	it('scores a rectangle as more orthogonal than a diamond', () => {
		const rect = orderCorners([
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 10, y: 90 }
		]);
		const spike = orderCorners([
			{ x: 50, y: 0 },
			{ x: 60, y: 50 },
			{ x: 50, y: 100 },
			{ x: 40, y: 50 }
		]);
		expect(quadOrthogonality(rect)).toBeGreaterThan(0.95);
		expect(quadOrthogonality(spike)).toBeLessThan(0.25);
	});

	it('keeps the lock through a brief miss', () => {
		const lock = new QuadLock({ needed: 3, maxMisses: 2 });
		const q = orderCorners([
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 10, y: 90 }
		]);
		lock.observe(q, 100, 100);
		lock.observe(q, 100, 100);
		const miss = lock.observe(null, 100, 100);
		expect(miss.progress).toBeCloseTo(2 / 3);
		expect(miss.quad).toEqual(q);
		expect(lock.observe(null, 100, 100).progress).toBeCloseTo(2 / 3);
		expect(lock.observe(null, 100, 100).progress).toBe(0);
	});
});

function cloneShift(
	q: ReturnType<typeof orderCorners>,
	px: number
): ReturnType<typeof orderCorners> {
	return [
		{ x: q[0].x + px, y: q[0].y },
		{ x: q[1].x + px, y: q[1].y },
		{ x: q[2].x + px, y: q[2].y },
		{ x: q[3].x + px, y: q[3].y }
	];
}

describe('dist', () => {
	it('is hypot', () => {
		expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});
});
