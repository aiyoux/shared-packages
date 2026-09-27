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
			blobCache(repo, fileMap)
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
