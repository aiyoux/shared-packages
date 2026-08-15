import { blobToBytes, createDrawCanvas, rasterFromImageData, toImageData } from '../canvas.js';
import {
	FORMAT_MIME,
	clampQuality,
	engineInfo,
	type EncodeOptions,
	type ImageEngine,
	type ImageFormat,
	type RasterImage,
	type ResizeOptions
} from '../types.js';

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function decodeViaBitmap(bytes: Uint8Array): Promise<RasterImage> {
	if (typeof createImageBitmap !== 'function') {
		throw new Error('createImageBitmap is not available');
	}
	const blob = new Blob([bytesToArrayBuffer(bytes)]);
	const bitmap = await createImageBitmap(blob);
	try {
		const { canvas, ctx } = createDrawCanvas(bitmap.width, bitmap.height);
		ctx.drawImage(bitmap, 0, 0);
		const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		void canvas;
		return rasterFromImageData(data);
	} finally {
		bitmap.close?.();
	}
}

async function canvasToBytes(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	format: ImageFormat,
	quality: number
): Promise<Uint8Array> {
	const type = FORMAT_MIME[format];
	const q = format === 'png' ? undefined : quality;
	if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
		const blob = await canvas.convertToBlob({ type, quality: q });
		return blobToBytes(blob);
	}
	const el = canvas as HTMLCanvasElement;
	if (typeof el.toBlob !== 'function') {
		throw new Error('Canvas encoding is not available');
	}
	const blob = await new Promise<Blob>((resolve, reject) => {
		el.toBlob((out) => {
			if (!out) reject(new Error(`Native encoder rejected ${type}`));
			else resolve(out);
		}, type, q);
	});
	return blobToBytes(blob);
}

export const nativeEngine: ImageEngine = {
	info: engineInfo('native'),

	async load() {
		if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
			throw new Error('Native image engine needs a canvas');
		}
	},

	async decode(bytes) {
		return decodeViaBitmap(bytes);
	},

	async encode(image, format, options?: EncodeOptions) {
		const data = toImageData(image);
		const { canvas, ctx } = createDrawCanvas(image.width, image.height);
		ctx.putImageData(data, 0, 0);
		return canvasToBytes(canvas, format, clampQuality(options?.quality));
	},

	async resize(image, options: ResizeOptions) {
		const width = Math.max(1, Math.round(options.width));
		const height = Math.max(1, Math.round(options.height));
		const src = toImageData(image);
		const { canvas: srcCanvas, ctx: srcCtx } = createDrawCanvas(image.width, image.height);
		srcCtx.putImageData(src, 0, 0);
		const { canvas, ctx } = createDrawCanvas(width, height);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(srcCanvas as CanvasImageSource, 0, 0, width, height);
		return rasterFromImageData(ctx.getImageData(0, 0, width, height));
	}
};
