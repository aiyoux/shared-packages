import { describe, expect, it } from 'vitest';
import { OCR_ASSET_PATHS } from './ocr.ts';

describe('OCR asset paths', () => {
	it('points tesseract at same-origin vendor copies, not jsdelivr', () => {
		expect(OCR_ASSET_PATHS.workerPath).toBe('/vendor/tesseract/worker.min.js');
		expect(OCR_ASSET_PATHS.corePath).toBe('/vendor/tesseract');
		expect(OCR_ASSET_PATHS.langPath).toBe('/vendor/tesseract');
		expect(OCR_ASSET_PATHS.gzip).toBe(true);
		expect(OCR_ASSET_PATHS.langPath).not.toMatch(/jsdelivr|cdn\./);
	});
});
