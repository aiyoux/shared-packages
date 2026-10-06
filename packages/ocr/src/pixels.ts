/** Minimal pixel plumbing for engine inputs. The richer copy lives in
 * `@shared-packages/scan` (which depends on this package, not the reverse),
 * so these two helpers are duplicated here by necessity. */

export async function imageDataToBlob(
	data: ImageData,
	type = 'image/jpeg',
	quality = 0.92
): Promise<Blob> {
	const canvas = document.createElement('canvas');
	canvas.width = data.width;
	canvas.height = data.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Could not create a 2D canvas for export.');
	ctx.putImageData(data, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
	if (!blob) throw new Error('Canvas export produced no blob.');
	return blob;
}

export async function blobToImageData(blob: Blob): Promise<ImageData> {
	const bitmap = await createImageBitmap(blob, {
		imageOrientation: 'from-image'
	} as ImageBitmapOptions);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Could not create a 2D canvas.');
		ctx.drawImage(bitmap, 0, 0);
		return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
	} finally {
		bitmap.close();
	}
}

/** Node test environments may not define the canvas globals, where the
 * identity check would throw a ReferenceError; a canvas is still recognised
 * structurally there. Browsers keep the strict check. */
function isCanvas(source: Blob | ImageData | HTMLCanvasElement): source is HTMLCanvasElement {
	if (typeof HTMLCanvasElement !== 'undefined') return source instanceof HTMLCanvasElement;
	return typeof (source as { getContext?: unknown }).getContext === 'function';
}

/** Any engine input as a canvas, so canvas-centric engines (paddle, CRNN)
 * accept blobs and raw pixels too. */
export async function inputToCanvas(source: Blob | ImageData | HTMLCanvasElement): Promise<HTMLCanvasElement> {
	if (isCanvas(source)) return source;
	const data = source instanceof Blob ? await blobToImageData(source) : source;
	const canvas = document.createElement('canvas');
	canvas.width = data.width;
	canvas.height = data.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Could not create a 2D canvas for recognition.');
	ctx.putImageData(data, 0, 0);
	return canvas;
}