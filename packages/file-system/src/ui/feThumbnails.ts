/**
 * Thumbnail generation utilities for FileExplorer.
 *
 * Supports images (canvas resize), videos (frame capture via <video>),
 * and PDFs (first page render via dynamically-imported mupdf).
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

// ── PDF thumbnail (mupdf, dynamic import) ────────────────────────

let mupdfPromise: Promise<Record<string, (...args: never[]) => unknown>> | null = null;

/** Module name as a variable so bundlers can't statically resolve it. */
const MUPDF_MODULE = 'mupdf';

export async function getMupdf(): Promise<Record<string, (...args: never[]) => unknown>> {
	if (!mupdfPromise) {
		mupdfPromise = (async () => {
			if (typeof window !== 'undefined') {
				const g = globalThis as Record<string, unknown>;
				if (!g.process) g.process = { env: {} };
				if (!g.process.versions) g.process.versions = {};
				try {
					Object.defineProperty(g.process.versions, 'node', {
						get() {
							return undefined;
						},
						configurable: true
					});
				} catch {
					g.process.versions.node = undefined;
				}
			}
			// @vite-ignore — variable import prevents static resolution
			return (await import(/* @vite-ignore */ MUPDF_MODULE)) as Record<
				string,
				(...args: never[]) => unknown
			>;
		})();
		mupdfPromise.catch(() => {
			mupdfPromise = null;
		});
	}
	return mupdfPromise;
}

export async function generatePdfThumbnail(blob: Blob, maxDim: number): Promise<string> {
	const mupdf = await getMupdf();
	const uint8 = new Uint8Array(await blob.arrayBuffer());
	const Buffer = mupdf.Buffer as new (data?: unknown) => { write: (d: Uint8Array) => void };
	const buf = new Buffer();
	buf.write(uint8);
	const doc = (
		mupdf.Document as new (buf: unknown, type: string) => {
			countPages: () => number;
			loadPage: (i: number) => {
				getBounds: () => [number, number, number, number];
				toPixmap: (mat: unknown, cs: unknown, alpha: boolean, show: boolean) => {
					width: number;
					height: number;
					pixels: Uint8Array;
				};
			};
		}
	).openDocument(buf, 'application/pdf');
	if (doc.countPages() === 0) throw new Error('PDF has no pages');
	const page = doc.loadPage(0);
	const [pw, ph] = page.getBounds().slice(2) as [number, number];
	const scale = Math.min(1, maxDim / Math.max(pw, ph));
	const Matrix = mupdf.Matrix as unknown as { scale: (x: number, y: number) => unknown };
	const ColorSpace = mupdf.ColorSpace as unknown as { DeviceRGB: unknown };
	const pixmap = page.toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB, false, true);
	const canvas = document.createElement('canvas');
	canvas.width = pixmap.width;
	canvas.height = pixmap.height;
	const ctx = canvas.getContext('2d')!;
	const imageData = ctx.createImageData(pixmap.width, pixmap.height);
	imageData.data.set(pixmap.pixels);
	ctx.putImageData(imageData, 0, 0);
	return canvas.toDataURL('image/webp', 0.82);
}

/** Render a specific PDF page to a canvas at higher resolution. */
export async function renderPdfPageToCanvas(
	canvas: HTMLCanvasElement,
	blob: Blob,
	pageIdx: number,
	maxWidth: number
): Promise<number> {
	const mupdf = await getMupdf();
	const uint8 = new Uint8Array(await blob.arrayBuffer());
	const Buffer = mupdf.Buffer as new (data?: unknown) => { write: (d: Uint8Array) => void };
	const buf = new Buffer();
	buf.write(uint8);
	const doc = (
		mupdf.Document as new (buf: unknown, type: string) => {
			countPages: () => number;
			loadPage: (i: number) => {
				getBounds: () => [number, number, number, number];
				toPixmap: (mat: unknown, cs: unknown, alpha: boolean, show: boolean) => {
					width: number;
					height: number;
					pixels: Uint8Array;
				};
			};
		}
	).openDocument(buf, 'application/pdf');
	const page = doc.loadPage(pageIdx);
	const bounds = page.getBounds();
	const pw = bounds[2] - bounds[0];
	const ph = bounds[3] - bounds[1];
	const scale = Math.min(2, maxWidth / pw);
	const Matrix = mupdf.Matrix as unknown as { scale: (x: number, y: number) => unknown };
	const ColorSpace = mupdf.ColorSpace as unknown as { DeviceRGB: unknown };
	const pixmap = page.toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB, false, true);
	canvas.width = pixmap.width;
	canvas.height = pixmap.height;
	const ctx = canvas.getContext('2d')!;
	const imageData = ctx.createImageData(pixmap.width, pixmap.height);
	imageData.data.set(pixmap.pixels);
	ctx.putImageData(imageData, 0, 0);
	return doc.countPages();
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
