/**
 * Piper TTS via @mintplex-labs/piper-tts-web. Voice files (.onnx + .onnx.json)
 * are user-imported into the VFS; before synthesis they are mirrored into the
 * library's own OPFS cache (`piper/<basename>`) so `predict()` never fetches —
 * HF fetches are blocked under the hub's COEP isolation, and the library's
 * `writeBlob` is not exported, so we write the same layout ourselves.
 *
 * The library keeps one session per page and reuses it even when `voiceId`
 * changes (the reused instance keeps the first voice's model), so a voice
 * switch resets that singleton and creates a fresh session.
 */

import {
	SpeechEngineError,
	type ModelDownloadProgress,
	type TtsEngine,
	type TtsEngineInfo,
	type TtsRender,
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
import { SegmentPlayer, splitSentences } from './playback.js';

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

type PiperSession = { predict: (text: string) => Promise<Blob>; voiceId: string };

let session: PiperSession | null = null;
let sessionVoiceId: string | null = null;

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

async function sessionFor(voiceId: string): Promise<PiperSession> {
	if (session && sessionVoiceId === voiceId) return session;
	const lib = await import('@mintplex-labs/piper-tts-web');
	// The library's session is a page-wide singleton that ignores a changed
	// voiceId on reuse — reset it so each voice loads its own model.
	(lib.TtsSession as unknown as { _instance: unknown })._instance = null;
	session = (await lib.TtsSession.create({ voiceId })) as unknown as PiperSession;
	sessionVoiceId = voiceId;
	return session;
}

export function createPiperTts(): TtsEngine {
	const player = new SegmentPlayer();
	let selectedDirId: string | undefined;

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
			for (const sentence of splitSentences(text)) {
				if (opts?.signal?.aborted) throw new SpeechEngineError('CANCELLED', 'Synthesis cancelled');
				const wav = await (await sessionFor(voiceId)).predict(sentence);
				const decoded = await decodeMono(wav);
				segments.push({
					samples: decoded.samples,
					sampleRate: decoded.sampleRate,
					text: sentence
				});
			}
			return { segments, channels: 1 };
		},

		async speak(text, opts) {
			const render = await this.synthesize(text, { voice: opts?.voice, signal: opts?.signal });
			await player.play(render, { signal: opts?.signal });
		},

		stop() {
			player.stop();
		}
	};
}

export const piperTts: TtsEngine = createPiperTts();