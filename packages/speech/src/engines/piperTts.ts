/**
 * Piper TTS via @mintplex-labs/piper-tts-web. Voice files (.onnx + .onnx.json)
 * are user-imported into the VFS; before synthesis they are mirrored into the
 * library's own OPFS cache (`piper/<basename>`) so `predict()` never fetches —
 * HF fetches are blocked under the hub's COEP isolation, and the library's
 * `writeBlob` is not exported, so we write the same layout ourselves.
 *
 * Inference runs in a dedicated worker (piper.worker.ts), so rendering never
 * blocks the page; the mirror, WAV decode and playback stay here.
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
import { decodeMono } from '../audio.js';
import { storedName } from '../modelStore.manifest.js';
import { getSpeechModelStore } from '../modelStore.js';
import {
	piperConfigPath,
	piperVoice,
	piperVoiceDef,
	piperVoiceList,
	DEFAULT_PIPER_VOICE,
	type PiperVoice
} from '../piperVoices.js';
import { SegmentPlayer, splitSentences, streamSentences } from './playback.js';
import { createWorkerRpc } from './workerRpc.js';

const info: TtsEngineInfo = {
	id: 'piper',
	label: 'Piper (local)',
	description:
		'Fast neural voices from the Piper catalog — 100+ language variants, exports WAV. Import a voice pair (.onnx + .onnx.json) into Files, then pick it.',
	livePlayback: true,
	renderToBuffer: true,
	exportFormats: ['wav'],
	voices: 'model',
	supportsSpeed: false
};

/* --- OPFS mirror (same layout the library's internal cache reads) --- */

async function opfsDir(): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle('piper', { create: true });
}

async function opfsHas(name: string, bytes?: number): Promise<boolean> {
	try {
		const dir = await opfsDir();
		const file = await (await dir.getFileHandle(name)).getFile();
		return bytes == null || file.size === bytes;
	} catch {
		return false;
	}
}

async function opfsWrite(name: string, blob: Blob): Promise<void> {
	const dir = await opfsDir();
	const handle = await dir.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(blob);
	await writable.close();
}

/**
 * Copy a voice's two VFS files into the library's OPFS cache so
 * `predict()` reads them locally instead of fetching from HF.
 */
async function ensureVoiceMirrored(voice: PiperVoice, dirId?: string): Promise<void> {
	const store = await getSpeechModelStore();
	// requireModelDir throws NO_MODEL with download links when files are absent.
	const dir = await store.requireModelDir(piperVoiceDef(voice.id), dirId);
	const pairs = [
		{ name: storedName(voice.path), blob: await store.readBlobPath(dir, voice.path) },
		{ name: storedName(piperConfigPath(voice)), blob: await store.readBlobPath(dir, piperConfigPath(voice)) }
	];
	for (const { name, blob } of pairs) {
		if (!(await opfsHas(name, blob.size))) await opfsWrite(name, blob);
	}
}

export function createPiperTts(): TtsEngine {
	const player = new SegmentPlayer();
	let selectedDirId: string | undefined;
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
			selectedDirId = opts?.dirId;
			const voiceId = opts?.modelId?.startsWith('piper-')
				? opts.modelId.slice('piper-'.length)
				: undefined;
			if (voiceId) {
				const store = await getSpeechModelStore();
				await store.requireModelDir(piperVoiceDef(voiceId), opts?.dirId);
			}
		},

		async listVoices(): Promise<TtsVoice[]> {
			return piperVoiceList();
		},

		async synthesize(text, opts): Promise<TtsRender> {
			const voiceId = opts?.voice ?? DEFAULT_PIPER_VOICE;
			const voice = piperVoice(voiceId);
			await ensureVoiceMirrored(voice, opts?.dirId ?? selectedDirId);
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
			await ensureVoiceMirrored(piperVoice(voiceId), selectedDirId);
			await streamSentences(text, (sentence) => renderSentence(voiceId, sentence), player, opts);
		},

		stop() {
			player.stop();
		}
	};
}

export const piperTts: TtsEngine = createPiperTts();
