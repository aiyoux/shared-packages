import type { PdfHandle, PdfRasterResult } from './types.js';
import { getPage } from './engine.js';

type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createCanvas(width: number, height: number): { canvas: Canvas2D; ctx: Ctx2D } {
	const w = Math.max(1, Math.round(width));
	const h = Math.max(1, Math.round(height));
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas.');
		return { canvas, ctx };
	}
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Failed to get 2d context from canvas.');
		return { canvas, ctx };
	}
	throw new Error(
		'PDF rasterization requires a canvas (OffscreenCanvas or document.createElement("canvas")). Node tests should skip renderRaster when canvas is unavailable.'
	);
}

async function canvasToPng(canvas: Canvas2D): Promise<Uint8Array> {
	if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
		const blob = await canvas.convertToBlob({ type: 'image/png' });
		return new Uint8Array(await blob.arrayBuffer());
	}
	const html = canvas as HTMLCanvasElement;
	if (typeof html.toDataURL !== 'function') {
		throw new Error('PDF rasterization could not encode PNG from canvas.');
	}
	const dataUrl = html.toDataURL('image/png');
	const b64 = dataUrl.split(',')[1] ?? '';
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function renderRaster(
	handle: PdfHandle,
	index: number,
	opts?: { scale?: number }
): Promise<PdfRasterResult> {
	const scale = opts?.scale ?? 1;
	const page = await getPage(handle, index);
	const viewport = page.getViewport({ scale });
	const { canvas, ctx } = createCanvas(viewport.width, viewport.height);
	const task = page.render({
		canvasContext: ctx as CanvasRenderingContext2D,
		viewport,
		canvas
	} as Parameters<typeof page.render>[0]);
	await task.promise;
	const png = await canvasToPng(canvas);
	return { width: Math.round(viewport.width), height: Math.round(viewport.height), png };
}
