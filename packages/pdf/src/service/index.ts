/**
 * `@shared-packages/pdf/service`: the one PDF pipeline apps use — a worker
 * pool that opens a document once and runs page jobs (images, editable
 * objects). Kept off the package root so importing the engine (Node tests,
 * the writer) never pulls in workers or the PDFium wasm URL.
 */
export {
	createPdfService,
	interpretPages,
	newPdfDocId,
	pdfWorkersAvailable,
	type PdfService
} from './client.js';
export { PDFIUM_WASM_URL } from './assets.js';
export { PDF_ENGINE_LABEL, type PdfEngineId, type RenderFormat } from './engines.js';
