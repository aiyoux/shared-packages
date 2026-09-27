/// <reference lib="webworker" />
/**
 * SD-family diffusion worker: CLIP text-encode (transformers.js tokenizer +
 * ORT text encoder) → one Euler UNet step → VAE decode, all on WebGPU.
 *
 * The page reads the model files out of the VFS and hands them over as
 * transferable ArrayBuffers; the CLIP tokenizer files ride through a
 * transformers.js custom cache served from the same blobs, so nothing is
 * fetched. Session IO shapes follow Microsoft's ORT WebGPU js/sd-turbo
 * recipe (fixed timestep 999, sigma 14.6146, no CFG).
 *
 * Text embeddings stay on the CPU between sessions (no gpu-buffer
 * chaining) — simpler and robust; GPU-buffer piping is a later tuning knob.
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { InferenceSession, Tensor } from 'onnxruntime-common';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { EULER_SIGMA, eulerStep, randnLatents, mulberry32, vaeToRgb, rgbToRgbaU8 } from './sdEuler.js';
import { imageModelDef } from './imageModels.js';
import { ImageGenError } from './engines.js';

type RpcCall = { id: number; op: string; payload: Record<string, unknown> };

type LoadedSessions = {
	modelId: string;
	repo: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tokenizer: any;
	textEncoder: InferenceSession;
	unet: InferenceSession;
	vaeDecoder: InferenceSession;
	vaeScale: number;
	resolution: number;
};

let loaded: LoadedSessions | null = null;
let cancelled = false;

function filesFrom(payload: Record<string, unknown>): Map<string, ArrayBuffer> {
	const raw = payload['files'] as Array<{ path: string; buffer: ArrayBuffer }>;
	return new Map(raw.map((f) => [f.path, f.buffer]));
}

/** transformers.js custom cache served from handed-over blobs. */
function blobCache(repo: string, files: Map<string, ArrayBuffer>) {
	return {
		async match(request: Request | string | URL): Promise<Response | undefined> {
			const url =
				typeof request === 'string' ? request : 'url' in request ? request.url : String(request);
			const prefix = `https://huggingface.co/${repo}/resolve/`;
			if (!url.startsWith(prefix)) return undefined;
			const rest = url.slice(prefix.length);
			const slash = rest.indexOf('/');
			const path = slash >= 0 ? rest.slice(slash + 1) : null;
			const buffer = path ? files.get(path) : undefined;
			if (!buffer) return undefined;
			return new Response(buffer, {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			});
		},
		async put(): Promise<void> {
			// Read-only: every file the model needs was handed over up front.
		}
	};
}

function sessionOpts(
	freeDimensionOverrides: Record<string, number>
): InferenceSession.SessionOptions {
	return {
		executionProviders: ['webgpu'],
		enableMemPattern: false,
		enableCpuMemArena: false,
		extra: {
			session: {
				disable_prepacking: '1',
				use_device_allocator_for_initializers: '1',
				use_ort_model_bytes_directly: '1',
				use_ort_model_bytes_for_initializers: '1'
			}
		},
		freeDimensionOverrides
	};
}

/** Find a catalog file by nested or flat name (`text_encoder/model.onnx` or `text_encoder.onnx`). */
function componentPath(files: Map<string, ArrayBuffer>, stem: string): string {
	for (const key of files.keys()) {
		if (key === `${stem}/model.onnx` || key === `${stem}.onnx`) return key;
	}
	throw new ImageGenError('NO_MODEL', `Model files have no ${stem} weights`);
}

function checkCancelled(): void {
	if (cancelled) throw new ImageGenError('CANCELLED', 'Generation cancelled');
}

async function load(payload: Record<string, unknown>): Promise<{ modelId: string }> {
	const modelId = payload['modelId'] as string;
	const def = imageModelDef(modelId);
	const files = filesFrom(payload);
	cancelled = false;
	await disposeSessions();

	ort.env.wasm.wasmPaths = '/vendor/ort/';
	env.allowLocalModels = false;
	env.allowRemoteModels = true;
	env.useBrowserCache = false;
	env.useCustomCache = true;
	env.customCache = blobCache(def.repo, files) as never;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tokenizer = await (AutoTokenizer as any).from_pretrained(
		`https://huggingface.co/${def.repo}`
	);
	tokenizer.pad_token_id = 0;
	checkCancelled();

	const textEncoder = await ort.InferenceSession.create(
		files.get(componentPath(files, 'text_encoder'))!,
		sessionOpts({ batch_size: 1 })
	);
	checkCancelled();
	const latentEdge = def.resolution / 8;
	const unet = await ort.InferenceSession.create(
		files.get(componentPath(files, 'unet'))!,
		sessionOpts({
			batch_size: 1,
			num_channels: 4,
			height: latentEdge,
			width: latentEdge,
			sequence_length: 77
		})
	);
	checkCancelled();
	const vaeDecoder = await ort.InferenceSession.create(
		files.get(componentPath(files, 'vae_decoder'))!,
		sessionOpts({
			batch_size: 1,
			num_channels_latent: 4,
			height_latent: latentEdge,
			width_latent: latentEdge
		})
	);

	loaded = {
		modelId,
		repo: def.repo,
		tokenizer,
		textEncoder,
		unet,
		vaeDecoder,
		vaeScale: def.vaeScale,
		resolution: def.resolution
	};
	return { modelId };
}

async function disposeSessions(): Promise<void> {
	if (!loaded) return;
	const { textEncoder, unet, vaeDecoder } = loaded;
	loaded = null;
	for (const session of [textEncoder, unet, vaeDecoder]) {
		try {
			await session.release();
		} catch {
			/* already gone */
		}
	}
}

async function generate(payload: Record<string, unknown>): Promise<{
	width: number;
	height: number;
	seed: number;
	rgba: ArrayBuffer;
}> {
	if (!loaded) throw new ImageGenError('NO_MODEL', 'No model loaded in the worker');
	const prompt = payload['prompt'] as string;
	const seed = (payload['seed'] as number | undefined) ?? Math.floor(Math.random() * 2 ** 31);
	const edge = loaded.resolution / 8;
	const latentLen = 4 * edge * edge;
	cancelled = false;

	const encoded = await loaded.tokenizer(prompt, {
		padding: true,
		max_length: 77,
		truncation: true,
		return_tensor: false
	});
	const inputIds: number[] = encoded?.input_ids;
	if (!inputIds || inputIds.length === 0) {
		throw new ImageGenError('GENERATE_FAILED', 'Tokenizer produced no input ids');
	}
	checkCancelled();

	const hidden: Record<string, Tensor> = await loaded.textEncoder.run({
		input_ids: new ort.Tensor('int32', Int32Array.from(inputIds), [1, inputIds.length])
	});
	const embedding = hidden['last_hidden_state'];
	if (!embedding) throw new ImageGenError('GENERATE_FAILED', 'Text encoder produced no embedding');
	checkCancelled();

	const rng = mulberry32(seed);
	const latent = randnLatents(latentLen, EULER_SIGMA, rng);
	const noisy = new Float32Array(latentLen);
	const pre = 1 / Math.sqrt(EULER_SIGMA * EULER_SIGMA + 1);
	for (let i = 0; i < latentLen; i++) noisy[i] = latent[i]! * pre;

	const noise: Record<string, Tensor> = await loaded.unet.run({
		sample: new ort.Tensor('float32', noisy, [1, 4, edge, edge]),
		timestep: new ort.Tensor('int64', new BigInt64Array([999n]), [1]),
		encoder_hidden_states: embedding
	});
	const predicted = noise['out_sample'];
	if (!predicted) throw new ImageGenError('GENERATE_FAILED', 'UNet produced no output');
	checkCancelled();

	const stepped = eulerStep(
		latent,
		Float32Array.from(predicted.data as ArrayLike<number>),
		EULER_SIGMA,
		loaded.vaeScale
	);
	const decoded: Record<string, Tensor> = await loaded.vaeDecoder.run({
		latent_sample: new ort.Tensor('float32', stepped, [1, 4, edge, edge])
	});
	const sample = decoded['sample'];
	if (!sample) throw new ImageGenError('GENERATE_FAILED', 'VAE decoder produced no output');

	const rgb = vaeToRgb(
		Float32Array.from(sample.data as ArrayLike<number>).slice(
			0,
			3 * loaded.resolution * loaded.resolution
		)
	);
	const rgba = rgbToRgbaU8(rgb, loaded.resolution, loaded.resolution);
	const buffer = rgba.buffer as ArrayBuffer;
	return { width: loaded.resolution, height: loaded.resolution, seed, rgba: buffer };
}

self.onmessage = (event: MessageEvent<RpcCall>) => {
	const { id, op, payload } = event.data;
	void (async () => {
		try {
			if (op === 'load') {
				postMessage({ id, ok: true, result: await load(payload) });
			} else if (op === 'generate') {
				const result = await generate(payload);
				postMessage({ id, ok: true, result }, { transfer: [result.rgba] });
			} else if (op === 'cancel') {
				cancelled = true;
				postMessage({ id, ok: true, result: { cancelled: true } });
			} else if (op === 'dispose') {
				await disposeSessions();
				postMessage({ id, ok: true, result: { disposed: true } });
			} else {
				throw new ImageGenError('GENERATE_FAILED', `Unknown worker op ${op}`);
			}
		} catch (err) {
			const code =
				err instanceof ImageGenError
					? (err.code as string)
					: 'GENERATE_FAILED';
			postMessage({
				id,
				ok: false,
				message: err instanceof Error ? err.message : String(err),
				code
			});
		}
	})();
};
