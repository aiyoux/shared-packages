import { rasterFromImageData, toImageData } from '../canvas.js';
import {
	clampQuality,
	engineInfo,
	type EncodeOptions,
	type ImageEngine,
	type ImageFormat,
	type RasterImage,
	type ResizeOptions
} from '../types.js';
import { detectFormatFromBytes } from '../detect.js';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function decodeWith(
	format: ImageFormat,
	buffer: ArrayBuffer
): Promise<ImageData> {
	if (format === 'jpeg') {
		const { decode } = await import('@jsquash/jpeg');
		return decode(buffer);
	}
	if (format === 'png') {
		const { decode } = await import('@jsquash/png');
		return decode(buffer);
	}
	const { decode } = await import('@jsquash/webp');
	return decode(buffer);
}

async function encodeWith(
	format: ImageFormat,
	image: ImageData,
	quality: number
): Promise<ArrayBuffer> {
	if (format === 'jpeg') {
		const { encode } = await import('@jsquash/jpeg');
		return encode(image, { quality: Math.round(quality * 100) });
	}
	if (format === 'png') {
		const { encode } = await import('@jsquash/png');
		return encode(image);
	}
	const { encode } = await import('@jsquash/webp');
	return encode(image, { quality: Math.round(quality * 100) });
}

export const jsquashEngine: ImageEngine = {
	info: engineInfo('jsquash'),

	async load() {
		// Pull one codec so a missing WASM install fails at library-select time,
		// not mid-convert. Other formats stay lazy until encode/decode.
		await import('@jsquash/jpeg');
	},

	async decode(bytes, hint) {
		const detected = detectFormatFromBytes(bytes);
		const format =
			detected?.format ??
			(hint === 'jpeg' || hint === 'png' || hint === 'webp' ? hint : null);
		if (!format) {
			throw new Error('jSquash could not tell the image format — use JPEG, PNG, or WebP');
		}
		const image = await decodeWith(format, toArrayBuffer(bytes));
		return rasterFromImageData(image);
	},

	async encode(image: RasterImage, format: ImageFormat, options?: EncodeOptions) {
		const buffer = await encodeWith(format, toImageData(image), clampQuality(options?.quality));
		return new Uint8Array(buffer);
	},

	async resize(image: RasterImage, options: ResizeOptions) {
		const { default: resize } = await import('@jsquash/resize');
		const width = Math.max(1, Math.round(options.width));
		const height = Math.max(1, Math.round(options.height));
		const out = await resize(toImageData(image), { width, height });
		return rasterFromImageData(out);
	}
};
