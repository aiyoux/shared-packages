/// <reference lib="webworker" />
/** A dedicated worker makes cancellation terminate WASM inference immediately. */
import { serveWorkerRpc } from './workerRpc.js';
import { runNovasrChunks, type NovaSrOrt, type NovaSrSession } from './novasrInference.js';

let ort: NovaSrOrt | null = null;
let session: NovaSrSession | null = null;

serveWorkerRpc({
	async load(payload) {
		const runtime = await import('onnxruntime-web') as unknown as NovaSrOrt;
		runtime.env.wasm.wasmPaths = '/vendor/ort/';
		runtime.env.wasm.numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? 2 : 1;
		runtime.env.wasm.proxy = false;
		const loaded = await runtime.InferenceSession.create(payload.model as Uint8Array, {
			executionProviders: ['wasm']
		});
		ort = runtime;
		session = loaded;
		return { result: true };
	},
	async upsample(payload, progress) {
		if (!ort || !session) throw new Error('NovaSR is not loaded');
		const result = await runNovasrChunks(payload.samples as Float32Array, ort, session,
			(done, total) => progress({ done, total }));
		return { result, transfer: [result.buffer] };
	}
});
