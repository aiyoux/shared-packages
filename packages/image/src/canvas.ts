import type { RasterImage } from './types.js';

export function toImageData(image: RasterImage): ImageData {
	if (typeof ImageData !== 'undefined' && image.data instanceof ImageData) return image.data;
	const src = image.data.data ?? (image.data as unknown as Uint8ClampedArray);
	const data = src instanceof Uint8ClampedArray ? src : new Uint8ClampedArray(src);
	if (typeof ImageData !== 'undefined') return new ImageData(data, image.width, image.height);
	return { data, width: image.width, height: image.height } as ImageData;
}

export function rasterFromImageData(data: ImageData): RasterImage {
	return { width: data.width, height: data.height, data };
}

export function createDrawCanvas(width: number, height: number): {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Could not create an OffscreenCanvas 2D context');
		return { canvas, ctx };
	}
	if (typeof document === 'undefined') {
		throw new Error('Canvas is not available in this environment');
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Could not create a canvas 2D context');
	return { canvas, ctx };
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}
