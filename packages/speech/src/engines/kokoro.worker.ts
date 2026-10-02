/// <reference lib="webworker" />
/**
 * Kokoro inference worker: kokoro-js + transformers.js (ORT wasm or WebGPU)
 * off the page's main thread. The page reads the model files and voice bins
 * out of the browser model store and hands them over; transformers.js reads
 * the model through a custom cache, and kokoro-js's own voice fetch is served
 * from the handed-over bins, so nothing is fetched or copied elsewhere.
 */

import { configureTransformersEnv } from './transformersEnv.js';
import { serveWorkerRpc } from './workerRpc.js';

type RawAudio = { audio: Float32Array; sampling_rate: number };
type KokoroTts = {
	generate: (text: string, opts?: { voice?: string; speed?: number }) => Promise<RawAudio>;
};

let tts: KokoroTts | null = null;
const voices = new Map<string, ArrayBuffer>();

/**
 * kokoro-js reads a voice from the 'kokoro-voices' Cache Storage or fetches
 * it from huggingface.co and stores a copy there. In this worker the store
 * is the only source: its cache never matches and never keeps a copy, and its
 * voice fetch is answered from the bins the page sent.
 */
const VOICE_URL = /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/[^/]+\/voices\/([a-z_]+)\.bin$/;
Object.defineProperty(self, 'caches', {
	configurable: true,
	value: { open: async () => ({ match: async () => undefined, put: async () => {} }) }
});
const networkFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const voice = VOICE_URL.exec(url)?.[1];
	if (voice) {
		const bytes = voices.get(voice);
		if (!bytes) return new Response(null, { status: 404, statusText: `Voice ${voice} is not loaded` });
		return new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } });
	}
	return networkFetch(input, init);
};

/** Serves the handed-over model files; a miss is a cache miss, never a fetch. */
function blobCache(repo: string, files: Map<string, Blob>) {
	const prefix = `https://huggingface.co/${repo}/resolve/`;
	return {
		async match(request: Request | string | URL): Promise<Response | undefined> {
			const url = typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
			const rest = url.startsWith(prefix) ? url.slice(prefix.length) : '';
			const blob = rest.includes('/') ? files.get(decodeURIComponent(rest.slice(rest.indexOf('/') + 1))) : undefined;
			if (!blob) return undefined;
			return new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
		},
		async put(): Promise<void> {
			throw new Error('Engines cannot write model weights; load files in Settings → AI models.');
		}
	};
}

/** Size, readability and leading bytes of each handed-over file. */
async function describeFiles(files: Map<string, Blob>): Promise<string> {
	const parts: string[] = [];
	for (const [path, blob] of files) {
		try {
			const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
			const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
			parts.push(`${path}: ${blob.size} B, starts ${hex || '(nothing)'}`);
		} catch (readErr) {
			parts.push(`${path}: ${blob.size} B, unreadable (${readErr instanceof Error ? readErr.name : String(readErr)})`);
		}
	}
	return parts.join('; ');
}

serveWorkerRpc({
	async load(payload) {
		const { repo, dtype, device, files } = payload as {
			repo: string;
			dtype: string;
			device: 'wasm' | 'webgpu';
			files: Record<string, Blob | ArrayBuffer>;
		};
		tts = null;
		const fileMap = new Map(
			Object.entries(files).map(([path, value]) => [path, value instanceof Blob ? value : new Blob([value])])
		);
		const mod = await import('@huggingface/transformers');
		configureTransformersEnv(
			mod as unknown as Parameters<typeof configureTransformersEnv>[0],
			blobCache(repo, fileMap) as never
		);
		const { KokoroTTS } = await import('kokoro-js');
		try {
			tts = (await KokoroTTS.from_pretrained(repo, {
				dtype: dtype as 'fp32',
				device
			})) as unknown as KokoroTts;
		} catch (err) {
			// Failure path only: say what the worker actually held, so a
			// runtime error ("no graph was found in the protobuf") can be told
			// apart from a file that never arrived intact.
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`${message} [${device}/${dtype}; ${await describeFiles(fileMap)}]`);
		}
		// The session holds the weights now; let the handed-over Blobs go.
		fileMap.clear();
		return { result: null };
	},

	async voice(payload) {
		const { voice, bytes } = payload as { voice: string; bytes: ArrayBuffer };
		voices.set(voice, bytes);
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
