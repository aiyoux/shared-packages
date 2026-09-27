/// <reference lib="webworker" />
/**
 * Piper inference worker: @mintplex-labs/piper-tts-web (phonemize wasm + ORT)
 * off the page's main thread. The page mirrors the voice pair into the
 * library's OPFS cache first, so the session reads it locally; the rendered
 * WAV Blob goes back to the page, which decodes it (no OfflineAudioContext
 * in workers).
 *
 * The library keeps one session per realm and reuses it even when `voiceId`
 * changes (the reused instance keeps the first voice's model), so a voice
 * switch resets that singleton and creates a fresh session.
 */

import { serveWorkerRpc } from './workerRpc.js';

type PiperSession = { predict: (text: string) => Promise<Blob>; voiceId: string };

let session: PiperSession | null = null;
let sessionVoiceId: string | null = null;

async function sessionFor(voiceId: string): Promise<PiperSession> {
	if (session && sessionVoiceId === voiceId) return session;
	const lib = await import('@mintplex-labs/piper-tts-web');
	// The library's session is a realm-wide singleton that ignores a changed
	// voiceId on reuse — reset it so each voice loads its own model.
	(lib.TtsSession as unknown as { _instance: unknown })._instance = null;
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
	sessionVoiceId = voiceId;
	return session;
}

serveWorkerRpc({
	async generate(payload) {
		const { voiceId, text } = payload as { voiceId: string; text: string };
		const wav = await (await sessionFor(voiceId)).predict(text);
		return { result: wav };
	}
});
