/**
 * Kokoro-82M TTS via kokoro-js (transformers.js + ORT). Inference runs in a
 * dedicated worker (kokoro.worker.ts) on WebAssembly or WebGPU, so rendering
 * never blocks the page. Weights and voice bins come only from the browser
 * model store (Settings → AI models); the page reads them under the model's
 * shared lock and hands them to the worker. Text is split into sentences so
 * read-aloud streams and can stop.
 */

import { browserModelStore, ModelStoreError } from '@shared-packages/model-store';
import {
	SpeechEngineError,
	type TtsDevice,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
	type TtsRenderSegment,
	type TtsVoice
} from '../types.js';
import { KOKORO_82M, KOKORO_VOICES, kokoroVoicesModel, kokoroVoicePath, modelDef, speechBrowserModel } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { SegmentPlayer, splitSentences, streamSentences } from './playback.js';
import { createWorkerRpc } from './workerRpc.js';

const info: TtsEngineInfo = {
	id: 'kokoro',
	label: 'Kokoro 82M (local)',
	description:
		'Neural TTS running in a background worker on WebAssembly or WebGPU — 28 English voices, exports WAV. Load the model and each voice you pick in Settings → AI models.',
	livePlayback: true,
	renderToBuffer: true,
	exportFormats: ['wav'],
	voices: 'model',
	devices: ['wasm', 'webgpu']
};

export const KOKORO_SAMPLE_RATE = 24000;

const noModel = (error: unknown) => error instanceof ModelStoreError && error.code === 'MISSING_FILES'
	? new SpeechEngineError('NO_MODEL', error.message, error) : error;

export function createKokoroTts(): TtsEngine {
	const player = new SegmentPlayer();
	// What the current worker holds; cleared when the worker is lost.
	let loadedKey: string | null = null;
	const loadedVoices = new Map<string, string>();
	let selected: { def: SpeechModelDef; device: TtsDevice } = { def: KOKORO_82M, device: 'wasm' };
	const worker = createWorkerRpc(
		() => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module', name: 'kokoro-tts' }),
		'Kokoro',
		() => {
			loadedKey = null;
			loadedVoices.clear();
		}
	);

	/** Load the model into the worker unless it already holds this exact revision. */
	async function ensureLoaded(def: SpeechModelDef, device: TtsDevice, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await browserModelStore.readReady(speechBrowserModel(def), async (snapshot) => {
			const key = `${def.id}|${snapshot.manifest.revision}|${device}`;
			if (loadedKey === key) return;
			const files: Record<string, ArrayBuffer> = {};
			const transfer: Transferable[] = [];
			for (const file of def.files) {
				signal?.throwIfAborted();
				// Transfer bytes so the worker does not depend on cloning an
				// OPFS-backed File.
				const buffer = await (await snapshot.file(file.path)).arrayBuffer();
				files[file.path] = buffer;
				transfer.push(buffer);
			}
			loadedKey = null;
			try {
				signal?.throwIfAborted();
				await worker.call('load', { repo: def.repo, dtype: def.dtype, device, files }, transfer);
			} catch (err) {
				if (device === 'webgpu') {
					throw new SpeechEngineError(
						'UNSUPPORTED_BROWSER',
						`WebGPU could not run Kokoro here (${err instanceof Error ? err.message : String(err)}). Switch the device to WebAssembly.`,
						err
					);
				}
				throw err;
			}
			signal?.throwIfAborted();
			loadedKey = key;
		}, { signal }).catch((error: unknown) => { throw noModel(error); });
	}

	/** kokoro-js keeps each voice it reads; send a voice bin once per store revision. */
	async function ensureVoice(voice: string, signal?: AbortSignal): Promise<void> {
		const path = kokoroVoicePath(voice);
		await browserModelStore.readReady(kokoroVoicesModel(voice), async (snapshot) => {
			const revision = snapshot.manifest.revision;
			if (loadedVoices.get(voice) === revision) return;
			const bytes = await (await snapshot.file(path)).arrayBuffer();
			signal?.throwIfAborted();
			await worker.call('voice', { voice, bytes }, [bytes]);
			loadedVoices.set(voice, revision);
		}, { signal }).catch((error: unknown) => { throw noModel(error); });
	}

	return {
		info,

		async load(opts) {
			const def = opts?.modelId ? modelDef(opts.modelId) : KOKORO_82M;
			if (def.engine !== 'kokoro') throw new Error(`Not a Kokoro model: ${def.id}`);
			const device = opts?.device ?? 'wasm';
			if (device === 'webgpu' && !(typeof navigator !== 'undefined' && 'gpu' in navigator)) {
				throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'This browser has no WebGPU — switch the device to WebAssembly.');
			}
			selected = { def, device };
			await ensureLoaded(def, device, opts?.signal);
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
				opts?.onAudioSegment?.(segments[segments.length - 1]!, segments.length - 1, sentences.length);
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
	}): Promise<(sentence: string) => Promise<TtsRenderSegment>> {
		const { def, device } = selected;
		await ensureLoaded(def, device, opts?.signal);
		const voice = KOKORO_VOICES.some((v) => v.id === opts?.voice) ? opts!.voice! : KOKORO_VOICES[0]!.id;
		await ensureVoice(voice, opts?.signal);
		return async (sentence) => {
			opts?.signal?.throwIfAborted();
			const { samples, sampleRate } = await worker.call<{ samples: Float32Array; sampleRate: number }>(
				'generate',
				{ text: sentence, voice, speed: opts?.speed }
			);
			return { samples, sampleRate, text: sentence };
		};
	}
}

export const kokoroTts: TtsEngine = createKokoroTts();
