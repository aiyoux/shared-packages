/**
 * Kokoro-82M TTS via kokoro-js (which runs on transformers.js + ORT wasm).
 * Weights and voice bins download into the shared VFS through the custom
 * cache; text is split into sentences so long renders stream and can cancel.
 */

import {
	SpeechEngineError,
	type ModelDownloadProgress,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
	type TtsVoice
} from '../types.js';
import { KOKORO_82M, KOKORO_VOICES, kokoroVoicePath } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { getSpeechModelStore, type ModelStore } from '../modelStore.js';
import { createVfsCache } from './transformersVfsCache.js';
import { configureTransformersEnv } from './transformersEnv.js';

const info: TtsEngineInfo = {
	id: 'kokoro',
	label: 'Kokoro 82M (local)',
	description:
		'Neural TTS running fully in this tab via WebAssembly — 54 voices, exports WAV. Downloads the model into Files on first use.',
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

/** Play rendered segments back-to-back; one AudioContext, cancelable. */
class SegmentPlayer {
	private ctx: AudioContext | null = null;
	private current: AudioBufferSourceNode | null = null;

	async play(render: TtsRender, opts?: { signal?: AbortSignal }): Promise<void> {
		this.ctx ??= new AudioContext();
		await this.ctx.resume();
		for (const segment of render.segments) {
			if (opts?.signal?.aborted || !this.ctx) return;
			const buffer = this.ctx.createBuffer(1, segment.samples.length, segment.sampleRate);
			buffer.getChannelData(0).set(segment.samples);
			await new Promise<void>((resolve) => {
				if (!this.ctx) return resolve();
				const source = this.ctx.createBufferSource();
				source.buffer = buffer;
				source.connect(this.ctx.destination);
				this.current = source;
				source.onended = () => resolve();
				source.start();
			});
		}
	}

	stop(): void {
		this.current?.stop();
		this.current = null;
	}
}

export function createKokoroTts(): TtsEngine {
	const player = new SegmentPlayer();
	let instance: KokoroTts | null = null;
	let loadedModelId: string | null = null;

	async function ttsFor(
		def: SpeechModelDef,
		store: ModelStore,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<KokoroTts> {
		if (instance && loadedModelId === def.id) return instance;
		await store.ensureModel(def, { onProgress: opts?.onProgress, signal: opts?.signal });
		const mod = await import('@huggingface/transformers');
		configureTransformersEnv(mod as unknown as Parameters<typeof configureTransformersEnv>[0], createVfsCache(store, def, { onProgress: opts?.onProgress }));
		const { KokoroTTS } = await import('kokoro-js');
		instance = (await KokoroTTS.from_pretrained(def.repo, {
			dtype: def.dtype,
			device: 'wasm'
		})) as unknown as KokoroTts;
		loadedModelId = def.id;
		return instance;
	}

	return {
		info,

		async load(opts) {
			const store = await getSpeechModelStore();
			await ttsFor(KOKORO_82M, store, opts);
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
			const tts = await ttsFor(def, store, { onProgress: opts?.onProgress, signal: opts?.signal });
			const voice = opts?.voice ?? KOKORO_VOICES[0]!.id;
			// Pre-fetch the chosen voice bin so it lands in Files with the model.
			await store.ensureExtraFile(def, kokoroVoicePath(voice), { signal: opts?.signal });
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

function splitSentences(text: string): string[] {
	const parts = text.split(/(?<=[.!?;:])\s+/).map((s) => s.trim()).filter(Boolean);
	return parts.length ? parts : text.trim() ? [text.trim()] : [];
}

export const kokoroTts: TtsEngine = createKokoroTts();