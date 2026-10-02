import { describe, expect, it } from 'vitest';
import { OCR_ASSET_PATHS, linesFromPage } from './ocr.ts';

describe('OCR asset paths', () => {
	it('points tesseract at same-origin vendor copies, not jsdelivr', () => {
		expect(OCR_ASSET_PATHS.workerPath).toBe('/vendor/tesseract/worker.min.js');
		expect(OCR_ASSET_PATHS.corePath).toBe('/vendor/tesseract');
		expect(OCR_ASSET_PATHS.langPath).toBe('/vendor/tesseract');
		expect(OCR_ASSET_PATHS.gzip).toBe(true);
		expect(OCR_ASSET_PATHS.langPath).not.toMatch(/jsdelivr|cdn\./);
	});
});

describe('linesFromPage', () => {
	const box = { x0: 10, y0: 20, x1: 100, y1: 40 };
	const page = {
		blocks: [
			{
				paragraphs: [
					{ lines: [{ text: 'こんにちは', bbox: box }, { text: '  ', bbox: box }] },
					{ lines: [{ text: 'Hello', bbox: { ...box, y0: 50, y1: 70 } }] }
				]
			}
		]
	};

	it('collects non-empty lines in document order', () => {
		expect(linesFromPage(page)).toEqual([
			{ text: 'こんにちは', box },
			{ text: 'Hello', box: { x0: 10, y0: 50, x1: 100, y1: 70 } }
		]);
	});

	it('tolerates missing levels and invalid boxes', () => {
		expect(linesFromPage({})).toEqual([]);
		expect(linesFromPage({ blocks: null })).toEqual([]);
		expect(
			linesFromPage({
				blocks: [
					{},
					{ paragraphs: [{ lines: [{ text: 'x', bbox: { x0: 5, y0: 5, x1: 5, y1: 9 } }] }] },
					{ paragraphs: [{ lines: [{ text: 'y' }] }] }
				]
			})
		).toEqual([]);
	});
});
