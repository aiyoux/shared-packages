/**
 * NovaSR in the browser (onnxruntime-web, WASM): 16 kHz mono speech → 48 kHz,
 * the browser location of the `audio-upsampling` task (tools AI integration
 * plan, Phase 5 item 2).
 *
 * NovaSR (Apache-2.0) is one ~229 KB time-domain graph: `[1, 1, T]` at 16 kHz
 * in, `[1, 1, 3T]` at 48 kHz out, no spectral front end — the same ONNX
 * artifact the monitor's `audiosronnx` engine runs, pinned to the same
 * revision.
 *
 * Up to a minute runs as one pass, numerically close to `audiosronnx`
 * (measured 2026-09-30: max |Δ| 5e-7 against the Python engine). Longer audio
 * runs in one-minute chunks with padding, each keeping its centre, so WASM
 * never holds one huge tensor. The graph is not purely local (its output
 * depends slightly on the whole input it sees), so a chunked result differs
 * from one pass by up to ~2% of peak (−33 dB) — measured on a 45 s speech-band
 * test signal with 20 s chunks; perceptual quality is not verified. The graph also
 * returns 4 samples fewer than 3×, so the result is as long as what it wrote.
 */

import { createWorkerRpc, type WorkerRpc } from './workerRpc.js';
import { loadNovasrModel, novasrModelRevision } from './novasrModel.js';
export { NOVASR_MODEL_URL } from './novasrModel.js';
export { novasrChunks, NOVASR_IN_RATE, NOVASR_OUT_RATE } from './novasrInference.js';

let worker: WorkerRpc | null = null;
let loading: Promise<void> | null = null;
let loadedRevision: string | null = null;
let loadController: AbortController | null = null;
let epoch = 0;
let tail: Promise<unknown> = Promise.resolve();

function bridge(): WorkerRpc {
	return worker ??= createWorkerRpc(
		() => new Worker(new URL('./novasr.worker.ts', import.meta.url), { type: 'module', name: 'novasr' }),
		'NovaSR', () => { loading = null; }
	);
}

/** Cancel model loads and terminate the worker, freeing its ORT session and WASM heap. */
export function disposeNovasr(): void {
	epoch++;
	loadController?.abort(new DOMException('NovaSR stopped', 'AbortError'));
	loadController = null;
	loading = null;
	worker?.reset();
	// Keep the bridge so its reset registration is not leaked on every run.
}

/** Stop waiting on storage/import work as soon as the host aborts. */
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener('abort', aborted, { once: true });
		if (signal.aborted) aborted();
		task.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
	});
}

async function load(signal?: AbortSignal): Promise<void> {
	const controller = new AbortController();
	loadController = controller;
	try {
		signal?.throwIfAborted();
		const revision = await abortable(novasrModelRevision(controller.signal), controller.signal);
		controller.signal.throwIfAborted();
		if (loading && loadedRevision === revision) return await loading;
		if (loadedRevision !== revision) { loading = null; worker?.reset(); }
		loadedRevision = revision;
		const pending = abortable((async () => {
			const model = await loadNovasrModel(controller.signal);
			controller.signal.throwIfAborted();
			await bridge().call('load', { model }, [model.buffer]);
			controller.signal.throwIfAborted();
		})(), controller.signal);
		loading = pending;
		void pending.catch(() => { if (loading === pending) loading = null; });
		return await pending;
	} finally {
		if (loadController === controller) loadController = null;
	}
}

/** Upsample in the host's cached worker. Concurrent calls are serialized. */
export async function novasrUpsample(
	samples16k: Float32Array,
	opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<Float32Array> {
	opts.signal?.throwIfAborted();
	if (!samples16k.length) return new Float32Array();
	const submittedEpoch = epoch;
	const task = tail.catch(() => {}).then(async () => {
		opts.signal?.throwIfAborted();
		if (submittedEpoch !== epoch) throw new DOMException('NovaSR stopped', 'AbortError');
		const aborted = () => disposeNovasr();
		opts.signal?.addEventListener('abort', aborted, { once: true });
		try {
			await load(opts.signal);
			opts.signal?.throwIfAborted();
			if (submittedEpoch !== epoch) throw new DOMException('NovaSR stopped', 'AbortError');
			// Transfer a copy: callers keep ownership of their decoded input.
			const samples = samples16k.slice();
			const result = await bridge().call<Float32Array>('upsample', { samples }, [samples.buffer], (value) => {
				if (submittedEpoch !== epoch || opts.signal?.aborted) return;
				const progress = value as { done: number; total: number };
				opts.onProgress?.(progress.done, progress.total);
			});
			opts.signal?.throwIfAborted();
			if (submittedEpoch !== epoch) throw new DOMException('NovaSR stopped', 'AbortError');
			return result;
		} catch (error) {
			opts.signal?.throwIfAborted();
			if (submittedEpoch !== epoch) throw new DOMException('NovaSR stopped', 'AbortError');
			// A failed worker load/run may have left an unusable ORT session.
			loading = null;
			worker?.reset();
			throw error;
		} finally {
			opts.signal?.removeEventListener('abort', aborted);
		}
	});
	tail = task;
	return opts.signal ? abortable(task, opts.signal) : task;
}
