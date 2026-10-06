import { describe, expect, it } from 'vitest';
import { PADDLE_MODEL, MINDEE_MODEL, PPOCR_JPN_MODEL } from './models.ts';
import {
	DEFAULT_OCR_ENGINE,
	OCR_ENGINE_ORDER,
	OCR_ENGINES,
	handwritingEngines,
	ocrLangModels,
	ocrLangSupported,
	resolveOcrEngineId
} from './registry.ts';

describe('OCR engine registry', () => {
	it('orders the three local engines with Tesseract as the default', () => {
		expect(DEFAULT_OCR_ENGINE).toBe('tesseract');
		expect(OCR_ENGINE_ORDER).toEqual(['tesseract', 'paddle', 'mindee']);
		for (const id of OCR_ENGINE_ORDER) expect(OCR_ENGINES[id]!.id).toBe(id);
	});

	it('marks the sketcher handwriting engines and their weights', () => {
		expect(handwritingEngines().map((meta) => meta.id)).toEqual(['paddle', 'mindee']);
		expect(OCR_ENGINES.tesseract?.handwriting).toBe(false);
		expect(OCR_ENGINES.paddle?.model).toBe(PADDLE_MODEL);
		expect(OCR_ENGINES.mindee?.model).toBe(MINDEE_MODEL);
	});

	it('repairs unknown saved ids to the default, never rerouting silently', () => {
		expect(resolveOcrEngineId('mindee')).toBe('mindee');
		expect(resolveOcrEngineId('hwr:mindee')).toBe('tesseract');
		expect(resolveOcrEngineId(undefined)).toBe('tesseract');
		expect(resolveOcrEngineId('')).toBe('tesseract');
	});

	it('serves per-language model rows for the Japan rec pack', () => {
		expect(ocrLangModels(OCR_ENGINES.paddle!, 'jpn')).toEqual([PADDLE_MODEL, PPOCR_JPN_MODEL]);
		expect(ocrLangModels(OCR_ENGINES.paddle!, 'eng')).toEqual([PADDLE_MODEL]);
		expect(ocrLangModels(OCR_ENGINES.tesseract!, 'eng')).toEqual([]);
		expect(ocrLangSupported(OCR_ENGINES.paddle!, 'jpn')).toBe(true);
		expect(ocrLangSupported(OCR_ENGINES.mindee!, 'jpn')).toBe(false);
	});
});