/// <reference lib="webworker" />
/**
 * Piper inference worker: @mintplex-labs/piper-tts-web (phonemize wasm + ORT)
 * off the page's main thread. Voice files come only from the browser model
 * store; the rendered WAV Blob goes back to the page, which decodes it (no
 * OfflineAudioContext in workers).
 *
 * The library keeps one session per realm and reuses it even when `voiceId`
 * changes (the reused instance keeps the first voice's model), so a voice
 * switch resets that singleton and creates a fresh session.
 */

import { createModelStore } from '@shared-packages/model-store';
import { piperConfigPath, piperVoice, piperVoiceModel } from '../piperVoices.js';
import { serveWorkerRpc } from './workerRpc.js';

type PiperSession = { predict: (text: string) => Promise<Blob>; voiceId: string };

/**
 * The library reads voices from its own OPFS folder (`piper/<basename>`) and
 * otherwise downloads them and keeps a copy there. In this worker that folder
 * is a view of the store snapshot being loaded: reads see only the selected
 * voice's stored files, and the library's copy is discarded.
 */
const opfs = navigator.storage.getDirectory.bind(navigator.storage);
const store = createModelStore({ opfs });
const held = new Map<string, File>();
const piperFolder = {
	async getFileHandle(name: string, options?: { create?: boolean }) {
		const file = held.get(name);
		if (file) return { getFile: async () => file };
		if (options?.create) return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
		throw new DOMException(`${name} is not loaded`, 'NotFoundError');
	}
};
Object.defineProperty(navigator.storage, 'getDirectory', {
	configurable: true,
	value: async () => {
		const root = await opfs();
		return {
			getDirectoryHandle: (name: string, options?: FileSystemGetDirectoryOptions) =>
				name === 'piper' ? Promise.resolve(piperFolder) : root.getDirectoryHandle(name, options)
		};
	}
});
const networkFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	if (url.startsWith('https://huggingface.co/')) return new Response(null, { status: 404, statusText: 'Voice files load in Settings → AI models' });
	return networkFetch(input, init);
};

let session: PiperSession | null = null;
let sessionKey: string | null = null;

async function sessionFor(voiceId: string): Promise<PiperSession> {
	const voice = piperVoice(voiceId);
	return store.readReady(piperVoiceModel(voiceId), async (snapshot) => {
		const key = `${voiceId}|${snapshot.manifest.revision}`;
		if (session && sessionKey === key) return session;
		const lib = await import('@mintplex-labs/piper-tts-web');
		// The library's session is a realm-wide singleton that ignores a changed
		// voiceId on reuse — reset it so each voice loads its own model.
		(lib.TtsSession as unknown as { _instance: unknown })._instance = null;
		for (const path of [voice.path, piperConfigPath(voice)]) held.set(path.split('/').at(-1)!, await snapshot.file(path));
		try {
			session = (await lib.TtsSession.create({
				voiceId,
				// The lib's ORT (1.30) fetches its glue+wasm from this base — the
				// vendored pair, since the lib's cdnjs default names files cdnjs does
				// not host for the version this ORT requests (404 → blob fallback →
				// CSP block). piperData/piperWasm keep the lib's jsdelivr defaults.
				wasmPaths: {
					onnxWasm: '/vendor/ort-piper/',
					piperData: lib.TtsSession.WASM_LOCATIONS.piperData,
					piperWasm: lib.TtsSession.WASM_LOCATIONS.piperWasm
				}
			}) as unknown as PiperSession);
		} finally {
			held.clear();
		}
		sessionKey = key;
		return session;
	});
}

serveWorkerRpc({
	async generate(payload) {
		const { voiceId, text } = payload as { voiceId: string; text: string };
		const wav = await (await sessionFor(voiceId)).predict(text);
		return { result: wav };
	}
});
