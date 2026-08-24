import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfHandle, PdfPageSize } from './types.js';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

type HandleState = {
	doc: PDFDocumentProxy;
	sizes: PdfPageSize[];
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
				if (!mod.GlobalWorkerOptions.workerSrc) {
					try {
						mod.GlobalWorkerOptions.workerSrc = new URL(
							'pdfjs-dist/legacy/build/pdf.worker.mjs',
							import.meta.url
						).toString();
					} catch {
						// Node / vitest fall through to disableWorker on getDocument.
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
		// Main-thread parse is slower but avoids Vite failing to serve the
		// pdf.worker.mjs URL from a file: linked package.
		disableWorker: true,
		isEvalSupported: false,
		useSystemFonts: false,
		disableFontFace: isNode(),
		isOffscreenCanvasSupported: typeof OffscreenCanvas !== 'undefined',
		verbosity: 0
	} as Parameters<typeof pdfjs.getDocument>[0]);
	const doc = await loadingTask.promise;
	const sizes: PdfPageSize[] = await Promise.all(
		Array.from({ length: doc.numPages }, async (_, i) => {
			const page = await doc.getPage(i + 1);
			const [x0, y0, x1, y1] = page.view;
			return { width: x1 - x0, height: y1 - y0 };
		})
	);
	const id = nextId++;
	handles.set(id, { doc, sizes, destroyed: false });
	return { id };
}

export function pageCount(handle: PdfHandle): number {
	return assertHandle(handle).doc.numPages;
}

export function pageSizePt(handle: PdfHandle, index: number): PdfPageSize {
	const state = assertHandle(handle);
	const size = state.sizes[index];
	if (!size) throw new Error(`PDF page index ${index} is out of range.`);
	return size;
}

export function destroy(handle: PdfHandle): void {
	const state = handles.get(handle.id);
	if (!state || state.destroyed) return;
	state.destroyed = true;
	handles.delete(handle.id);
	try {
		void state.doc.destroy();
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
			void state.doc.destroy();
		} catch {
			// ignore
		}
	}
	handles.clear();
	pdfjsPromise = null;
}
