import { STT_ENGINE_CATALOG, TTS_ENGINE_CATALOG, type SttEngine, type SttEngineId, type TtsEngine, type TtsEngineId, type TtsLoadOpts, type TtsVoice } from './types.js';

/** Load options shared by both engine kinds. */
export type EngineLoadOpts = TtsLoadOpts & { modelId?: string | null };

const sttLoaded = new Map<SttEngineId, { engine: SttEngine; key: string }>();
const ttsLoaded = new Map<TtsEngineId, { engine: TtsEngine; key: string }>();

export function listSttEngines(): readonly typeof STT_ENGINE_CATALOG[number][] {
	return STT_ENGINE_CATALOG;
}

export function listTtsEngines(): readonly typeof TTS_ENGINE_CATALOG[number][] {
	return TTS_ENGINE_CATALOG;
}

async function importSttEngine(id: SttEngineId): Promise<SttEngine> {
	if (id === 'webspeech') {
		const { webspeechStt } = await import('./engines/webspeechStt.js');
		return webspeechStt;
	}
	if (id === 'transformers') {
		const { createHostedStt } = await import('./browserHostEngines.js');
		return createHostedStt();
	}
	if (id === 'ai') {
		const { aiStt } = await import('./engines/aiStt.js');
		return aiStt;
	}
	throw new Error(`Unknown STT engine: ${id}`);
}

async function importTtsEngine(id: TtsEngineId): Promise<TtsEngine> {
	if (id === 'webspeech') {
		const { webspeechTts } = await import('./engines/webspeechTts.js');
		return webspeechTts;
	}
	if (id === 'kokoro') {
		const { createHostedTts } = await import('./browserHostEngines.js');
		return createHostedTts('kokoro');
	}
	if (id === 'piper') {
		const { hostedPiperTts } = await import('./browserHostEngines.js');
		return hostedPiperTts;
	}
	throw new Error(`Unknown TTS engine: ${id}`);
}

/**
 * Load one STT engine on demand. The (model, device) pair is the cache key
 * — engine instances are singletons that track their own selected model.
 */
export async function loadSttEngine(id: SttEngineId, opts?: EngineLoadOpts): Promise<SttEngine> {
	const key = `${opts?.modelId ?? ''}|${opts?.device ?? ''}`;
	const hit = sttLoaded.get(id);
	if (hit && hit.key === key) return hit.engine;

	const engine = hit?.engine ?? (await importSttEngine(id));
	await engine.load(opts?.modelId ?? undefined, opts);
	sttLoaded.set(id, { engine, key });
	return engine;
}

/** Load one TTS engine on demand. Same (model, device) cache-key rule. */
export async function loadTtsEngine(id: TtsEngineId, opts?: TtsLoadOpts): Promise<TtsEngine> {
	const key = `${opts?.modelId ?? ''}|${opts?.device ?? ''}`;
	const hit = ttsLoaded.get(id);
	if (hit && hit.key === key) return hit.engine;

	const engine = hit?.engine ?? (await importTtsEngine(id));
	await engine.load(opts);
	ttsLoaded.set(id, { engine, key });
	return engine;
}

/** An engine's voice catalog without loading its model (the list is static
 *  for local engines; browser speech enumerates the platform's voices). */
export async function listTtsVoices(id: TtsEngineId): Promise<TtsVoice[]> {
	return (ttsLoaded.get(id)?.engine ?? (await importTtsEngine(id))).listVoices();
}

export function peekSttEngine(id: SttEngineId): SttEngine | null {
	return sttLoaded.get(id)?.engine ?? null;
}

export function peekTtsEngine(id: TtsEngineId): TtsEngine | null {
	return ttsLoaded.get(id)?.engine ?? null;
}