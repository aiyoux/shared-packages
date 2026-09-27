import type { SpeechModelDef, SttEngineId, TtsEngineId, TtsVoice } from './types.js';

export type { SpeechModelDef };

/**
 * Model weight catalogs, verified against the live HF repos (file paths + byte
 * sizes from the `/api/models/<repo>/tree/main` listing on 2026-09-27).
 *
 * The catalog lists the files each engine loads for its default dtype. If a
 * library fetches additional small files (tokenizers etc.), the VFS model
 * store still captures them via the transformers.js custom cache `put()` —
 * the catalog is the pre-download / manifest / display list, not a whitelist.
 */

// Compact file-entry helper for the catalogs below.
const f = (path: string, bytes?: number): SpeechModelDef['files'][number] => ({ path, bytes });

export const WHISPER_TINY: SpeechModelDef = {
	id: 'whisper-tiny',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-tiny',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 2243),
		f('preprocessor_config.json', 339),
		f('generation_config.json', 3772),
		f('quantize_config.json', 10126),
		f('tokenizer.json', 2480466),
		f('tokenizer_config.json', 282683),
		f('onnx/encoder_model_quantized.onnx', 10124990),
		f('onnx/decoder_model_merged_quantized.onnx', 30719241)
	],
	sizeBytes: 43_623_860,
	languages: ['multilingual'],
	downloadRoot: 'hf'
};

export const WHISPER_BASE: SpeechModelDef = {
	id: 'whisper-base',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-base',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 2243),
		f('preprocessor_config.json', 339),
		f('generation_config.json', 3832),
		f('quantize_config.json', 10126),
		f('tokenizer.json', 2480466),
		f('tokenizer_config.json', 282682),
		f('onnx/encoder_model_quantized.onnx', 23201314),
		f('onnx/decoder_model_merged_quantized.onnx', 53693315)
	],
	sizeBytes: 79_674_317,
	languages: ['multilingual'],
	downloadRoot: 'hf'
};

export const WHISPER_SMALL: SpeechModelDef = {
	id: 'whisper-small',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/whisper-small',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 2227),
		f('preprocessor_config.json', 339),
		f('generation_config.json', 3893),
		f('quantize_config.json', 10126),
		f('tokenizer.json', 2480466),
		f('tokenizer_config.json', 282683),
		f('onnx/encoder_model_quantized.onnx', 92326160),
		f('onnx/decoder_model_merged_quantized.onnx', 156750845)
	],
	sizeBytes: 251_856_739,
	languages: ['multilingual'],
	downloadRoot: 'hf'
};

export const MOONSHINE_TINY: SpeechModelDef = {
	id: 'moonshine-tiny',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/moonshine-tiny-ONNX',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 921),
		f('preprocessor_config.json', 128),
		f('generation_config.json', 147),
		f('special_tokens_map.json', 3),
		f('tokenizer.json', 3761754),
		f('tokenizer_config.json', 135735),
		f('onnx/encoder_model_quantized.onnx', 7937661),
		f('onnx/decoder_model_merged_quantized.onnx', 20243286)
	],
	sizeBytes: 32_079_635,
	languages: ['en'],
	downloadRoot: 'hf'
};

export const MOONSHINE_BASE: SpeechModelDef = {
	id: 'moonshine-base',
	task: 'stt',
	engine: 'transformers',
	repo: 'onnx-community/moonshine-base-ONNX',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 922),
		f('preprocessor_config.json', 128),
		f('generation_config.json', 147),
		f('special_tokens_map.json', 3),
		f('tokenizer.json', 3761754),
		f('tokenizer_config.json', 135735),
		f('onnx/encoder_model_quantized.onnx', 20513063),
		f('onnx/decoder_model_merged_quantized.onnx', 42498870)
	],
	sizeBytes: 66_910_622,
	languages: ['en'],
	downloadRoot: 'hf'
};

export const KOKORO_82M: SpeechModelDef = {
	id: 'kokoro-82m',
	task: 'tts',
	engine: 'kokoro',
	repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
	revision: 'main',
	dtype: 'q8',
	files: [
		f('config.json', 44),
		f('tokenizer.json', 3497),
		f('tokenizer_config.json', 113),
		f('onnx/model_quantized.onnx', 92361116)
	],
	// Plus one voices/<voice>.bin (~522 KB) per selected voice — the store
	// pre-fetches the chosen voice so it lands in Files too.
	sizeBytes: 92_364_770,
	languages: ['en'],
	downloadRoot: 'hf'
};

export const MODEL_CATALOG: readonly SpeechModelDef[] = [
	WHISPER_TINY,
	WHISPER_BASE,
	WHISPER_SMALL,
	MOONSHINE_TINY,
	MOONSHINE_BASE,
	KOKORO_82M
] as const;

export function modelDef(id: string): SpeechModelDef {
	const found = MODEL_CATALOG.find((m) => m.id === id);
	if (!found) throw new Error(`Unknown speech model: ${id}`);
	return found;
}

export function sttModelsFor(engine: SttEngineId): readonly SpeechModelDef[] {
	return MODEL_CATALOG.filter((m) => m.task === 'stt' && m.engine === (engine as SpeechModelDef['engine']));
}

export function ttsModelsFor(engine: TtsEngineId): readonly SpeechModelDef[] {
	return MODEL_CATALOG.filter((m) => m.task === 'tts' && m.engine === (engine as SpeechModelDef['engine']));
}

export function defaultSttModel(engine: SttEngineId): string | null {
	const models = sttModelsFor(engine);
	return models.length ? models[0]!.id : null;
}

export function defaultTtsModel(engine: TtsEngineId): string | null {
	const models = ttsModelsFor(engine);
	return models.length ? models[0]!.id : null;
}

/** Resolve URL for one file inside a model repo (HF's stable redirect target). */
export function hfResolveUrl(def: SpeechModelDef, path: string): string {
	return `https://huggingface.co/${def.repo}/resolve/${def.revision}/${path}`;
}

/** Voice bin path inside the Kokoro repo for one voice id. */
export function kokoroVoicePath(voice: string): string {
	return `voices/${voice}.bin`;
}

export type KokoroVoice = TtsVoice & { bin: string };

/** The 29 English voices shipped with Kokoro-82M v1.0. */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
	{ id: 'af_heart', label: 'Heart · American, female', bin: 'voices/af_heart.bin' },
	{ id: 'af_bella', label: 'Bella · American, female', bin: 'voices/af_bella.bin' },
	{ id: 'af_nicole', label: 'Nicole · American, female', bin: 'voices/af_nicole.bin' },
	{ id: 'af_aoede', label: 'Aoede · American, female', bin: 'voices/af_aoede.bin' },
	{ id: 'af_kore', label: 'Kore · American, female', bin: 'voices/af_kore.bin' },
	{ id: 'af_sarah', label: 'Sarah · American, female', bin: 'voices/af_sarah.bin' },
	{ id: 'af_sky', label: 'Sky · American, female', bin: 'voices/af_sky.bin' },
	{ id: 'am_michael', label: 'Michael · American, male', bin: 'voices/am_michael.bin' },
	{ id: 'am_fenrir', label: 'Fenrir · American, male', bin: 'voices/am_fenrir.bin' },
	{ id: 'am_puck', label: 'Puck · American, male', bin: 'voices/am_puck.bin' },
	{ id: 'am_adam', label: 'Adam · American, male', bin: 'voices/am_adam.bin' },
	{ id: 'am_echo', label: 'Echo · American, male', bin: 'voices/am_echo.bin' },
	{ id: 'am_eric', label: 'Eric · American, male', bin: 'voices/am_eric.bin' },
	{ id: 'am_onyx', label: 'Onyx · American, male', bin: 'voices/am_onyx.bin' },
	{ id: 'am_santa', label: 'Santa · American, male', bin: 'voices/am_santa.bin' },
	{ id: 'bf_emma', label: 'Emma · British, female', bin: 'voices/bf_emma.bin' },
	{ id: 'bf_isabella', label: 'Isabella · British, female', bin: 'voices/bf_isabella.bin' },
	{ id: 'bf_alice', label: 'Alice · British, female', bin: 'voices/bf_alice.bin' },
	{ id: 'bf_lily', label: 'Lily · British, female', bin: 'voices/bf_lily.bin' },
	{ id: 'bm_george', label: 'George · British, male', bin: 'voices/bm_george.bin' },
	{ id: 'bm_fable', label: 'Fable · British, male', bin: 'voices/bm_fable.bin' },
	{ id: 'bm_lewis', label: 'Lewis · British, male', bin: 'voices/bm_lewis.bin' },
	{ id: 'bm_daniel', label: 'Daniel · British, male', bin: 'voices/bm_daniel.bin' }
] as const;

export function kokoroVoice(voiceId: string): KokoroVoice {
	const found = KOKORO_VOICES.find((v) => v.id === voiceId);
	if (!found) throw new Error(`Unknown Kokoro voice: ${voiceId}`);
	return found;
}

/** Kokoro's catalog def extended with one voice bin, so the import card
 *  lists and accepts the voices/<voice>.bin file that voice needs. The
 *  def id is unchanged, so the manifest the card's presence check matches
 *  stays the model's own. An empty/unknown voice falls back to the first
 *  catalog voice (the picker's default). */
export function kokoroVoiceDef(voice: string): SpeechModelDef {
	const bin = kokoroVoice(voice || KOKORO_VOICES[0]!.id).bin;
	return { ...KOKORO_82M, files: [...KOKORO_82M.files, { path: bin }] };
}