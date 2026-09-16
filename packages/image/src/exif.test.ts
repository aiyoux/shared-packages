import { describe, expect, it } from 'vitest';
import { applyExifOrientation, jpegExifOrientation, type JpegOrientation } from './exif.js';
import { rasterFromImageData } from './canvas.js';

/** 2×1 raster: left red, right blue. */
function rb(): ReturnType<typeof rasterFromImageData> {
	const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
	return rasterFromImageData(
		typeof ImageData !== 'undefined'
			? new ImageData(data, 2, 1)
			: ({ data, width: 2, height: 1 } as ImageData)
	);
}

function pixel(image: ReturnType<typeof rb>, x: number, y: number): number[] {
	const i = (y * image.width + x) * 4;
	const d = image.data.data;
	return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

/** Tiny JPEG SOI + injected APP1 Exif Orientation. */
function jpegWithOrientation(orientation: JpegOrientation): Uint8Array {
	// Minimal 1×1 JPEG (SOF already present). APP1 is inserted after SOI.
	const jpeg = Uint8Array.from([
		0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07,
		0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f,
		0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c,
		0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d,
		0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01,
		0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01,
		0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
		0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f,
		0x3f, 0xff, 0xd9
	]);
	const tiff = Uint8Array.from([
		0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00
	]);
	const app1 = new Uint8Array(4 + tiff.length);
	app1[0] = 0xff;
	app1[1] = 0xe1;
	const size = tiff.length + 2;
	app1[2] = size >> 8;
	app1[3] = size & 0xff;
	app1.set(tiff, 4);
	const out = new Uint8Array(jpeg.length + app1.length);
	out.set(jpeg.subarray(0, 2), 0);
	out.set(app1, 2);
	out.set(jpeg.subarray(2), 2 + app1.length);
	return out;
}

describe('jpegExifOrientation', () => {
	it('reads orientation 6 from a phone-portrait APP1', () => {
		expect(jpegExifOrientation(jpegWithOrientation(6))).toBe(6);
		expect(jpegExifOrientation(jpegWithOrientation(1))).toBe(1);
		expect(jpegExifOrientation(jpegWithOrientation(8))).toBe(8);
	});

	it('returns null on a JPEG with no Exif', () => {
		expect(jpegExifOrientation(jpegWithOrientation(6).subarray(0, 2))).toBeNull();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		expect(jpegExifOrientation(png)).toBeNull();
	});
});

describe('applyExifOrientation', () => {
	it('orientation 6 rotates 90° CW so a 2×1 red|blue becomes 1×2 red-over-blue', () => {
		const out = applyExifOrientation(rb(), 6);
		expect(out.width).toBe(1);
		expect(out.height).toBe(2);
		expect(pixel(out, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixel(out, 0, 1)).toEqual([0, 0, 255, 255]);
	});

	it('orientation 1 is a no-op', () => {
		const src = rb();
		const out = applyExifOrientation(src, 1);
		expect(out.width).toBe(2);
		expect(out.height).toBe(1);
		expect(pixel(out, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pixel(out, 1, 0)).toEqual([0, 0, 255, 255]);
	});

	it('orientation 3 is 180°', () => {
		const out = applyExifOrientation(rb(), 3);
		expect(out.width).toBe(2);
		expect(out.height).toBe(1);
		expect(pixel(out, 0, 0)).toEqual([0, 0, 255, 255]);
		expect(pixel(out, 1, 0)).toEqual([255, 0, 0, 255]);
	});
});
