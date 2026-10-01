import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ create: vi.fn(), tokens: [49406, 320, 49407, ...Array(74).fill(0)] as number[] }));
vi.mock('onnxruntime-web/webgpu', () => ({
	env: { wasm: {} },
	InferenceSession: { create: mock.create },
	Tensor: class {
		constructor(public type: string, public data: Int32Array | BigInt64Array | Float32Array, public dims: number[]) {}
	}
}));
vi.mock('./sdTokenizer.js', () => ({ createSdTokenizer: () => ({}), encodeSdPrompt: () => mock.tokens }));

type FeedTensor = { type: string; data: Int32Array | BigInt64Array | Float32Array; dims: number[] };
type Reply = { id: number; ok: boolean; result?: { width: number; height: number; seed: number; rgba: ArrayBuffer }; message?: string };
const contracts = [
	{ id: 'sdxs-dreamshaper', flat: true, ids: 'int64', timestep: 'float32', hidden: 768, decoderInput: 'latent', decoderOutput: 'image' },
	{ id: 'sd-turbo', flat: false, ids: 'int32', timestep: 'int64', hidden: 1024, decoderInput: 'latent_sample', decoderOutput: 'sample' }
] as const;

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); mock.create.mockReset(); });

describe('SD worker graph contracts (verified ONNX input/output types and shapes)', () => {
	it.each(contracts)('$id runs all three graphs using its exported tensor contract', async (contract) => {
		const worker = { onmessage: null as ((event: { data: unknown }) => void) | null };
		const pending = new Map<number, (reply: Reply) => void>();
		vi.stubGlobal('self', worker);
		vi.stubGlobal('postMessage', (reply: Reply) => { pending.get(reply.id)?.(reply); pending.delete(reply.id); });
		const encoded = { type: 'float32', data: new Float32Array(77 * contract.hidden), dims: [1, 77, contract.hidden] };
		const text = vi.fn(async (feeds: Record<string, FeedTensor>) => {
			expect(Object.keys(feeds)).toEqual(['input_ids']);
			expect(feeds.input_ids.type).toBe(contract.ids);
			expect(feeds.input_ids.dims).toEqual([1, 77]);
			expect(feeds.input_ids.data).toBeInstanceOf(contract.ids === 'int64' ? BigInt64Array : Int32Array);
			expect(Array.from(feeds.input_ids.data, Number)).toEqual(mock.tokens);
			return { last_hidden_state: encoded };
		});
		const unet = vi.fn(async (feeds: Record<string, FeedTensor>) => {
			expect(Object.keys(feeds).sort()).toEqual(['encoder_hidden_states', 'sample', 'timestep']);
			expect(feeds.sample.type).toBe('float32');
			expect(feeds.sample.dims).toEqual([1, 4, 64, 64]);
			expect(feeds.sample.data).toHaveLength(4 * 64 * 64);
			expect(feeds.timestep.type).toBe(contract.timestep);
			expect(feeds.timestep.dims).toEqual([1]);
			expect(feeds.timestep.data).toBeInstanceOf(contract.timestep === 'float32' ? Float32Array : BigInt64Array);
			expect(Number(feeds.timestep.data[0])).toBe(999);
			expect(feeds.encoder_hidden_states).toBe(encoded);
			return { out_sample: { data: new Float32Array(4 * 64 * 64) } };
		});
		const decoder = vi.fn(async (feeds: Record<string, FeedTensor>) => {
			expect(Object.keys(feeds)).toEqual([contract.decoderInput]);
			expect(feeds[contract.decoderInput].type).toBe('float32');
			expect(feeds[contract.decoderInput].dims).toEqual([1, 4, 64, 64]);
			return { [contract.decoderOutput]: { data: new Float32Array(3 * 512 * 512) } };
		});
		for (const run of [text, unet, decoder]) mock.create.mockResolvedValueOnce({ run, release: vi.fn() });
		await import('./sd.worker.js');
		let nextId = 0;
		async function call(op: string, payload: Record<string, unknown>) {
			const id = ++nextId;
			const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
			worker.onmessage!({ data: { id, op, payload } });
			return reply;
		}
		const files = ['text_encoder', 'unet', 'vae_decoder'].map((stem) => ({
			path: contract.flat ? `${stem}.onnx` : `${stem}/model.onnx`, buffer: new ArrayBuffer(1)
		}));
		expect(await call('load', { modelId: contract.id, files })).toMatchObject({ ok: true });
		const reply = await call('generate', { prompt: 'a drawing', seed: 42 });
		expect(reply.ok, reply.message).toBe(true);
		expect(reply.result).toMatchObject({ width: 512, height: 512, seed: 42 });
		expect(reply.result!.rgba.byteLength).toBe(512 * 512 * 4);
		for (const run of [text, unet, decoder]) expect(run).toHaveBeenCalledTimes(1);
		expect(await call('dispose', {})).toMatchObject({ ok: true });
	});
});
