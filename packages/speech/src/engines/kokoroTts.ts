/**
 * Kokoro-82M TTS via kokoro-js (which runs on transformers.js + ORT wasm).
 * Weights and voice bins are user-imported into the shared VFS; text is split
 * into sentences so long renders stream and can cancel.
 */

import {
	SpeechEngineError,
	type ModelDownloadProgress,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
	type TtsVoice
} from '../types.js';
import { KOKORO_82M, KOKORO_VOICES, kokoroVoicePath, hfResolveUrl } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { storedName } from '../modelStore.manifest.js';
import { getSpeechModelStore, type ModelStore } from '../modelStore.js';
import { createVfsCache } from './transformersVfsCache.js';
import { configureTransformersEnv } from './transformersEnv.js';
import { SegmentPlayer, splitSentences } from './playback.js';

const info: TtsEngineInfo = {
	id: 'kokoro',
	label: 'Kokoro 82M (local)',
	description:
		'Neural TTS running fully in this tab via WebAssembly — 54 voices, exports WAV. Import the model files into Files, then pick a voice.',
	livePlayback: true,
	renderToBuffer: true,
	exportFormats: ['wav'],
	voices: 'model'
};

export const KOKORO_SAMPLE_RATE = 24000;

type RawAudio = { audio: Float32Array; sampling_rate: number };
type KokoroTts = {
	generate: (text: string, opts?: { voice?: string; speed?: number }) => Promise<RawAudio>;
};

export function createKokoroTts(): TtsEngine {
	const player = new SegmentPlayer();
	let instance: KokoroTts | null = null;
	let loadedKey: string | null = null;
	let selectedDirId: string | undefined;

	async function ttsFor(
		def: SpeechModelDef,
		store: ModelStore,
		dirId: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<KokoroTts> {
		const key = `${def.id}|${dirId}`;
		if (instance && loadedKey === key) return instance;
		const mod = await import('@huggingface/transformers');
		configureTransformersEnv(mod as unknown as Parameters<typeof configureTransformersEnv>[0], createVfsCache(store, def, { dirId, onProgress: opts?.onProgress }));
		const { KokoroTTS } = await import('kokoro-js');
		instance = (await KokoroTTS.from_pretrained(def.repo, {
			dtype: def.dtype,
			device: 'wasm'
		})) as unknown as KokoroTts;
		loadedKey = key;
		return instance;
	}

	return {
		info,

		async load(opts) {
			const store = await getSpeechModelStore();
			selectedDirId = opts?.dirId;
			const dirId = await store.requireModelDir(KOKORO_82M, opts?.dirId);
			await ttsFor(KOKORO_82M, store, dirId, opts);
		},

		async listVoices(): Promise<TtsVoice[]> {
			return KOKORO_VOICES.map((v) => ({
				id: v.id,
				label: v.label,
				language: 'en',
				preview: 'Hello from the scratch pad. This voice runs entirely in your browser.'
			}));
		},

		async synthesize(text, opts): Promise<TtsRender> {
			const store = await getSpeechModelStore();
			const def = KOKORO_82M;
			const dirId = await store.requireModelDir(def, opts?.dirId ?? selectedDirId);
			const tts = await ttsFor(def, store, dirId, { signal: opts?.signal });
			const voice = opts?.voice ?? KOKORO_VOICES[0]!.id;
			// The voice bin must be imported like the weights — fetches from HF
			// are blocked under the hub's COEP isolation.
			const binPath = kokoroVoicePath(voice);
			const binNode = await store.resolveFileNode(dirId, binPath);
			if (!binNode) {
				throw new SpeechEngineError(
					'NO_MODEL',
					`Missing voice file ${storedName(binPath)}. Download it from ${hfResolveUrl(def, binPath)} and import it.`
				);
			}
			const segments: TtsRender['segments'] = [];
			const sentences = splitSentences(text);
			for (const sentence of sentences) {
				if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Synthesis cancelled');
				const audio = await tts.generate(sentence, { voice, speed: opts?.speed });
				segments.push({
					samples: audio.audio,
					sampleRate: audio.sampling_rate,
					text: sentence
				});
			}
			return { segments, channels: 1 };
		},

		async speak(text, opts) {
			const render = await this.synthesize(text, {
				voice: opts?.voice,
				speed: opts?.speed,
				signal: opts?.signal
			});
			await player.play(render, { signal: opts?.signal });
		},

		stop() {
			player.stop();
		}
	};
}

export const kokoroTts: TtsEngine = createKokoroTts();