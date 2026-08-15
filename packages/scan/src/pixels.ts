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
	const bitmap = await createImageBitmap(blob);
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

export function videoFrameToImageData(video: HTMLVideoElement, maxEdge = 960): ImageData {
	const vw = video.videoWidth || 0;
	const vh = video.videoHeight || 0;
	if (!(vw > 0) || !(vh > 0)) throw new Error('Video has no dimensions yet.');
	const scale = Math.min(1, maxEdge / Math.max(vw, vh));
	const w = Math.max(2, Math.round(vw * scale));
	const h = Math.max(2, Math.round(vh * scale));
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Could not create a 2D canvas.');
	ctx.drawImage(video, 0, 0, w, h);
	return ctx.getImageData(0, 0, w, h);
}

export function scaleQuadFromDetect(
	quad: import('./types.js').Quad,
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number
): import('./types.js').Quad {
	const sx = dstW / srcW;
	const sy = dstH / srcH;
	return [
		{ x: quad[0].x * sx, y: quad[0].y * sy },
		{ x: quad[1].x * sx, y: quad[1].y * sy },
		{ x: quad[2].x * sx, y: quad[2].y * sy },
		{ x: quad[3].x * sx, y: quad[3].y * sy }
	];
}
