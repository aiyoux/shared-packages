/**
 * Thumbnail generation utilities for FileExplorer.
 *
 * Supports images (canvas resize), videos (frame capture via <video>),
 * and PDFs (first page render via dynamically-imported `@shared-packages/pdf`).
 *
 * All functions are browser-only and return blob: URLs that the caller
 * must revoke via `URL.revokeObjectURL`.
 */
import type { ExplorerEntry } from './explorerDriver.js';

export type PreviewKind = 'image' | 'video' | 'pdf';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp', '.ico'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv'];
const PDF_EXTS = ['.pdf'];

function ext(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function getPreviewKind(entry: ExplorerEntry): PreviewKind | null {
	if (entry.kind !== 'file') return null;
	if (entry.fileType === 'image') return 'image';
	if (entry.fileType === 'video') return 'video';
	const e = ext(entry.name);
	if (IMAGE_EXTS.includes(e)) return 'image';
	if (VIDEO_EXTS.includes(e)) return 'video';
	if (PDF_EXTS.includes(e)) return 'pdf';
	// Also check contentType for robustness
	const ct = entry.contentType ?? '';
	if (ct.startsWith('image/')) return 'image';
	if (ct.startsWith('video/')) return 'video';
	if (ct === 'application/pdf') return 'pdf';
	return null;
}

/** Icon name for a preview kind (used as fallback when no thumbnail). */
export function previewKindIcon(kind: PreviewKind): 'image' | 'film' | 'file-text' {
	if (kind === 'image') return 'image';
	if (kind === 'video') return 'film';
	return 'file-text';
}

// ── Image thumbnail ──────────────────────────────────────────────

export async function generateImageThumbnail(blob: Blob, maxDim: number): Promise<string> {
	const url = URL.createObjectURL(blob);
	try {
		const img = await loadImage(url);
		const { canvas } = drawScaled(img.width, img.height, maxDim);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/webp', 0.82);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Image load failed'));
		img.src = src;
	});
}

function drawScaled(w: number, h: number, maxDim: number): { canvas: HTMLCanvasElement } {
	const scale = Math.min(1, maxDim / Math.max(w, h));
	const cw = Math.max(1, Math.round(w * scale));
	const ch = Math.max(1, Math.round(h * scale));
	const canvas = document.createElement('canvas');
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage = ctx.drawImage.bind(ctx) as typeof ctx.drawImage;
	return { canvas };
}

// ── Video thumbnail ──────────────────────────────────────────────

export async function generateVideoThumbnail(blob: Blob, maxDim: number): Promise<string> {
	const url = URL.createObjectURL(blob);
	try {
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.preload = 'metadata';
		video.src = url;

		await new Promise<void>((resolve, reject) => {
			video.onloadedmetadata = () => resolve();
			video.onerror = () => reject(new Error('Video metadata load failed'));
		});

		// Seek to ~10% or 1s, whichever is smaller
		const target = Math.min(1, video.duration * 0.1);
		await new Promise<void>((resolve, reject) => {
			video.onseeked = () => resolve();
			video.onerror = () => reject(new Error('Video seek failed'));
			video.currentTime = target;
		});

		const { canvas } = drawScaled(video.videoWidth, video.videoHeight, maxDim);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/webp', 0.82);
	} finally {
		URL.revokeObjectURL(url);
	}
}

// ── PDF thumbnail (@shared-packages/pdf, dynamic import) ─────────

type PdfEngine = typeof import('@shared-packages/pdf');

let pdfPromise: Promise<PdfEngine> | null = null;

async function loadPdfEngine(): Promise<PdfEngine> {
	if (!pdfPromise) {
		pdfPromise = import('@shared-packages/pdf').catch((err) => {
			pdfPromise = null;
			throw err;
		});
	}
	return pdfPromise;
}

export function resetPdfEngineForTests(): void {
	const pending = pdfPromise;
	pdfPromise = null;
	if (pending) {
		void pending.then((m) => m.resetPdfEngineForTests()).catch(() => {});
	}
}

async function drawPngToCanvas(canvas: HTMLCanvasElement, png: Uint8Array): Promise<void> {
	const copy = new Uint8Array(png.byteLength);
	copy.set(png);
	const blob = new Blob([copy], { type: 'image/png' });
	const url = URL.createObjectURL(blob);
	try {
		const img = await loadImage(url);
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('2d context unavailable');
		ctx.drawImage(img, 0, 0);
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function pngToWebpDataUrl(png: Uint8Array): Promise<string> {
	const canvas = document.createElement('canvas');
	await drawPngToCanvas(canvas, png);
	return canvas.toDataURL('image/webp', 0.82);
}

export async function generatePdfThumbnail(blob: Blob, maxDim: number): Promise<string> {
	const pdf = await loadPdfEngine();
	const uint8 = new Uint8Array(await blob.arrayBuffer());
	const handle = await pdf.openPdf(uint8);
	try {
		if (pdf.pageCount(handle) === 0) throw new Error('PDF has no pages');
		const { width: pw, height: ph } = pdf.pageSizePt(handle, 0);
		const scale = Math.min(1, maxDim / Math.max(pw, ph));
		const { png } = await pdf.renderRaster(handle, 0, { scale });
		return await pngToWebpDataUrl(png);
	} finally {
		pdf.destroy(handle);
	}
}

/** Render a specific PDF page to a canvas at higher resolution. */
export async function renderPdfPageToCanvas(
	canvas: HTMLCanvasElement,
	blob: Blob,
	pageIdx: number,
	maxWidth: number
): Promise<number> {
	const pdf = await loadPdfEngine();
	const uint8 = new Uint8Array(await blob.arrayBuffer());
	const handle = await pdf.openPdf(uint8);
	try {
		const { width: pw } = pdf.pageSizePt(handle, pageIdx);
		const scale = Math.min(2, maxWidth / pw);
		const { png } = await pdf.renderRaster(handle, pageIdx, { scale });
		await drawPngToCanvas(canvas, png);
		return pdf.pageCount(handle);
	} finally {
		pdf.destroy(handle);
	}
}

// ── Dispatcher ───────────────────────────────────────────────────

export async function generateThumbnail(
	blob: Blob,
	kind: PreviewKind,
	maxDim: number
): Promise<string> {
	switch (kind) {
		case 'image':
			return generateImageThumbnail(blob, maxDim);
		case 'video':
			return generateVideoThumbnail(blob, maxDim);
		case 'pdf':
			return generatePdfThumbnail(blob, maxDim);
	}
}
