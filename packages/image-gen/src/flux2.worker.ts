/// <reference lib="webworker" />
/**
 * FLUX.2 [klein] 4B worker: Qwen3 chat-template tokenization → text-encode
 * → mu-shifted 4-step flow-match Euler loop → staged fp16 VAE decode, all
 * on WebGPU through a dedicated onnxruntime-web pin (`onnxruntime-web-flux2`,
 * the 1.25 dev line this q4 bundle was exported against — the SD engines'
 * pinned 1.22 wasm-only build can't run these graphs).
 *
 * The page reads the model files out of the browser model store and hands them over as
 * transferable ArrayBuffers; external-data shards go straight into the
 * session as `externalData` entries keyed by the bundle's basenames. The
 * tokenizer files ride through a transformers.js custom cache served from
 * the same blobs, remapped from the bundle's `tokenizer/` subfolder.
 *
 * Sessions are created sequentially (WebGPU device init is serialized
 * under the hood anyway) and all stay loaded: on unified-memory GPUs the
 * ~5.2 GB of weights share one pool between CPU and GPU.
 */

import * as ortFlux from 'onnxruntime-web-flux2/webgpu';
import type { InferenceSession } from 'onnxruntime-common';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { offlineTransformersEnv } from '@shared-packages/model-store';
import { imageModelDef, type Flux2Config } from './imageModels.js';
import { ImageGenError } from './engines.js';
import { f16ToFloat32, float32ToF16 } from './f16.js';
import {
	computeEmpiricalMu,
	flowEulerStep,
	imageTokenIds,
	textTokenIds,
	randnLatentsF32,
	shiftedSchedule,
	tokensToChannelFirst,
	chwToRgba,
	mulberry32
} from './flux2Math.js';

type RpcCall = { id: number; op: string; payload: Record<string, unknown> };

type LoadedFlux2 = {
	modelId: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tokenizer: any;
	textEncoder: InferenceSession;
	transformer: InferenceSession;
	vaePre: InferenceSession;
	vaeAttnChunk: InferenceSession;
	vaePost: InferenceSession[];
	cfg: Flux2Config;
};

let loaded: LoadedFlux2 | null = null;
let cancelled = false;

function filesFrom(payload: Record<string, unknown>): Map<string, ArrayBuffer> {
	const raw = payload['files'] as Array<{ path: string; buffer: ArrayBuffer }>;
	return new Map(raw.map((f) => [f.path, f.buffer]));
}

/** transformers.js custom cache; bundle tokenizer files live under `tokenizer/`. */
const TOKENIZER_ROOT_ALIASES: Record<string, string> = {
	'tokenizer.json': 'tokenizer/tokenizer.json',
	'tokenizer_config.json': 'tokenizer/tokenizer_config.json',
	'chat_template.jinja': 'tokenizer/chat_template.jinja',
	'special_tokens_map.json': 'tokenizer/special_tokens_map.json',
	'generation_config.json': 'tokenizer/generation_config.json'
};

/** Serves the handed-over files; a miss is a cache miss, never a fetch. */
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
			const resolved = path ? (files.has(path) ? path : TOKENIZER_ROOT_ALIASES[path]) : undefined;
			const buffer = resolved ? files.get(resolved) : undefined;
			if (!buffer) return undefined;
			return new Response(buffer.slice(0), {
				status: 200,
				headers: { 'Content-Type': 'application/octet-stream' }
			});
		},
		async put(): Promise<void> {
			throw new Error('Engines cannot write model weights; load files in Settings → AI models.');
		}
	};
}

/** Session options shared by every FLUX.2 stage (WebGPU jsep, no prepacking). */
function sessionOpts(
	freeDimensionOverrides: Record<string, number>,
	shards: Array<{ path: string; data: Uint8Array }>
): InferenceSession.SessionOptions {
	return {
		executionProviders: ['webgpu'],
		graphOptimizationLevel: 'disabled',
		enableMemPattern: false,
		enableCpuMemArena: false,
		freeDimensionOverrides,
		externalData: shards,
		extra: {
			session: {
				// The staged graphs carry their own transform barriers; these two
				// optimizers mis-handle the q4 weights' external-data reads.
				'optimizers.exclude': 'MemcpyTransformer,TransformerMemcpy'
			}
		}
	};
}

function checkCancelled(): void {
	if (cancelled) throw new ImageGenError('CANCELLED', 'Generation cancelled');
}

function fileBytes(files: Map<string, ArrayBuffer>, path: string): ArrayBuffer {
	const bytes = files.get(path);
	if (!bytes) throw new ImageGenError('NO_MODEL', `Model files are missing ${path}`);
	return bytes;
}

function shardEntries(files: Map<string, ArrayBuffer>, shardPaths: readonly string[]) {
	return shardPaths.map((path) => ({ path, data: new Uint8Array(fileBytes(files, path)) }));
}

async function load(payload: Record<string, unknown>): Promise<{ modelId: string }> {
	const modelId = payload['modelId'] as string;
	const def = imageModelDef(modelId);
	const cfg = def.flux2;
	if (!cfg) throw new ImageGenError('NO_MODEL', `${def.id} is not a FLUX.2 model`);
	const files = filesFrom(payload);
	cancelled = false;
	await disposeSessions();

	ortFlux.env.wasm.wasmPaths = '/vendor/ort-flux2/';
	offlineTransformersEnv(env as never, blobCache(def.repo, files) as never);

	// A repo id (not a URL) so the lookup keys are the repo's resolve URLs.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tokenizer = await (AutoTokenizer as any).from_pretrained(def.repo);
	checkCancelled();

	const textEncoder = await ortFlux.InferenceSession.create(
		fileBytes(files, cfg.textEncoder.graph),
		sessionOpts(
			{ batch: 1, text_seq: cfg.textSeqLen },
			shardEntries(files, cfg.textEncoder.shards)
		)
	);
	checkCancelled();
	const transformer = await ortFlux.InferenceSession.create(
		fileBytes(files, cfg.transformer.graph),
		sessionOpts({ batch: 1, text_seq: cfg.textSeqLen }, shardEntries(files, cfg.transformer.shards))
	);
	checkCancelled();

	// image_seq / latent dims / kv_seq stay free: size is chosen per generate.
	const vaePre = await ortFlux.InferenceSession.create(fileBytes(files, cfg.vae.pre), sessionOpts({ batch: 1 }, []));
	checkCancelled();
	const vaeAttnChunk = await ortFlux.InferenceSession.create(
		fileBytes(files, cfg.vae.attnChunk),
		sessionOpts({ batch: 1, heads: 1, chunk_seq: cfg.vae.chunkSeq }, [])
	);
	checkCancelled();
	const vaePost: InferenceSession[] = [];
	for (const postFile of cfg.vae.post) {
		vaePost.push(await ortFlux.InferenceSession.create(fileBytes(files, postFile), sessionOpts({ batch: 1 }, [])));
		checkCancelled();
	}

	loaded = {
		modelId,
		tokenizer,
		textEncoder,
		transformer,
		vaePre,
		vaeAttnChunk,
		vaePost,
		cfg
	};
	return { modelId };
}

async function disposeSessions(): Promise<void> {
	if (!loaded) return;
	const sessions = [loaded.textEncoder, loaded.transformer, loaded.vaePre, loaded.vaeAttnChunk, ...loaded.vaePost];
	loaded = null;
	for (const session of sessions) {
		try {
			await session.release();
		} catch {
			/* already gone */
		}
	}
}

/** Chat-template the prompt (Qwen3) and pad/truncate to the text length. */
async function tokenize(
	prompt: string,
	textSeqLen: number
): Promise<{ ids: BigInt64Array; mask: BigInt64Array }> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tok = loaded!.tokenizer as any;
	let text: string;
	try {
		text = tok.apply_chat_template([{ role: 'user', content: prompt }], {
			add_generation_prompt: true,
			enable_thinking: false,
			tokenize: false
		}) as string;
	} catch {
		// transformers.js may not read the bundle's chat_template.jinja; the
		// Qwen3 rendering for a bare user turn is fixed, so fall back to it.
		text = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;
	}
	const encoded = tok(text, {
		add_special_tokens: false,
		padding: 'max_length',
		max_length: textSeqLen,
		truncation: true,
		return_tensor: false
	});
	const ids = encoded?.input_ids as number[] | undefined;
	const mask = encoded?.attention_mask as number[] | undefined;
	if (!ids || ids.length !== textSeqLen || !mask || mask.length !== textSeqLen) {
		throw new ImageGenError('GENERATE_FAILED', 'Tokenizer produced no input ids');
	}
	return {
		ids: BigInt64Array.from(ids.map((v) => BigInt(v))),
		mask: BigInt64Array.from(mask.map((v) => BigInt(v)))
	};
}

/** Output tensor by catalog name, matched exactly or by path suffix. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function outTensor(session: InferenceSession, result: Record<string, any>, name: string): any {
	const exact = result[name];
	if (exact) return exact;
	const base = name.split('/').pop()!;
	for (const outName of session.outputNames) {
		if (outName === name || outName.split('/').pop() === base) return result[outName];
	}
	throw new ImageGenError('GENERATE_FAILED', `Model produced no ${name}`);
}

async function generate(payload: Record<string, unknown>): Promise<{
	width: number;
	height: number;
	seed: number;
	rgba: ArrayBuffer;
}> {
	if (!loaded) throw new ImageGenError('NO_MODEL', 'No model loaded in the worker');
	const cfg = loaded.cfg;
	const prompt = payload['prompt'] as string;
	const seed = (payload['seed'] as number | undefined) ?? Math.floor(Math.random() * 2 ** 31);
	const minEdge = 256;
	const maxEdge = 1024;
	const width = Math.min(maxEdge, Math.max(minEdge, Number(payload['width'] ?? 256)));
	const height = Math.min(maxEdge, Math.max(minEdge, Number(payload['height'] ?? width)));
	const latentWidth = width / cfg.latentDownsample;
	const latentHeight = height / cfg.latentDownsample;
	if (!Number.isInteger(latentWidth) || !Number.isInteger(latentHeight)) {
		throw new ImageGenError('GENERATE_FAILED', 'Width and height must be multiples of 16');
	}
	const seqLen = latentWidth * latentHeight;
	cancelled = false;

	const { ids, mask } = await tokenize(prompt, cfg.textSeqLen);
	checkCancelled();

	const ctxResult = await loaded.textEncoder.run({
		input_ids: new ortFlux.Tensor('int64', ids, [1, cfg.textSeqLen]),
		attention_mask: new ortFlux.Tensor('int64', mask, [1, cfg.textSeqLen])
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ctx = ctxResult[loaded.textEncoder.outputNames[0]!] as any;
	if (!ctx) throw new ImageGenError('GENERATE_FAILED', 'Text encoder produced no context');
	checkCancelled();

	const xIds = imageTokenIds(latentWidth, latentHeight);
	const cIds = textTokenIds(cfg.textSeqLen);
	const mu = computeEmpiricalMu(seqLen, cfg.numSteps);
	const sigmas = shiftedSchedule(cfg.numSteps, mu);
	const x = randnLatentsF32(seqLen * cfg.latentChannels, mulberry32(seed));
	let xBits = float32ToF16(x);

	for (let step = 0; step < cfg.numSteps; step++) {
		const result = await loaded.transformer.run({
			x: new ortFlux.Tensor('float16', xBits, [1, seqLen, cfg.latentChannels]),
			x_ids: new ortFlux.Tensor('float32', xIds, [1, seqLen, 4]),
			timesteps: new ortFlux.Tensor(
				'float16',
				float32ToF16(Float32Array.of(sigmas[step]!)),
				[1]
			),
			ctx,
			ctx_ids: new ortFlux.Tensor('float32', cIds, [1, cfg.textSeqLen, 4])
		});
		const predBits = outTensor(loaded.transformer, result, 'pred').data as Uint16Array;
		flowEulerStep(x, f16ToFloat32(predBits), sigmas[step]!, sigmas[step + 1]!);
		xBits = float32ToF16(x);
		checkCancelled();
	}

	// VAE pre stage: token-major → channel-first fp16 latents.
	const zBits = tokensToChannelFirst(xBits, latentWidth, latentHeight, cfg.latentChannels);
	const preResult = await loaded.vaePre.run({
		z: new ortFlux.Tensor('float16', zBits, [1, cfg.latentChannels, latentHeight, latentWidth])
	});
	const names = cfg.vae.preOutputs;
	const residual = outTensor(loaded.vaePre, preResult, names.residual);
	if (!residual) throw new ImageGenError('GENERATE_FAILED', 'VAE pre stage produced no residual');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const qTensor: any = outTensor(loaded.vaePre, preResult, names.q);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ktTensor: any = outTensor(loaded.vaePre, preResult, names.kt);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const vTensor: any = outTensor(loaded.vaePre, preResult, names.v);
	checkCancelled();

	// Chunked attention over the decoder mid-resolution (latent × 2). The
	// last chunk is zero-padded to the export's chunk length; padding only
	// affects unused output rows, so the valid prefix stays exact.
	const decoderHeight = latentHeight * 2;
	const decoderWidth = latentWidth * 2;
	const attnSeq = decoderHeight * decoderWidth;
	const headDim = 512;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const qBits: Uint16Array = qTensor.data;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ktBits: Uint16Array = ktTensor.data;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const vBits: Uint16Array = vTensor.data;
	const attn = new Uint16Array(attnSeq * headDim);
	for (let start = 0; start < attnSeq; start += cfg.vae.chunkSeq) {
		const chunk = Math.min(cfg.vae.chunkSeq, attnSeq - start);
		let qChunk: Uint16Array;
		if (chunk === cfg.vae.chunkSeq) {
			qChunk = qBits.subarray(start * headDim, (start + chunk) * headDim);
		} else {
			qChunk = new Uint16Array(cfg.vae.chunkSeq * headDim);
			qChunk.set(qBits.subarray(start * headDim, (start + chunk) * headDim));
		}
		const chunkResult = await loaded.vaeAttnChunk.run({
			q_chunk: new ortFlux.Tensor('float16', qChunk, [1, 1, cfg.vae.chunkSeq, headDim]),
			kt: new ortFlux.Tensor('float16', ktBits, [1, 1, headDim, attnSeq]),
			v: new ortFlux.Tensor('float16', vBits, [1, 1, attnSeq, headDim])
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const chunkOut: any = chunkResult[loaded.vaeAttnChunk.outputNames[0]!];
		attn.set((chunkOut.data as Uint16Array).subarray(0, chunk * headDim), start * headDim);
		checkCancelled();
	}

	// Post stages 0-3, chained: stage 0 folds the residual + attention, the
	// rest pass their single input through by the session's declared names.
	const stage0 = loaded.vaePost[0]!;
	const stage0Inputs = stage0.inputNames;
	const attnInputName =
		stage0Inputs.find((n) => /attn|MatMul/i.test(n)) ?? stage0Inputs[stage0Inputs.length - 1]!;
	const residualInputName = stage0Inputs.find((n) => n !== attnInputName)!;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let carry: any = (
		await stage0.run({
			[residualInputName]: residual,
			[attnInputName]: new ortFlux.Tensor('float16', attn, [1, 1, attnSeq, headDim])
		})
	)[stage0.outputNames[0]!];
	checkCancelled();
	for (let i = 1; i < loaded.vaePost.length; i++) {
		const session = loaded.vaePost[i]!;
		carry = (await session.run({ [session.inputNames[0]!]: carry }))[session.outputNames[0]!];
		checkCancelled();
	}

	const imageBits: Uint16Array = carry.data;
	const rgba = chwToRgba(imageBits, width, height);
	const buffer = rgba.buffer as ArrayBuffer;
	return { width, height, seed, rgba: buffer };
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
			const code = err instanceof ImageGenError ? (err.code as string) : 'GENERATE_FAILED';
			postMessage({
				id,
				ok: false,
				message: err instanceof Error ? err.message : String(err),
				code
			});
		}
	})();
};