import { describe, expect, it } from 'vitest';
import { applyH, destToSrcHomography, homography, warpImageData } from './warp.js';
import { orderCorners } from './geometry.js';

describe('homography', () => {
	it('maps dest corners back to a translated rectangle', () => {
		const src = orderCorners([
			{ x: 10, y: 20 },
			{ x: 110, y: 20 },
			{ x: 110, y: 220 },
			{ x: 10, y: 220 }
		]);
		const H = destToSrcHomography(src, 100, 200);
		const tl = applyH(H, 0, 0);
		const br = applyH(H, 100, 200);
		expect(tl.x).toBeCloseTo(10, 5);
		expect(tl.y).toBeCloseTo(20, 5);
		expect(br.x).toBeCloseTo(110, 5);
		expect(br.y).toBeCloseTo(220, 5);
	});

	it('is invertible for an identity map', () => {
		const q = orderCorners([
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 50, y: 40 },
			{ x: 0, y: 40 }
		]);
		const H = homography(q, q);
		const p = applyH(H, 12, 7);
		expect(p.x).toBeCloseTo(12, 5);
		expect(p.y).toBeCloseTo(7, 5);
	});
});

describe('warpImageData', () => {
	it.skipIf(typeof ImageData === 'undefined')('extracts a solid-color inset without needing OpenCV', () => {
		const width = 20;
		const height = 20;
		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				const inside = x >= 4 && x < 16 && y >= 4 && y < 16;
				data[i] = inside ? 200 : 10;
				data[i + 1] = inside ? 30 : 10;
				data[i + 2] = inside ? 30 : 10;
				data[i + 3] = 255;
			}
		}
		const image = new ImageData(data, width, height);
		const out = warpImageData(
			image,
			orderCorners([
				{ x: 4, y: 4 },
				{ x: 16, y: 4 },
				{ x: 16, y: 16 },
				{ x: 4, y: 16 }
			]),
			32
		);
		expect(out.width).toBeGreaterThan(4);
		expect(out.height).toBeGreaterThan(4);
		const mid = ((out.height >> 1) * out.width + (out.width >> 1)) * 4;
		expect(out.data[mid]).toBeGreaterThan(150);
		expect(out.data[mid + 1]).toBeLessThan(80);
	});
});
