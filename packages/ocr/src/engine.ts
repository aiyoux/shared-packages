import type { OcrEngine } from './types.js';
import type { OcrEngineId } from './registry.js';

/**
 * Lazy engine loaders. The heavy glue (tesseract.js, paddleocr-js, ORT) is
 * only fetched when an engine is constructed, never at route-module scope.
 */
type OcrEngineFactory = () => Promise<OcrEngine>;

const factories: Record<OcrEngineId, OcrEngineFactory> = {
	tesseract: async () => (await import('./engines/tesseract.js')).createTesseractEngine(),
	paddle: async () => (await import('./engines/paddle.js')).createPaddleEngine(),
	mindee: async () => (await import('./engines/onnxTrCrnn.js')).createMindeeEngine()
};

const loaded = new Map<OcrEngineId, OcrEngine>();

/** Construct (once) and return the engine. Weights still load lazily inside
 * the first `recognize`; call `preloadOcrEngine` to warm earlier. */
export async function ocrEngine(id: OcrEngineId): Promise<OcrEngine> {
	const existing = loaded.get(id);
	if (existing) return existing;
	const engine = await factories[id]!();
	loaded.set(id, engine);
	return engine;
}

export function preloadOcrEngine(id: OcrEngineId): Promise<OcrEngine> {
	return ocrEngine(id);
}