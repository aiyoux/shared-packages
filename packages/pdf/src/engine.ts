import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfHandle, PdfPageSize } from './types.js';
import { FsStandardFontDataFactory, StubCanvasFactory } from './canvasStub.js';
import { isWorkerScope, NoopFilterFactory, OffscreenCanvasFactory } from './workerCanvas.js';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

type HandleState = {
	doc: PDFDocumentProxy;
	/**
	 * pdfjs 6 moved `destroy()` off PDFDocumentProxy onto the loading task, so
	 * the task has to outlive `openPdf` — dropping it leaks the worker/transport.
	 */
	task: { destroy(): Promise<void> };
	/** Every page's size, or, for a ranged document, the pages read so far. */
	sizes: (PdfPageSize | undefined)[];
	destroyed: boolean;
};

let pdfjsPromise: Promise<PdfjsModule> | null = null;
let nextId = 1;
const handles = new Map<number, HandleState>();

function copyBytes(bytes: Uint8Array): Uint8Array {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

function isNode(): boolean {
	return typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
}

function workerUnavailable(): boolean {
	return typeof Worker === 'undefined' || isNode();
}

async function loadPdfjs(): Promise<PdfjsModule> {
	if (!pdfjsPromise) {
		pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
			.then((mod) => {
				if (!mod.GlobalWorkerOptions.workerSrc && typeof document !== 'undefined') {
					try {
						mod.GlobalWorkerOptions.workerSrc = new URL(
							'../../../pdfjs-dist/legacy/build/pdf.worker.mjs',
							import.meta.url
						).toString();
					} catch {
						// Fallback in environments where URL resolution isn't supported
					}
				}
				return mod;
			})
			.catch((err) => {
				pdfjsPromise = null;
				throw err;
			});
	}
	return pdfjsPromise;
}

function assertHandle(handle: PdfHandle): HandleState {
	const state = handles.get(handle.id);
	if (!state || state.destroyed) throw new Error('PDF handle has been destroyed.');
	return state;
}

export async function openPdf(bytes: Uint8Array): Promise<PdfHandle> {
	if (!bytes || bytes.byteLength === 0) {
		throw new Error('PDF buffer is empty.');
	}
	const header = String.fromCharCode(...bytes.subarray(0, 5));
	if (header !== '%PDF-') {
		throw new Error('File does not appear to be a valid PDF (missing %PDF header).');
	}

	const pdfjs = await loadPdfjs();
	const data = copyBytes(bytes);
	const loadingTask = pdfjs.getDocument({
		data,
		...(await documentOptions())
	} as Parameters<typeof pdfjs.getDocument>[0]);
	const doc = await loadingTask.promise;
	const sizes: PdfPageSize[] = await Promise.all(
		Array.from({ length: doc.numPages }, async (_, i) => sizeOf(await doc.getPage(i + 1)))
	);
	const id = nextId++;
	handles.set(id, { doc, task: loadingTask, sizes, destroyed: false });
	return { id };
}

function sizeOf(page: PDFPageProxy): PdfPageSize {
	const [x0, y0, x1, y1] = page.view;
	return { width: x1 - x0, height: y1 - y0 };
}

/**
 * Where a ranged document's bytes come from: its length, and a reader for
 * `begin..end` (end exclusive, as pdf.js asks).
 */
export type PdfRangeSource = {
	length: number;
	read(begin: number, end: number): Promise<Uint8Array>;
	/** The file's first bytes, when the caller already has them. */
	initial?: Uint8Array;
};

/**
 * Open a PDF without its whole file: pdf.js asks `source.read` for the ranges
 * it needs (the header, the cross-reference table at the end, then the objects
 * of each page it draws). pdf.js also checks the last page on open, which
 * reads every page's dictionary, so the cost is about one 64 KiB chunk per
 * page: a small part of a large PDF (scans, images), most of a small one.
 * Page sizes are read lazily: `loadPageSize` before `pageSizePt`.
 */
export async function openPdfRanged(source: PdfRangeSource): Promise<PdfHandle> {
	if (!(source.length > 0)) throw new Error('PDF is empty.');
	const pdfjs = await loadPdfjs();
	const lib = pdfjs as unknown as {
		PDFDataRangeTransport: new (length: number, initialData: Uint8Array | null) => {
			requestDataRange(begin: number, end: number): void;
			onDataRange(begin: number, chunk: Uint8Array): void;
			abort(): void;
		};
	};
	const transport = new lib.PDFDataRangeTransport(source.length, source.initial ?? null);
	transport.requestDataRange = (begin: number, end: number) => {
		void source.read(begin, end).then(
			(chunk) => transport.onDataRange(begin, chunk),
			() => transport.abort()
		);
	};
	const loadingTask = pdfjs.getDocument({
		range: transport,
		length: source.length,
		// Only what a page asks for: no background fetch of the rest.
		disableAutoFetch: true,
		disableStream: true,
		rangeChunkSize: 64 * 1024,
		...(await documentOptions())
	} as unknown as Parameters<typeof pdfjs.getDocument>[0]);
	const doc = await loadingTask.promise;
	const sizes: (PdfPageSize | undefined)[] = new Array(doc.numPages);
	if (doc.numPages > 0) sizes[0] = sizeOf(await doc.getPage(1));
	const id = nextId++;
	handles.set(id, { doc, task: loadingTask, sizes, destroyed: false });
	return { id };
}

/** A page's size, reading the page first when a ranged document has not yet. */
export async function loadPageSize(handle: PdfHandle, index: number): Promise<PdfPageSize> {
	const state = assertHandle(handle);
	if (index < 0 || index >= state.doc.numPages) {
		throw new Error(`PDF page index ${index} is out of range.`);
	}
	const known = state.sizes[index];
	if (known) return known;
	const size = sizeOf(await state.doc.getPage(index + 1));
	state.sizes[index] = size;
	return size;
}

/** Options every open shares; only the data source differs. */
async function documentOptions(): Promise<Record<string, unknown>> {
	// No document means Node (stubbed canvas, fs fonts) or a Web Worker
	// (OffscreenCanvas; fonts fetch like the main thread).
	const inWorker = isWorkerScope();
	const needsStubCanvas = typeof document === 'undefined' && !inWorker;
	let standardFontDataUrl: string | undefined;
	try {
		if (typeof document === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
			const [{ fileURLToPath }, path] = await Promise.all([
				import(/* @vite-ignore */ 'node:url'),
				import(/* @vite-ignore */ 'node:path')
			]);
			const pkg = fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'));
			standardFontDataUrl = path.join(path.dirname(pkg), 'standard_fonts') + path.sep;
		} else {
			// In the browser there is no resolver to ask; the bundler has
			// already rewritten module URLs, so relative is all we have.
			standardFontDataUrl = new URL('../../../pdfjs-dist/standard_fonts/', import.meta.url)
				.href;
		}
		if (standardFontDataUrl && !standardFontDataUrl.endsWith('/')) {
			standardFontDataUrl += '/';
		}
	} catch {
		standardFontDataUrl = undefined;
	}
	return {
		// Main-thread parse is slower but avoids Vite failing to serve the
		// pdf.worker.mjs URL from a file: linked package.
		disableWorker: true,
		isEvalSupported: false,
		useSystemFonts: false,
		disableFontFace: true,
		fontExtraProperties: true,
		// pdf.js 6 turns page images into ImageBitmap when this is true. The
		// interpreter reads `{ width, height, kind, data }` pixel buffers, so a
		// bitmap-only object dropped every image and imported pages came out
		// blank. Rasterization still uses a real canvas via page.render().
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
		canvasFactory: needsStubCanvas ? new StubCanvasFactory() : undefined,
		...(inWorker ? { CanvasFactory: OffscreenCanvasFactory, FilterFactory: NoopFilterFactory } : {}),
		standardFontDataUrl,
		StandardFontDataFactory:
			needsStubCanvas && standardFontDataUrl ? FsStandardFontDataFactory : undefined,
		verbosity: 0
	};
}

export function pageCount(handle: PdfHandle): number {
	return assertHandle(handle).doc.numPages;
}

export function pageSizePt(handle: PdfHandle, index: number): PdfPageSize {
	const state = assertHandle(handle);
	const size = state.sizes[index];
	if (!size) {
		throw new Error(
			index >= 0 && index < state.doc.numPages
				? `PDF page ${index + 1} has not been read yet (loadPageSize first).`
				: `PDF page index ${index} is out of range.`
		);
	}
	return size;
}

export function destroy(handle: PdfHandle): void {
	const state = handles.get(handle.id);
	if (!state || state.destroyed) return;
	state.destroyed = true;
	handles.delete(handle.id);
	try {
		void state.task.destroy();
	} catch {
		// ignore
	}
}

export async function getPage(handle: PdfHandle, index: number): Promise<PDFPageProxy> {
	const state = assertHandle(handle);
	if (index < 0 || index >= state.doc.numPages) {
		throw new Error(`PDF page index ${index} is out of range.`);
	}
	return state.doc.getPage(index + 1);
}

export async function loadPdfjsLib(): Promise<PdfjsModule> {
	return loadPdfjs();
}

export function resetPdfEngineForTests(): void {
	for (const state of handles.values()) {
		state.destroyed = true;
		try {
			void state.task.destroy();
		} catch {
			// ignore
		}
	}
	handles.clear();
	pdfjsPromise = null;
}
