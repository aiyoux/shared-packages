import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeNovasr, novasrUpsample, novasrChunks, NOVASR_IN_RATE } from './novasr.js';
import { runNovasrChunks, type NovaSrOrt, type NovaSrSession, type NovaSrTensor } from './novasrInference.js';
const model = vi.hoisted(() => vi.fn());
vi.mock('./novasrModel.js', () => ({ loadNovasrModel: model, NOVASR_MODEL_URL: 'pinned-model' }));

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminated = false;
	requests: Array<{ id: number; op: string; samples?: Float32Array }> = [];
	constructor() { FakeWorker.instances.push(this); }
	postMessage(request: { id: number; op: string; samples?: Float32Array }) {
		this.requests.push(request);
		if (request.op === 'load') queueMicrotask(() => this.reply(request.id, true));
	}
	terminate() { this.terminated = true; }
	reply(id: number, result: unknown) { this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent); }
	progress(id: number) { this.onmessage?.({ data: { id, progress: { done: 1, total: 1 } } } as MessageEvent); }
}

beforeEach(() => {
	disposeNovasr();
	FakeWorker.instances = [];
	vi.stubGlobal('Worker', FakeWorker);
	model.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});
afterEach(() => { disposeNovasr(); vi.unstubAllGlobals(); });

describe('novasrChunks', () => {
	it('runs a minute or less as one pass keeping everything', () => {
		const n = 60 * NOVASR_IN_RATE;
		expect(novasrChunks(n)).toEqual([{ from: 0, to: n, keepFrom: 0, keepTo: 3 * n }]);
	});

	it('keeps contiguous, non-overlapping output spans that cover the whole input', () => {
		const n = 150 * NOVASR_IN_RATE + 123;
		const plan = novasrChunks(n);
		expect(plan).toHaveLength(3);
		let covered = 0;
		for (const part of plan) {
			// Each run sees context beyond what it keeps, except at the ends.
			expect(part.from).toBeLessThanOrEqual(covered / 3);
			const keptStartInput = part.from + part.keepFrom / 3;
			expect(keptStartInput).toBe(covered / 3);
			covered += part.keepTo - part.keepFrom;
		}
		expect(covered).toBe(3 * n);
		expect(plan[1]!.from).toBeLessThan(60 * NOVASR_IN_RATE);
		expect(plan.at(-1)!.to).toBe(n);
	});
});

// Exercise the real bridge and engine lifecycle, with only the worker boundary
// and VFS/network model acquisition replaced.


describe('NovaSR lifecycle', () => {
	it('rejects a pre-aborted run before acquiring weights or a worker', async () => {
		const signal = AbortSignal.abort(new DOMException('Cancelled', 'AbortError'));
		await expect(novasrUpsample(new Float32Array(8), { signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(model).not.toHaveBeenCalled();
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it('aborts a pending model load immediately, fences late completion, and retries', async () => {
		let finish!: (value: Uint8Array) => void;
		model.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { finish = resolve; }));
		const controller = new AbortController();
		const pending = novasrUpsample(new Float32Array(8), { signal: controller.signal });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
		const loadSignal = model.mock.calls[0]![0] as AbortSignal;
		controller.abort(new DOMException('Cancelled', 'AbortError'));
		await rejected;
		expect(loadSignal.aborted).toBe(true);
		const retried = novasrUpsample(new Float32Array(8));
		await vi.waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(2));
		finish(new Uint8Array([9]));
		const worker = FakeWorker.instances[0]!;
		worker.reply(worker.requests[1]!.id, new Float32Array([4, 5]));
		expect(Array.from(await retried)).toEqual([4, 5]);
		expect(model).toHaveBeenCalledTimes(2);
		expect(worker.requests.map((r) => r.op)).toEqual(['load', 'upsample']);
	});

	it('terminates an in-flight worker on handover and ignores its stale progress and result', async () => {
		const progress = vi.fn();
		const pending = novasrUpsample(new Float32Array(8), { onProgress: progress });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(2));
		const stale = FakeWorker.instances[0]!;
		disposeNovasr();
		await rejected;
		expect(stale.terminated).toBe(true);
		const retried = novasrUpsample(new Float32Array(8));
		await vi.waitFor(() => expect(FakeWorker.instances[1]?.requests).toHaveLength(2));
		stale.progress(stale.requests[1]!.id);
		stale.reply(stale.requests[1]!.id, new Float32Array([99]));
		expect(progress).not.toHaveBeenCalled();
		const fresh = FakeWorker.instances[1]!;
		fresh.reply(fresh.requests[1]!.id, new Float32Array([6]));
		expect(Array.from(await retried)).toEqual([6]);
	});

	it('aborting inference terminates CPU work and a new run reloads the worker', async () => {
		const controller = new AbortController();
		const pending = novasrUpsample(new Float32Array(8), { signal: controller.signal });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(2));
		controller.abort(new DOMException('Cancelled', 'AbortError'));
		await rejected;
		expect(FakeWorker.instances[0]!.terminated).toBe(true);
		const next = novasrUpsample(new Float32Array(8));
		await vi.waitFor(() => expect(FakeWorker.instances[1]?.requests).toHaveLength(2));
		const worker = FakeWorker.instances[1]!;
		worker.reply(worker.requests[1]!.id, new Float32Array([7]));
		expect(Array.from(await next)).toEqual([7]);
	});

	it('serializes runs, reuses a loaded worker, and preserves caller input', async () => {
		const input = new Float32Array([1, 2, 3]);
		const first = novasrUpsample(input);
		const second = novasrUpsample(input);
		await vi.waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(2));
		const worker = FakeWorker.instances[0]!;
		expect(worker.requests[1]!.samples).not.toBe(input);
		worker.reply(worker.requests[1]!.id, new Float32Array([4]));
		await first;
		await vi.waitFor(() => expect(worker.requests).toHaveLength(3));
		worker.reply(worker.requests[2]!.id, new Float32Array([5]));
		await expect(second).resolves.toEqual(new Float32Array([5]));
		expect(model).toHaveBeenCalledTimes(1);
		expect(Array.from(input)).toEqual([1, 2, 3]);
	});

	it('retries after a failed model acquisition', async () => {
		model.mockRejectedValueOnce(new Error('Offline'));
		await expect(novasrUpsample(new Float32Array(8))).rejects.toThrow('Offline');
		const next = novasrUpsample(new Float32Array(8));
		await vi.waitFor(() => expect(FakeWorker.instances[0]?.requests).toHaveLength(2));
		const worker = FakeWorker.instances[0]!;
		worker.reply(worker.requests[1]!.id, new Float32Array([8]));
		await expect(next).resolves.toEqual(new Float32Array([8]));
		expect(model).toHaveBeenCalledTimes(2);
	});
});

class TestTensor implements NovaSrTensor {
	dispose = vi.fn();
	constructor(_type: 'float32', readonly data: Float32Array, readonly dims: readonly number[]) {}
}

describe('NovaSR worker chunk assembly', () => {
	it('discards padded context and keeps the graph’s final short output without zero padding', async () => {
		const length = 60 * NOVASR_IN_RATE + 10;
		const input = Float32Array.from({ length }, (_, i) => i);
		const tensors: TestTensor[] = [];
		const session: NovaSrSession = {
			inputNames: ['audio'], outputNames: ['output'],
			async run(feeds) {
				const tensor = feeds.audio!;
				// A deterministic fake graph returns 3x input minus the four
				// samples NovaSR itself omits; values encode global positions.
				const output = new TestTensor('float32', Float32Array.from(
					{ length: tensor.data.length * 3 - 4 },
					(_, i) => tensor.data[0]! * 3 + i
				), [1, 1, tensor.data.length * 3 - 4]);
				tensors.push(tensor as TestTensor, output);
				return { output };
			}
		};
		const progress = vi.fn();
		const out = await runNovasrChunks(input, { Tensor: TestTensor } as unknown as NovaSrOrt, session, progress);
		expect(out).toHaveLength(length * 3 - 4);
		const boundary = 60 * NOVASR_IN_RATE * 3;
		expect(Array.from(out.subarray(boundary - 2, boundary + 3))).toEqual([
			boundary - 2, boundary - 1, boundary, boundary + 1, boundary + 2
		]);
		expect(out.at(-1)).toBe(length * 3 - 5);
		expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
		for (const tensor of tensors) expect(tensor.dispose).toHaveBeenCalledOnce();
	});

	it('frees the input tensor when inference fails', async () => {
		const disposed = vi.fn();
		class Tensor extends TestTensor { dispose = disposed; }
		const session: NovaSrSession = { inputNames: ['x'], outputNames: ['y'], run: async () => { throw new Error('Inference failed'); } };
		await expect(runNovasrChunks(new Float32Array(8), { Tensor } as unknown as NovaSrOrt, session)).rejects.toThrow('Inference failed');
		expect(disposed).toHaveBeenCalledOnce();
	});
});
