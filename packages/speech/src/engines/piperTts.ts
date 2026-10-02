/**
 * Piper TTS via @mintplex-labs/piper-tts-web. Voice files (.onnx + .onnx.json)
 * load in Settings → AI models; the worker (piper.worker.ts) reads them from
 * the browser model store, so `predict()` never fetches.
 *
 * Inference runs in that dedicated worker, so rendering never blocks the
 * page; WAV decode and playback stay here.
 */

import { browserModelStore, ModelStoreError } from '@shared-packages/model-store';
import {
	SpeechEngineError,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
	type TtsRenderSegment,
	type TtsVoice
} from '../types.js';
import { decodeMono } from '../audio.js';
import { piperVoiceList, piperVoiceModel, DEFAULT_PIPER_VOICE } from '../piperVoices.js';
import { SegmentPlayer, splitSentences, streamSentences } from './playback.js';
import { createWorkerRpc } from './workerRpc.js';

const info: TtsEngineInfo = {
	id: 'piper',
	label: 'Piper (local)',
	description:
		'Fast neural voices from the Piper catalog — 100+ language variants, exports WAV. Load a voice pair (.onnx + .onnx.json) in Settings → AI models, then pick it.',
	livePlayback: true,
	renderToBuffer: true,
	exportFormats: ['wav'],
	voices: 'model',
	supportsSpeed: false
};

/** Say which voice file is missing before the worker tries to load it. */
async function requireVoice(voiceId: string): Promise<void> {
	try {
		await browserModelStore.require(piperVoiceModel(voiceId));
	} catch (error) {
		throw error instanceof ModelStoreError && error.code === 'MISSING_FILES'
			? new SpeechEngineError('NO_MODEL', error.message, error) : error;
	}
}

export function createPiperTts(): TtsEngine {
	const player = new SegmentPlayer();
	const worker = createWorkerRpc(
		() => new Worker(new URL('./piper.worker.ts', import.meta.url), { type: 'module', name: 'piper-tts' }),
		'Piper',
		() => {}
	);

	async function renderSentence(voiceId: string, sentence: string): Promise<TtsRenderSegment> {
		const wav = await worker.call<Blob>('generate', { voiceId, text: sentence });
		const decoded = await decodeMono(wav);
		return { samples: decoded.samples, sampleRate: decoded.sampleRate, text: sentence };
	}

	return {
		info,

		async load(opts) {
			const voiceId = opts?.modelId?.startsWith('piper-')
				? opts.modelId.slice('piper-'.length)
				: undefined;
			if (voiceId) await requireVoice(voiceId);
		},

		async listVoices(): Promise<TtsVoice[]> {
			return piperVoiceList();
		},

		async synthesize(text, opts): Promise<TtsRender> {
			const voiceId = opts?.voice ?? DEFAULT_PIPER_VOICE;
			await requireVoice(voiceId);
			const segments: TtsRender['segments'] = [];
			const sentences = splitSentences(text);
			for (const sentence of sentences) {
				if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Synthesis cancelled');
				segments.push(await renderSentence(voiceId, sentence));
				opts?.onAudioSegment?.(segments[segments.length - 1]!, segments.length - 1, sentences.length);
				opts?.onSegment?.({ done: segments.length, total: sentences.length });
			}
			return { segments, channels: 1 };
		},

		async speak(text, opts) {
			const voiceId = opts?.voice ?? DEFAULT_PIPER_VOICE;
			await requireVoice(voiceId);
			await streamSentences(text, (sentence) => renderSentence(voiceId, sentence), player, opts);
		},

		stop() {
			player.stop();
		}
	};
}

export const piperTts: TtsEngine = createPiperTts();
