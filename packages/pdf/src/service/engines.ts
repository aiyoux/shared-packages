/**
 * The per-document jobs the PDF service runs, on whichever thread hosts it.
 *
 * Page images come from the engine the caller picked: PDFium (WASM, the
 * fastest: 2-3x pdf.js on a 128-page paper at card and thumbnail widths) or
 * pdf.js. Editable objects (`interpret`) are pdf.js's alone — PDFium has no
 * path to our IR — so a PDFium document opens a pdf.js handle for them on
 * first use. Nothing switches the image engine on its own: a file the chosen
 * engine refuses is an error for the caller to report.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { openPdf, pageCount, pageSizePt, destroy } from '../engine.js';
import { renderImage } from '../raster.js';
import { interpretPage } from '../interpret.js';
import type { PdfHandle, PdfInterpretResult, PdfPageSize } from '../types.js';

export type PdfEngineId = 'pdfium' | 'pdfjs';

export const PDF_ENGINE_LABEL: Record<PdfEngineId, string> = { pdfium: 'PDFium', pdfjs: 'pdf.js' };

/** Asset URLs resolved on the page, so a worker fetches the same files the
 *  app's offline list caches instead of a second emitted copy. */
export type EngineAssets = { pdfiumWasmUrl: string };

export type RenderFormat = { type?: 'image/jpeg' | 'image/png'; quality?: number };

export interface ServiceDoc {
	engine: PdfEngineId;
	sizes: PdfPageSize[];
	/** Page `index` as an encoded image `width` px wide. */
	render(index: number, width: number, format?: RenderFormat): Promise<Blob>;
	/** Page `index` as editable IR, fitted to the target (pdf.js). */
	interpret(index: number, target: { targetWidth: number; targetHeight: number }): Promise<PdfInterpretResult>;
	close(): void;
}

const PREVIEW: Required<RenderFormat> = { type: 'image/jpeg', quality: 0.9 };

/** FPDF_GetLastError codes, in words. */
const PDFIUM_ERRORS: Record<number, string> = {
	1: 'unknown error',
	2: 'the file could not be read',
	3: 'the file is not a valid PDF or is damaged',
	4: 'it is password protected',
	5: 'it uses an unsupported security scheme',
	6: 'a page could not be found'
};

let pdfiumReady: Promise<WrappedPdfiumModule> | null = null;

function loadPdfium(assets: EngineAssets): Promise<WrappedPdfiumModule> {
	pdfiumReady ??= (async () => {
		const { init } = await import('@embedpdf/pdfium');
		const res = await fetch(assets.pdfiumWasmUrl);
		if (!res.ok) throw new Error(`PDFium failed to load (${res.status}).`);
		const m = await init({ wasmBinary: await res.arrayBuffer() });
		m.PDFiumExt_Init();
		return m;
	})().catch((err) => {
		pdfiumReady = null;
		throw err;
	});
	return pdfiumReady;
}

let pdfjsWorkerReady: Promise<void> | null = null;

/**
 * pdf.js parses in-thread ("fake worker") once `globalThis.pdfjsWorker` is
 * set, instead of importing a worker URL the bundle may not serve. Imported
 * inside a Web Worker it also posts pdf.js's own "ready" frame; the service
 * pool drops it (no reqId) and pdf.js ignores service frames (no targetName).
 */
async function openPdfjsHandle(bytes: Uint8Array): Promise<PdfHandle> {
	pdfjsWorkerReady ??= import('pdfjs-dist/legacy/build/pdf.worker.mjs').then((mod) => {
		(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = mod;
	});
	await pdfjsWorkerReady;
	return openPdf(bytes);
}

function pdfjsHandleSizes(handle: PdfHandle): PdfPageSize[] {
	return Array.from({ length: pageCount(handle) }, (_, i) => pageSizePt(handle, i));
}

async function encode(canvas: OffscreenCanvas, format: RenderFormat): Promise<Blob> {
	const { type, quality } = { ...PREVIEW, ...format };
	return canvas.convertToBlob({ type, quality });
}

async function openPdfium(bytes: Uint8Array, assets: EngineAssets): Promise<ServiceDoc> {
	const m = await loadPdfium(assets);
	const rt = m.pdfium as typeof m.pdfium & { HEAPU8?: Uint8Array };
	// The heap view is replaced when WASM memory grows: never hold it.
	const heap = () =>
		rt.HEAPU8 ?? new Uint8Array((rt.wasmExports as unknown as { memory: WebAssembly.Memory }).memory.buffer);
	const ptr = rt.wasmExports.malloc(bytes.byteLength);
	heap().set(bytes, ptr);
	const doc = m.FPDF_LoadMemDocument(ptr, bytes.byteLength, '');
	if (!doc) {
		rt.wasmExports.free(ptr);
		const code = m.FPDF_GetLastError();
		throw new Error(PDFIUM_ERRORS[code] ?? `error ${code}`);
	}
	const count = m.FPDF_GetPageCount(doc);
	const sizePtr = rt.wasmExports.malloc(8);
	const sizes: PdfPageSize[] = [];
	for (let i = 0; i < count; i++) {
		m.FPDF_GetPageSizeByIndexF(doc, i, sizePtr);
		const [width, height] = new Float32Array(heap().buffer, sizePtr, 2);
		sizes.push({ width, height });
	}
	rt.wasmExports.free(sizePtr);
	let closed = false;
	let objects: Promise<PdfHandle> | null = null;

	return {
		engine: 'pdfium',
		sizes,
		async render(index, width, format = PREVIEW) {
			if (closed) throw new Error('PDF is closed.');
			const size = sizes[index];
			if (!size) throw new Error(`PDF page index ${index} is out of range.`);
			const w = Math.max(1, Math.round(width));
			const h = Math.max(1, Math.round((size.height * w) / size.width));
			const page = m.FPDF_LoadPage(doc, index);
			if (!page) throw new Error(`PDFium could not load page ${index + 1}.`);
			const bitmap = m.FPDFBitmap_Create(w, h, 1);
			try {
				m.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
				// FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER: annotations drawn, RGBA out.
				m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 0x01 | 0x10);
				const buf = m.FPDFBitmap_GetBuffer(bitmap);
				const stride = m.FPDFBitmap_GetStride(bitmap);
				const pixels = new Uint8ClampedArray(w * h * 4);
				const src = heap();
				for (let y = 0; y < h; y++) {
					pixels.set(src.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
				}
				const canvas = new OffscreenCanvas(w, h);
				canvas.getContext('2d')!.putImageData(new ImageData(pixels, w, h), 0, 0);
				return await encode(canvas, format);
			} finally {
				m.FPDFBitmap_Destroy(bitmap);
				m.FPDF_ClosePage(page);
			}
		},
		async interpret(index, target) {
			if (closed) throw new Error('PDF is closed.');
			objects ??= openPdfjsHandle(bytes);
			return interpretPage(await objects, index, target);
		},
		close() {
			if (closed) return;
			closed = true;
			m.FPDF_CloseDocument(doc);
			rt.wasmExports.free(ptr);
			void objects?.then(destroy, () => {});
		}
	};
}

async function openPdfjs(bytes: Uint8Array): Promise<ServiceDoc> {
	const handle = await openPdfjsHandle(bytes);
	let closed = false;
	return {
		engine: 'pdfjs',
		sizes: pdfjsHandleSizes(handle),
		async render(index, width, format = PREVIEW) {
			if (closed) throw new Error('PDF is closed.');
			const { blob } = await renderImage(handle, index, {
				scale: width / pageSizePt(handle, index).width,
				...PREVIEW,
				...format
			});
			return blob;
		},
		async interpret(index, target) {
			if (closed) throw new Error('PDF is closed.');
			return interpretPage(handle, index, target);
		},
		close() {
			if (closed) return;
			closed = true;
			destroy(handle);
		}
	};
}

export function openServiceDoc(
	engine: PdfEngineId,
	bytes: Uint8Array,
	assets: EngineAssets
): Promise<ServiceDoc> {
	return engine === 'pdfium' ? openPdfium(bytes, assets) : openPdfjs(bytes);
}
