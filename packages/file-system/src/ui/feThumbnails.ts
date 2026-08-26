/**
 * Thumbnail generation utilities for FileExplorer.
 *
 * Supports images (canvas resize), videos (frame capture via <video>),
 * audio (player in the floating preview), and PDFs (first page render via
 * dynamically-imported `@shared-packages/pdf`).
 *
 * All functions are browser-only and return blob: URLs that the caller
 * must revoke via `URL.revokeObjectURL`.
 */
import type { ExplorerEntry } from './explorerDriver.js';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp', '.ico'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv'];
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba', '.aiff', '.aif'];
const PDF_EXTS = ['.pdf'];
const AUDIO_MIME: Record<string, string> = {
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.oga': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.opus': 'audio/ogg',
	'.weba': 'audio/webm',
	'.aiff': 'audio/aiff',
	'.aif': 'audio/aiff'
};
const IMAGE_MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon'
};
const LOAD_TIMEOUT_MS = 8_000;

function ext(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function getPreviewKind(entry: ExplorerEntry): PreviewKind | null {
	if (entry.kind !== 'file') return null;
	if (entry.fileType === 'image') return 'image';
	if (entry.fileType === 'video') return 'video';
	if (entry.fileType === 'audio') return 'audio';
	if (entry.fileType === 'pdf') return 'pdf';
	const e = ext(entry.name);
	if (IMAGE_EXTS.includes(e)) return 'image';
	if (VIDEO_EXTS.includes(e)) return 'video';
	if (AUDIO_EXTS.includes(e)) return 'audio';
	if (PDF_EXTS.includes(e)) return 'pdf';
	// Also check contentType for robustness
	const ct = entry.contentType ?? '';
	if (ct.startsWith('image/')) return 'image';
	if (ct.startsWith('video/')) return 'video';
	if (ct.startsWith('audio/')) return 'audio';
	if (ct === 'application/pdf') return 'pdf';
	return null;
}

/** Icon name for a preview kind (used as fallback when no thumbnail). */
export function previewKindIcon(kind: PreviewKind): 'image' | 'film' | 'music' | 'file-text' {
	if (kind === 'image') return 'image';
	if (kind === 'video') return 'film';
	if (kind === 'audio') return 'music';
	return 'file-text';
}

/** Give the blob a usable MIME so <img>/<iframe>/Image() will actually load it. */
export function coerceMediaBlob(blob: Blob, name: string, kind: PreviewKind): Blob {
	const e = ext(name);
	if (kind === 'pdf' && blob.type !== 'application/pdf') {
		return new Blob([blob], { type: 'application/pdf' });
	}
	if (kind === 'image') {
		const want = e === '.svg' || blob.type === 'image/svg+xml' ? 'image/svg+xml' : IMAGE_MIME[e];
		if (want && blob.type !== want) return new Blob([blob], { type: want });
	}
	if (kind === 'video' && (!blob.type || blob.type === 'application/octet-stream')) {
		const want =
			e === '.webm' ? 'video/webm' : e === '.ogv' ? 'video/ogg' : e === '.mov' ? 'video/quicktime' : 'video/mp4';
		return new Blob([blob], { type: want });
	}
	if (kind === 'audio') {
		const want = AUDIO_MIME[e];
		if (want && blob.type !== want) return new Blob([blob], { type: want });
	}
	return blob;
}

export function isSvgName(name: string): boolean {
	return ext(name) === '.svg';
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(message)), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			}
		);
	});
}

// ── Image thumbnail ──────────────────────────────────────────────

export async function generateImageThumbnail(
	blob: Blob,
	maxDim: number,
	name = ''
): Promise<string> {
	const typed = coerceMediaBlob(blob, name, 'image');
	// Rasterizing SVG onto canvas is flaky (0×0 intrinsic size, missing MIME,
	// external refs). The thumbnail <img> can display the SVG blob directly.
	if (typed.type === 'image/svg+xml' || isSvgName(name)) {
		return URL.createObjectURL(typed);
	}
	const url = URL.createObjectURL(typed);
	try {
		const img = await loadImage(url);
		const w = img.naturalWidth || img.width;
		const h = img.naturalHeight || img.height;
		if (!w || !h) throw new Error('Image has no dimensions');
		const { canvas } = drawScaled(w, h, maxDim);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas 2D unavailable');
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/webp', 0.82);
	} finally {
		URL.revokeObjectURL(url);
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return withTimeout(
		new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('Image load failed'));
			img.src = src;
		}),
		LOAD_TIMEOUT_MS,
		'Image load timed out'
	);
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

		await withTimeout(
			new Promise<void>((resolve, reject) => {
				video.onloadedmetadata = () => resolve();
				video.onerror = () => reject(new Error('Video metadata load failed'));
			}),
			LOAD_TIMEOUT_MS,
			'Video metadata load timed out'
		);

		// Seek to ~10% or 1s, whichever is smaller
		const target = Math.min(1, (Number.isFinite(video.duration) ? video.duration : 1) * 0.1);
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				video.onseeked = () => resolve();
				video.onerror = () => reject(new Error('Video seek failed'));
				video.currentTime = target;
			}),
			LOAD_TIMEOUT_MS,
			'Video seek timed out'
		);

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
	maxDim: number,
	name = ''
): Promise<string> {
	switch (kind) {
		case 'image':
			return generateImageThumbnail(blob, maxDim, name);
		case 'video':
			return generateVideoThumbnail(coerceMediaBlob(blob, name, 'video'), maxDim);
		case 'pdf':
			return generatePdfThumbnail(coerceMediaBlob(blob, name, 'pdf'), maxDim);
		case 'audio':
			throw new Error('Audio has no raster thumbnail');
	}
}
