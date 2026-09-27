/// <reference lib="webworker" />
/**
 * Kokoro inference worker: kokoro-js + transformers.js (ORT wasm or WebGPU)
 * off the page's main thread. The page reads the model files out of the VFS
 * and hands them over as Blobs; transformers.js reads them through a custom
 * cache, so nothing is fetched. Voice bins come from the origin-wide
 * 'kokoro-voices' Cache Storage, which the page seeds before generating.
 */

import { configureTransformersEnv } from './transformersEnv.js';
import { repoPathFromUrl } from './transformersVfsCache.js';
import { serveWorkerRpc } from './workerRpc.js';

type RawAudio = { audio: Float32Array; sampling_rate: number };
type KokoroTts = {
	generate: (text: string, opts?: { voice?: string; speed?: number }) => Promise<RawAudio>;
};

let tts: KokoroTts | null = null;

/** Serves the handed-over model files; a miss returns undefined (library fetches). */
function blobCache(repo: string, files: Map<string, Blob>) {
	return {
		async match(request: Request | string | URL): Promise<Response | undefined> {
			const url = typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
			const path = repoPathFromUrl(url, repo);
			const blob = path ? files.get(path) : undefined;
			if (!blob) return undefined;
			return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
		},
		async put(): Promise<void> {
			// Read-only: every file the model needs was handed over up front.
		}
	};
}

serveWorkerRpc({
	async load(payload) {
		const { repo, dtype, device, files } = payload as {
			repo: string;
			dtype: string;
			device: 'wasm' | 'webgpu';
			files: Record<string, Blob>;
		};
		tts = null;
		const fileMap = new Map(Object.entries(files));
		const mod = await import('@huggingface/transformers');
		configureTransformersEnv(
			mod as unknown as Parameters<typeof configureTransformersEnv>[0],
			blobCache(repo, fileMap)
		);
		const { KokoroTTS } = await import('kokoro-js');
		tts = (await KokoroTTS.from_pretrained(repo, {
			dtype: dtype as 'fp32',
			device
		})) as unknown as KokoroTts;
		// The session holds the weights now; let the handed-over Blobs go.
		fileMap.clear();
		return { result: null };
	},

	async generate(payload) {
		const { text, voice, speed } = payload as { text: string; voice: string; speed?: number };
		if (!tts) throw new Error('Kokoro model is not loaded');
		const audio = await tts.generate(text, { voice, speed });
		// Own copy: the output may be a view on ORT memory, which must not be
		// detached (or, when shared, cannot be transferred at all).
		const samples = audio.audio.slice();
		return {
			result: { samples, sampleRate: audio.sampling_rate },
			transfer: [samples.buffer]
		};
	}
});
