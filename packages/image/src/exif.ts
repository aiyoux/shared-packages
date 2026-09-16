import { rasterFromImageData, toImageData } from './canvas.js';
import type { RasterImage } from './types.js';

/** EXIF Orientation tag values 1–8. 1 is identity. */
export type JpegOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Read JPEG APP1 Exif Orientation. Returns null when the file is not a JPEG
 * or the tag is absent. Phone portraits are typically 6 (90° CW).
 */
export function jpegExifOrientation(bytes: Uint8Array): JpegOrientation | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let i = 2;
	while (i + 4 <= bytes.length) {
		if (bytes[i] !== 0xff) break;
		const marker = bytes[i + 1]!;
		if (marker === 0xda || marker === 0xd9) break;
		if (marker === 0x00 || marker === 0xff) {
			i += 1;
			continue;
		}
		const size = (bytes[i + 2]! << 8) | bytes[i + 3]!;
		if (size < 2 || i + 2 + size > bytes.length) break;
		if (marker === 0xe1) {
			const ori = parseExifOrientation(bytes.subarray(i + 4, i + 2 + size));
			if (ori != null) return ori;
		}
		i += 2 + size;
	}
	return null;
}

function parseExifOrientation(app1: Uint8Array): JpegOrientation | null {
	if (app1.length < 14) return null;
	const ascii = String.fromCharCode(app1[0]!, app1[1]!, app1[2]!, app1[3]!);
	if (ascii !== 'Exif') return null;
	const tiff = app1.subarray(6);
	if (tiff.length < 8) return null;
	const le = tiff[0] === 0x49 && tiff[1] === 0x49;
	const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
	if (!le && !be) return null;
	const u16 = (at: number) =>
		le ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!;
	const u32 = (at: number) =>
		le
			? tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)
			: (tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!;
	if (u16(2) !== 42) return null;
	let ifd = u32(4);
	if (ifd + 2 > tiff.length) return null;
	const count = u16(ifd);
	ifd += 2;
	for (let n = 0; n < count; n++) {
		const entry = ifd + n * 12;
		if (entry + 12 > tiff.length) break;
		if (u16(entry) !== 0x0112) continue;
		const type = u16(entry + 2);
		const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
		if (value >= 1 && value <= 8) return value as JpegOrientation;
	}
	return null;
}

/**
 * Bake an EXIF orientation into pixels. Identity (1 / null) is a no-op.
 * jSquash (and some createImageBitmap defaults) ignore tags 5–8, which is
 * how a phone-portrait JPEG arrives sideways on the canvas/detect path.
 */
export function applyExifOrientation(
	image: RasterImage,
	orientation: JpegOrientation | null
): RasterImage {
	if (orientation == null || orientation === 1) return image;
	const src = toImageData(image);
	const w = src.width;
	const h = src.height;
	const s = src.data;
	const swap = orientation >= 5;
	const dw = swap ? h : w;
	const dh = swap ? w : h;
	const out = new Uint8ClampedArray(dw * dh * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			let dx = x;
			let dy = y;
			switch (orientation) {
				case 2:
					dx = w - 1 - x;
					dy = y;
					break;
				case 3:
					dx = w - 1 - x;
					dy = h - 1 - y;
					break;
				case 4:
					dx = x;
					dy = h - 1 - y;
					break;
				case 5:
					dx = y;
					dy = x;
					break;
				case 6:
					dx = h - 1 - y;
					dy = x;
					break;
				case 7:
					dx = h - 1 - y;
					dy = w - 1 - x;
					break;
				case 8:
					dx = y;
					dy = w - 1 - x;
					break;
				default:
					break;
			}
			const o = (dy * dw + dx) * 4;
			out[o] = s[i]!;
			out[o + 1] = s[i + 1]!;
			out[o + 2] = s[i + 2]!;
			out[o + 3] = s[i + 3]!;
		}
	}
	if (typeof ImageData !== 'undefined') {
		return rasterFromImageData(new ImageData(out, dw, dh));
	}
	return rasterFromImageData({ data: out, width: dw, height: dh } as ImageData);
}

/** Bitmap option that honours EXIF. Typed loosely — older DOM libs omit it. */
export const FROM_IMAGE_ORIENTATION = { imageOrientation: 'from-image' } as ImageBitmapOptions;
