import { STT_ENGINE_CATALOG, TTS_ENGINE_CATALOG, type SttEngine, type SttEngineId, type TtsEngine, type TtsEngineId } from './types.js';

const sttCache = new Map<SttEngineId, SttEngine>();
const ttsCache = new Map<TtsEngineId, TtsEngine>();

export function listSttEngines(): readonly typeof STT_ENGINE_CATALOG[number][] {
	return STT_ENGINE_CATALOG;
}

export function listTtsEngines(): readonly typeof TTS_ENGINE_CATALOG[number][] {
	return TTS_ENGINE_CATALOG;
}

/** Load one STT engine on demand. Cached after first call. */
export async function loadSttEngine(id: SttEngineId): Promise<SttEngine> {
	const hit = sttCache.get(id);
	if (hit) return hit;

	let engine: SttEngine;
	if (id === 'webspeech') {
		const { webspeechStt } = await import('./engines/webspeechStt.js');
		engine = webspeechStt;
	} else if (id === 'transformers') {
		const { transformersStt } = await import('./engines/transformersStt.js');
		engine = transformersStt;
	} else if (id === 'ai') {
		const { aiStt } = await import('./engines/aiStt.js');
		engine = aiStt;
	} else {
		throw new Error(`Unknown STT engine: ${id}`);
	}

	await engine.load();
	sttCache.set(id, engine);
	return engine;
}

/** Load one TTS engine on demand. Cached after first call. */
export async function loadTtsEngine(id: TtsEngineId): Promise<TtsEngine> {
	const hit = ttsCache.get(id);
	if (hit) return hit;

	let engine: TtsEngine;
	if (id === 'webspeech') {
		const { webspeechTts } = await import('./engines/webspeechTts.js');
		engine = webspeechTts;
	} else if (id === 'kokoro') {
		const { kokoroTts } = await import('./engines/kokoroTts.js');
		engine = kokoroTts;
	} else {
		throw new Error(`Unknown TTS engine: ${id}`);
	}

	await engine.load();
	ttsCache.set(id, engine);
	return engine;
}

export function peekSttEngine(id: SttEngineId): SttEngine | null {
	return sttCache.get(id) ?? null;
}

export function peekTtsEngine(id: TtsEngineId): TtsEngine | null {
	return ttsCache.get(id) ?? null;
}