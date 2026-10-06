import { recognizeDetailed } from '../tesseract.js';
import type { OcrEngine, OcrInput, OcrResult } from '../types.js';

/** The vendored Tesseract.js engine — the default, fully offline. */
export function createTesseractEngine(): OcrEngine {
	return {
		id: 'tesseract',
		recognize(input: OcrInput, options: { lang?: 'eng' | 'jpn' } = {}): Promise<OcrResult> {
			return recognizeDetailed(input, options.lang ?? 'eng');
		}
	};
}