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
	type TtsRenderSegment,
	type TtsVoice
} from '../types.js';
import { KOKORO_82M, KOKORO_VOICES, kokoroVoicePath, hfResolveUrl } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { storedName } from '../modelStore.manifest.js';
import { getSpeechModelStore, type ModelStore } from '../modelStore.js';
import { createVfsCache } from './transformersVfsCache.js';
import { configureTransformersEnv } from './transformersEnv.js';
import { SegmentPlayer, splitSentences, streamSentences } from './playback.js';

const info: TtsEngineInfo = {
	id: 'kokoro',
	label: 'Kokoro 82M (local)',
	description:
		'Neural TTS running fully in this tab via WebAssembly — 28 English voices, exports WAV. Import the model files into Files, then each voice you pick needs its own small voice file.',
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
			return KOKORO_VOICES.map(({ bin: _bin, grade: _grade, ...voice }) => voice);
		},

		async synthesize(text, opts): Promise<TtsRender> {
			const renderOne = await sentenceRenderer(opts);
			const segments: TtsRender['segments'] = [];
			const sentences = splitSentences(text);
			for (const sentence of sentences) {
				if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Synthesis cancelled');
				segments.push(await renderOne(sentence));
				opts?.onSegment?.({ done: segments.length, total: sentences.length });
			}
			return { segments, channels: 1 };
		},

		async speak(text, opts) {
			const renderOne = await sentenceRenderer({
				voice: opts?.voice,
				speed: opts?.speed,
				signal: opts?.signal
			});
			await streamSentences(text, renderOne, player, opts);
		},

		stop() {
			player.stop();
		}
	};

	/** Resolve model + voice once, then render one sentence per call. */
	async function sentenceRenderer(opts?: {
		voice?: string;
		speed?: number;
		signal?: AbortSignal;
		dirId?: string;
	}): Promise<(sentence: string) => Promise<TtsRenderSegment>> {
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
		// kokoro-js fetches voice bins itself, bypassing the transformers
		// cache — the only local source it consults is the 'kokoro-voices'
		// Cache Storage, so seed it from the VFS import to keep generation
		// fully offline. The URL must be byte-identical to the library's.
		const voiceUrl = hfResolveUrl(def, binPath);
		try {
			const voiceCache = await caches.open('kokoro-voices');
			const hit = await voiceCache.match(voiceUrl);
			if (!hit) {
				const blob = await store.readBlobPath(dirId, binPath);
				await voiceCache.put(
					voiceUrl,
					new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
				);
			}
		} catch (err) {
			// Cache API unavailable (private mode?) → the library falls back to
			// its network fetch, which fails under COEP — same as before.
			console.warn('kokoro voice cache seed failed', err);
		}
		return async (sentence) => {
			const audio = await tts.generate(sentence, { voice, speed: opts?.speed });
			return { samples: audio.audio, sampleRate: audio.sampling_rate, text: sentence };
		};
	}
}

export const kokoroTts: TtsEngine = createKokoroTts();