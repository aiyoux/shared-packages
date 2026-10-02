/**
 * Local-model STT via transformers.js (`automatic-speech-recognition`).
 * Weights come only from the browser model store (Settings → AI models); ORT
 * runs on the already-vendored `/vendor/ort/` wasm pair.
 */

import { browserModelStore, ModelStoreError, transformersCache } from '@shared-packages/model-store';
import {
	SpeechEngineError,
	type ModelDownloadProgress,
	type SttEngine,
	type SttEngineInfo,
	type SttResult
} from '../types.js';
import { defaultSttModel, speechBrowserModel, sttModelsFor } from '../models.js';
import type { SpeechModelDef } from '../models.js';
import { chunkAudio, decodeToMono16k, DURATION_MAX_MS, TARGET_SAMPLE_RATE } from '../audio.js';
import { configureTransformersEnv, type TransformEnv } from './transformersEnv.js';

const info: SttEngineInfo = {
	id: 'transformers',
	label: 'Local model (transformers.js)',
	description:
		'Whisper and Moonshine run fully in this tab via WebAssembly — nothing leaves the browser. Load the model in Settings → AI models.',
	supportsMic: true,
	supportsFileInput: true,
	streamingPartials: false,
	languageSelection: true,
	onDevice: true
};

type WhisperChunk = { text: string; timestamp: [number | null, number | null] };
type AsrOutput = { text: string; chunks?: WhisperChunk[] };
type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<AsrOutput>;
type TransformersModule = {
	env: TransformEnv;
	pipeline: (task: string, repo: string, opts?: Record<string, unknown>) => Promise<AsrPipeline>;
};

/** One pipeline per model, keyed by the store revision it was built from. */
const pipelines = new Map<string, { revision: string; pipe: AsrPipeline }>();

/** A clear or replace in Settings changes the revision, so the next run reloads. */
async function loadPipeline(mod: TransformersModule, def: SpeechModelDef, signal?: AbortSignal): Promise<AsrPipeline> {
	const model = speechBrowserModel(def);
	return browserModelStore.readReady(model, async (files) => {
		const cached = pipelines.get(def.id);
		if (cached?.revision === files.manifest.revision) return cached.pipe;
		configureTransformersEnv(mod, transformersCache(model, files));
		const pipe = await mod.pipeline('automatic-speech-recognition', def.repo, { dtype: def.dtype, device: 'wasm' });
		pipelines.set(def.id, { revision: files.manifest.revision, pipe });
		return pipe;
	}, { signal }).catch((error: unknown) => {
		throw error instanceof ModelStoreError && error.code === 'MISSING_FILES'
			? new SpeechEngineError('NO_MODEL', error.message, error) : error;
	});
}

function modelDefById(id: string | null): SpeechModelDef {
	const found = sttModelsFor('transformers').find((m) => m.id === id);
	if (!found) throw new SpeechEngineError('NO_MODEL', `Unknown transformers model: ${id ?? '(none)'}`);
	return found;
}

export function createTransformersStt(): SttEngine {
	let selectedModelId: string | null = null;
	let recorder: import('../mic.js').MicRecorder | null = null;

	async function pipelineFor(
		modelId: string | null,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ pipe: AsrPipeline; def: SpeechModelDef }> {
		const def = modelDefById(modelId ?? selectedModelId ?? defaultSttModel('transformers'));
		const mod = await import('@huggingface/transformers');
		const pipe = await loadPipeline(mod as unknown as TransformersModule, def, opts?.signal);
		return { pipe, def };
	}

	return {
		info,

		async probe() {
			return { supported: typeof WebAssembly !== 'undefined' };
		},

		async load(modelId, opts) {
			if (!modelId) throw new SpeechEngineError('NO_MODEL', 'Pick a model first');
			selectedModelId = modelId;
			await pipelineFor(modelId, opts);
		},

		async startListening(_opts) {
			if (recorder) throw new SpeechEngineError('TRANSCRIBE_FAILED', 'Already listening');
			const { createMicRecorder } = await import('../mic.js');
			recorder = await createMicRecorder();
			await recorder.start();
		},

		async stopListening(): Promise<string> {
			const current = recorder;
			recorder = null;
			if (!current) return '';
			const blob = await current.stop();
			const decoded = await decodeToMono16k(blob);
			const result = await this.transcribe(decoded.samples, decoded.sampleRate);
			return result.text;
		},

		async transcribe(audio, sampleRate, opts): Promise<SttResult> {
			if (sampleRate !== TARGET_SAMPLE_RATE) {
				throw new SpeechEngineError('TRANSCRIBE_FAILED', `Expected ${TARGET_SAMPLE_RATE} Hz audio, got ${sampleRate}`);
			}
			const durationMs = Math.round((audio.length / sampleRate) * 1000);
			if (durationMs > DURATION_MAX_MS) {
				throw new SpeechEngineError(
					'AUDIO_TOO_LONG',
					`Audio is longer than ${Math.round(DURATION_MAX_MS / 60000)} minutes`
				);
			}
			const { pipe, def } = await pipelineFor(null);
			const chunks = chunkAudio(audio, sampleRate);
			const segments: SttResult['segments'] = [];
			let text = '';
			for (let i = 0; i < chunks.length; i++) {
				if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Transcription cancelled');
				const chunk = chunks[i]!;
				const out = await pipe(chunk.samples, {
					return_timestamps: true,
					...(def.repo.includes('whisper') && opts?.language && opts.language !== 'auto'
						? { language: opts.language, task: 'transcribe' }
						: {})
				});
				const offsetSec = chunk.startMs / 1000;
				for (const c of out.chunks ?? []) {
					const [start, end] = c.timestamp;
					segments.push({
						text: c.text.trim(),
						start: start != null ? start + offsetSec : undefined,
						end: end != null ? end + offsetSec : undefined
					});
				}
				text += (text ? ' ' : '') + out.text.trim();
				opts?.onProgress?.({ doneChunks: i + 1, chunks: chunks.length });
			}
			return {
				text: text.trim(),
				segments,
				language: opts?.language !== 'auto' ? opts?.language : undefined,
				durationMs,
				engineId: 'transformers',
				modelId: def.id
			};
		}
	};
}

export const transformersStt: SttEngine = createTransformersStt();