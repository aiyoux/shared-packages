import { describe, expect, it } from 'vitest';
import { copyPixelBuffer, scaleQuadFromDetect } from './pixels.js';

describe('copyPixelBuffer', () => {
	it('copies a typed array into a standalone buffer', () => {
		const src = new Uint8ClampedArray([9, 8, 7, 6]);
		const buffer = copyPixelBuffer(src);
		expect(buffer).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8ClampedArray(buffer)).toEqual(src);
		src[0] = 0;
		expect(new Uint8ClampedArray(buffer)[0]).toBe(9);
	});

	it('copies an array-like object', () => {
		const buffer = copyPixelBuffer({ 0: 1, 1: 2, 2: 3, 3: 4, length: 4 });
		expect([...new Uint8ClampedArray(buffer)]).toEqual([1, 2, 3, 4]);
	});
});

describe('scaleQuadFromDetect', () => {
	it('maps a downscaled detect quad back to the source frame', () => {
		const quad = scaleQuadFromDetect(
			[
				{ x: 10, y: 20 },
				{ x: 110, y: 20 },
				{ x: 110, y: 220 },
				{ x: 10, y: 220 }
			],
			200,
			400,
			800,
			1600
		);
		expect(quad).toEqual([
			{ x: 40, y: 80 },
			{ x: 440, y: 80 },
			{ x: 440, y: 880 },
			{ x: 40, y: 880 }
		]);
	});
});
