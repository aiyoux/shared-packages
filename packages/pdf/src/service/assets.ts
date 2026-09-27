import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';

/** The PDFium wasm the service fetches. Apps list this same URL for offline
 *  caching, so there is one copy to download and to cache. */
export const PDFIUM_WASM_URL: string = pdfiumWasmUrl;
