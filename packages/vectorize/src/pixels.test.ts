import { describe, expect, it } from 'vitest';
import { isOffsetOutOfBounds, packImageData } from './pixels.js';

function view(width: number, height: number, fill: number, byteOffset = 0): ImageData {
	const need = width * height * 4;
	const buf = new ArrayBuffer(byteOffset + need + 24);
	const data = new Uint8ClampedArray(buf, byteOffset, need);
	data.fill(fill);
	return { data, width, height } as ImageData;
}

describe('packImageData', () => {
	it('copies an offset wasm-style view onto a packed buffer', () => {
		const src = view(2, 2, 7, 16);
		src.data[0] = 11;
		src.data[1] = 22;
		src.data[2] = 33;
		src.data[3] = 44;
		const packed = packImageData(src);
		expect(packed.width).toBe(2);
		expect(packed.height).toBe(2);
		expect(packed.data.byteOffset).toBe(0);
		expect(packed.data.length).toBe(16);
		expect(packed.data.buffer.byteLength).toBe(16);
		expect([...packed.data.slice(0, 4)]).toEqual([11, 22, 33, 44]);
		expect(packed.data[4]).toBe(7);
	});

	it('downscales when the bitmap exceeds maxPixels', () => {
		const src = view(40, 30, 200);
		const packed = packImageData(src, 100);
		expect(packed.width * packed.height).toBeLessThanOrEqual(100);
		expect(packed.width).toBeGreaterThanOrEqual(1);
		expect(packed.height).toBeGreaterThanOrEqual(1);
		expect(packed.data.length).toBe(packed.width * packed.height * 4);
	});

	it('pads a short buffer instead of throwing', () => {
		const data = new Uint8ClampedArray([1, 2, 3, 4]);
		const packed = packImageData({ data, width: 2, height: 2 } as ImageData);
		expect(packed.data.length).toBe(16);
		expect(packed.data[0]).toBe(1);
		expect(packed.data[7]).toBe(255);
	});
});

describe('isOffsetOutOfBounds', () => {
	it('matches the potrace HEAP8.set RangeError', () => {
		expect(isOffsetOutOfBounds(new RangeError('offset is out of bounds'))).toBe(true);
		expect(isOffsetOutOfBounds(new Error('nope'))).toBe(false);
	});
});
