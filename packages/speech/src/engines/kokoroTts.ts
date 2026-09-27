/**
 * Kokoro-82M TTS via kokoro-js (transformers.js + ORT). Inference runs in a
 * dedicated worker (kokoro.worker.ts) on WebAssembly or WebGPU, so rendering
 * never blocks the page. Weights and voice bins are user-imported into the
 * shared VFS; the page reads them and hands them to the worker. Text is split
 * into sentences so read-aloud streams and can stop.
 */

import {
	SpeechEngineError,
	type TtsDevice,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
	type TtsRenderSegment,
	type TtsVoice
} from '../types.js';
import { KOKORO_82M, KOKORO_VOICES, kokoroVoicePath, hfResolveUrl, modelDef } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { storedName } from '../modelStore.manifest.js';
import { getSpeechModelStore } from '../modelStore.js';
import { SegmentPlayer, splitSentences, streamSentences } from './playback.js';
import { createWorkerRpc } from './workerRpc.js';

const info: TtsEngineInfo = {
	id: 'kokoro',
	label: 'Kokoro 82M (local)',
	description:
		'Neural TTS running in a background worker on WebAssembly or WebGPU — 28 English voices, exports WAV. Import the model files into Files; each voice you pick also needs its own small voice file.',
	livePlayback: true,
	renderToBuffer: true,
	exportFormats: ['wav'],
	voices: 'model',
	devices: ['wasm', 'webgpu']
};

export const KOKORO_SAMPLE_RATE = 24000;

export function createKokoroTts(): TtsEngine {
	const player = new SegmentPlayer();
	// What the current worker has loaded; cleared when the worker is lost.
	let loadedKey: string | null = null;
	let selected: { def: SpeechModelDef; dirId?: string; device: TtsDevice } = {
		def: KOKORO_82M,
		device: 'wasm'
	};
	const worker = createWorkerRpc(
		() => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module', name: 'kokoro-tts' }),
		'Kokoro',
		() => {
			loadedKey = null;
		}
	);

	/** Load the model into the worker unless it already holds this exact one. */
	async function ensureLoaded(def: SpeechModelDef, dirId: string, device: TtsDevice): Promise<void> {
		const key = `${def.id}|${dirId}|${device}`;
		if (loadedKey === key) return;
		const store = await getSpeechModelStore();
		const files: Record<string, Blob | ArrayBuffer> = {};
		const transfer: Transferable[] = [];
		for (const file of def.files) {
			if (device === 'webgpu' && file.path.endsWith('.onnx')) {
				// Transfer bytes so the worker does not depend on cloning an
				// OPFS-backed Blob. An empty read here now identifies Files as source.
				const bytes = await store.readBytesPath(dirId, file.path);
				if (bytes.byteLength === 0) {
					throw new SpeechEngineError('NO_MODEL', `${file.path} read as 0 bytes from Files`);
				}
				const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
					? bytes.buffer
					: bytes.slice().buffer as ArrayBuffer;
				files[file.path] = buffer;
				transfer.push(buffer);
			} else {
				files[file.path] = await store.readBlobPath(dirId, file.path);
			}
		}
		loadedKey = null;
		try {
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
		loadedKey = key;
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
			selected = { def, dirId: opts?.dirId, device };
			const store = await getSpeechModelStore();
			const dirId = await store.requireModelDir(def, opts?.dirId);
			await ensureLoaded(def, dirId, device);
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
		const { def, device } = selected;
		const dirId = await store.requireModelDir(def, opts?.dirId ?? selected.dirId);
		await ensureLoaded(def, dirId, device);
		const voice = KOKORO_VOICES.some((v) => v.id === opts?.voice) ? opts!.voice! : KOKORO_VOICES[0]!.id;
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
			const { samples, sampleRate } = await worker.call<{ samples: Float32Array; sampleRate: number }>(
				'generate',
				{ text: sentence, voice, speed: opts?.speed }
			);
			return { samples, sampleRate, text: sentence };
		};
	}
}

export const kokoroTts: TtsEngine = createKokoroTts();
