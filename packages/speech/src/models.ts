import type { SpeechModelDef, SttEngineId, TtsDevice, TtsEngineId, TtsVoice } from './types.js';

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
	downloadRoot: 'hf',
	devices: ['wasm']
};

/** Full-precision Kokoro weights — what kokoro-js recommends on WebGPU (the
 *  quantized ops of the q8 file fall back to CPU there). Same repo, same
 *  small files, bigger model file. */
export const KOKORO_82M_FP32: SpeechModelDef = {
	id: 'kokoro-82m-fp32',
	task: 'tts',
	engine: 'kokoro',
	repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
	revision: 'main',
	dtype: 'fp32',
	files: [
		f('config.json', 44),
		f('tokenizer.json', 3497),
		f('tokenizer_config.json', 113),
		f('onnx/model.onnx', 325532232)
	],
	sizeBytes: 325_535_886,
	languages: ['en'],
	downloadRoot: 'hf',
	devices: ['webgpu']
};

export const MODEL_CATALOG: readonly SpeechModelDef[] = [
	WHISPER_TINY,
	WHISPER_BASE,
	WHISPER_SMALL,
	MOONSHINE_TINY,
	MOONSHINE_BASE,
	KOKORO_82M,
	KOKORO_82M_FP32
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

/** The engine's model meant for `device` (a def without `devices` fits any). */
export function ttsModelForDevice(engine: TtsEngineId, device: TtsDevice): SpeechModelDef | null {
	const models = ttsModelsFor(engine);
	return models.find((m) => !m.devices || m.devices.includes(device)) ?? models[0] ?? null;
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

export type KokoroVoice = TtsVoice & { bin: string; grade: string };

function kokoroEntry(id: string, name: string, gender: 'female' | 'male', grade: string): KokoroVoice {
	const american = id.startsWith('a');
	return {
		id,
		label: `${name} · ${gender} · grade ${grade}`,
		language: american ? 'en-US' : 'en-GB',
		group: american ? 'American English' : 'British English',
		grade,
		bin: kokoroVoicePath(id)
	};
}

/**
 * Every voice kokoro-js 1.2.1 accepts (its internal VOICES table — the
 * other 26 bins in the model repo are non-English and it rejects them).
 * Grades are the library's overall quality grade; each accent group is
 * ordered best first. `kokoroVoices.test.ts` pins this list to the library.
 */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
	kokoroEntry('af_heart', 'Heart', 'female', 'A'),
	kokoroEntry('af_bella', 'Bella', 'female', 'A-'),
	kokoroEntry('af_nicole', 'Nicole', 'female', 'B-'),
	kokoroEntry('af_aoede', 'Aoede', 'female', 'C+'),
	kokoroEntry('af_kore', 'Kore', 'female', 'C+'),
	kokoroEntry('af_sarah', 'Sarah', 'female', 'C+'),
	kokoroEntry('af_alloy', 'Alloy', 'female', 'C'),
	kokoroEntry('af_nova', 'Nova', 'female', 'C'),
	kokoroEntry('af_sky', 'Sky', 'female', 'C-'),
	kokoroEntry('af_jessica', 'Jessica', 'female', 'D'),
	kokoroEntry('af_river', 'River', 'female', 'D'),
	kokoroEntry('am_fenrir', 'Fenrir', 'male', 'C+'),
	kokoroEntry('am_michael', 'Michael', 'male', 'C+'),
	kokoroEntry('am_puck', 'Puck', 'male', 'C+'),
	kokoroEntry('am_echo', 'Echo', 'male', 'D'),
	kokoroEntry('am_eric', 'Eric', 'male', 'D'),
	kokoroEntry('am_liam', 'Liam', 'male', 'D'),
	kokoroEntry('am_onyx', 'Onyx', 'male', 'D'),
	kokoroEntry('am_santa', 'Santa', 'male', 'D-'),
	kokoroEntry('am_adam', 'Adam', 'male', 'F+'),
	kokoroEntry('bf_emma', 'Emma', 'female', 'B-'),
	kokoroEntry('bf_isabella', 'Isabella', 'female', 'C'),
	kokoroEntry('bf_alice', 'Alice', 'female', 'D'),
	kokoroEntry('bf_lily', 'Lily', 'female', 'D'),
	kokoroEntry('bm_fable', 'Fable', 'male', 'C'),
	kokoroEntry('bm_george', 'George', 'male', 'C'),
	kokoroEntry('bm_lewis', 'Lewis', 'male', 'D+'),
	kokoroEntry('bm_daniel', 'Daniel', 'male', 'D')
];

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
export function kokoroVoiceDef(voice: string, base: SpeechModelDef = KOKORO_82M): SpeechModelDef {
	const known = KOKORO_VOICES.find((v) => v.id === voice) ?? KOKORO_VOICES[0]!;
	const bin = known.bin;
	return { ...base, files: [...base.files, { path: bin }] };
}