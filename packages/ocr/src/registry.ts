import type { ModelDef } from '@shared-packages/model-store';
import { MINDEE_MODEL, PADDLE_MODEL, PPOCR_JPN_MODEL } from './models.js';
import type { OcrLang } from './types.js';

/**
 * THE engine table — the single declaration point for OCR engine ids and
 * their catalog rows. Selection surfaces (tool pickers, the AI models tab)
 * render from it; runtimes import through `ocrEngine(id)`. Adding an engine
 * means: pinned `ModelDef` in `models.ts`, one row here, a loader entry in
 * `engine.ts`, a license row, and a quality gate
 * (`scripts/ocr-quality/`, extension of `scripts/hwr-quality/`) — see
 * `README.md` for the recipe and the recorded candidate verdicts.
 */
export type OcrEngineId = 'tesseract' | 'paddle' | 'mindee';

export type OcrEngineMeta = {
	id: OcrEngineId;
	label: string;
	/** The glue runtime — license rows live in the hub's licenses panel. */
	runtime: string;
	license: string;
	docsUrl: string;
	/** One-line install cost for pickers (weights, not the runtime). */
	weightHint: string;
	/** Languages this engine can serve. */
	langs: readonly OcrLang[];
	/** True for sketcher's Handwriting → text adapters (paddle, mindee). */
	handwriting: boolean;
	/** Stored model weights; `undefined` = vendored with the app (tesseract). */
	model?: ModelDef;
	/** Extra per-language weights (paddle's Japanese rec pack). */
	langModels?: Readonly<Partial<Record<OcrLang, ModelDef>>>;
};

export const DEFAULT_OCR_ENGINE: OcrEngineId = 'tesseract';

export const OCR_ENGINE_ORDER: readonly OcrEngineId[] = ['tesseract', 'paddle', 'mindee'];

export const OCR_ENGINES: Readonly<Record<OcrEngineId, OcrEngineMeta>> = {
	tesseract: {
		id: 'tesseract',
		label: 'Tesseract',
		runtime: 'tesseract.js',
		license: 'Apache-2.0',
		docsUrl: 'https://github.com/naptha/tesseract.js',
		weightHint: 'Vendored with the app (eng ≈ 3 MB, jpn ≈ 2 MB packs)',
		langs: ['eng', 'jpn'],
		handwriting: false
	},
	paddle: {
		id: 'paddle',
		label: PADDLE_MODEL.label,
		runtime: 'paddleocr-js + onnxruntime-web',
		license: PADDLE_MODEL.license ?? 'Apache-2.0',
		docsUrl: 'https://github.com/PaddlePaddle/PaddleOCR',
		weightHint: 'PP-OCRv5 det + rec ≈ 21 MB in the model store',
		langs: ['eng', 'jpn'],
		handwriting: true,
		model: PADDLE_MODEL,
		langModels: { jpn: PPOCR_JPN_MODEL }
	},
	mindee: {
		id: 'mindee',
		label: MINDEE_MODEL.label,
		runtime: 'onnxruntime-web',
		license: MINDEE_MODEL.license ?? 'Apache-2.0',
		docsUrl: 'https://github.com/mindee/doctr',
		weightHint: 'CRNN MobileNet v3 large ≈ 18 MB in the model store',
		langs: ['eng'],
		handwriting: true,
		model: MINDEE_MODEL
	}
};

/** The weights a language needs on top of (or instead of) the base model. */
export function ocrLangModels(meta: OcrEngineMeta, lang: OcrLang): ModelDef[] {
	const base = meta.model ? [meta.model] : [];
	const extra = meta.langModels?.[lang];
	return extra && !base.some((model) => model.id === extra.id) ? [...base, extra] : base;
}

export function ocrLangSupported(meta: OcrEngineMeta, lang: OcrLang): boolean {
	return meta.langs.includes(lang);
}

/** Engines that adapt to sketcher's Handwriting → text (registry = the table). */
export function handwritingEngines(): readonly OcrEngineMeta[] {
	return OCR_ENGINE_ORDER.map((id) => OCR_ENGINES[id]).filter((meta) => meta.handwriting);
}

/** Saved unknown ids repair to the default rather than silently rerouting. */
export function resolveOcrEngineId(value: unknown): OcrEngineId {
	return OCR_ENGINE_ORDER.includes(value as OcrEngineId) ? (value as OcrEngineId) : DEFAULT_OCR_ENGINE;
}