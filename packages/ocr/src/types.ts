/** Shared OCR value types. Engines live in `src/engines/`; the id/selection
 * catalog lives in `src/registry.ts`. */

/** Language packs the local engines can serve. `eng` is the historical
 * default; `jpn` reads Japanese. */
export type OcrLang = 'eng' | 'jpn';

/** Pixel bounding box in source-image coordinates. */
export type OcrBox = { x0: number; y0: number; x1: number; y1: number };

/** One recognized line of text with its location in the image. Regions are
 * optional per engine: detection-free engines (OnnxTR CRNN, AI vision) return
 * a single region or none. */
export type OcrRegion = { text: string; box: OcrBox; score?: number };

export type OcrResult = {
	/** Whole-image text (newlines join the lines). */
	text: string;
	/** Per-line regions, reading order, or `[]` when the engine can't locate text. */
	regions: OcrRegion[];
};

/** Historical name from the Tesseract-only API (`recognizeDetailed`). */
export type OcrDetailedResult = OcrResult;

/** What an engine reads: a blob (File), raw pixels, or an on-page canvas. */
export type OcrInput = Blob | ImageData | HTMLCanvasElement;

export type OcrRunOptions = {
	/** Language pack; engines without it (AI vision) ignore the option. */
	lang?: OcrLang;
};

/** One runnable recognizer. Construction is cheap; weights load lazily on
 * the first `recognize` (see `preloadOcrEngine` to warm earlier). */
export interface OcrEngine {
	id: string;
	recognize(input: OcrInput, options?: OcrRunOptions): Promise<OcrResult>;
}