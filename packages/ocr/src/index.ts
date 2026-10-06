export type {
	OcrBox,
	OcrDetailedResult,
	OcrInput,
	OcrLang,
	OcrRegion,
	OcrResult,
	OcrRunOptions,
	OcrEngine
} from './types.js';
export {
	DEFAULT_OCR_ENGINE,
	OCR_ENGINE_ORDER,
	OCR_ENGINES,
	resolveOcrEngineId,
	handwritingEngines,
	ocrLangModels,
	ocrLangSupported,
	type OcrEngineId,
	type OcrEngineMeta
} from './registry.js';
export { ocrEngine, preloadOcrEngine } from './engine.js';
export {
	OCR_ASSET_PATHS,
	linesFromPage,
	recognizeText,
	recognizeDetailed,
	terminateOcr
} from './tesseract.js';
export { PADDLE_MODEL, MINDEE_MODEL, PPOCR_JPN_MODEL } from './models.js';
export {
	PADDLE_DET_MODEL,
	PADDLE_REC_MODEL,
	PPOCR_JPN_REC_MODEL,
	tarOf,
	stagePaddleArchives,
	japanRecConfigText,
	getPaddleHandle,
	createPaddleEngine
} from './engines/paddle.js';
export {
	createTesseractEngine
} from './engines/tesseract.js';
export {
	MINDEE_VOCAB,
	decodeCtc,
	parseCrnnConfig,
	crnnInput,
	crnnText,
	getMindeeModel,
	createMindeeEngine,
	type CrnnConfig
} from './engines/onnxTrCrnn.js';
export {
	AI_VISION_ENGINE_ID,
	AI_VISION_PROMPT_BASE,
	buildAiVisionPrompt,
	aiVisionMessages,
	createAiVisionEngine,
	inputToDataUrl,
	type AiVisionChatMessage,
	type AiVisionPart,
	type AiVisionTransport
} from './aiVision.js';