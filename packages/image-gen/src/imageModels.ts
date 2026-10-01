/**
 * Image model weight catalogs, verified against the live HF repos
 * (research: file lists + byte sizes from the repo trees).
 *
 * Each entry lists the files its engine loads. Small config/tokenizer files
 * ride along so the transformers.js custom VFS cache can serve the CLIP
 * tokenizer offline — the catalog is the pre-download / manifest / display
 * list, and `ingestResponse` captures anything extra the runtime pulls.
 */

export type ImageModelFile = {
	path: string;
	bytes?: number;
};

export type ImageModelEngine = 'sd-turbo' | 'sdxs' | 'flux2-klein';

export type ImageModelLicense = 'stability-ai-community' | 'apache-2.0';

/** SD graph IO differs between exports; types/names verified from ONNX ValueInfo. */
export type SdConfig = {
	inputIdsType: 'int32' | 'int64';
	timestepType: 'int64' | 'float32';
	decoderInput: string;
	decoderOutput: string;
};

/** FLUX.2 klein staged-VAE decoder wiring (tensor names from the q4 bundle). */
export type Flux2VaeConfig = {
	pre: string;
	/** Output names of the pre stage: the residual skip plus raw q/kt/v. */
	preOutputs: { residual: string; q: string; kt: string; v: string };
	attnChunk: string;
	/** Query-chunk length the attention-chunk graph was exported for. */
	chunkSeq: number;
	/** Post stages, chained in order via inputNames[0] → outputNames[0]. */
	post: readonly string[];
};

export type Flux2Config = {
	textSeqLen: number;
	contextDim: number;
	latentChannels: number;
	latentDownsample: number;
	/** Distilled step count (guidance 1.0 — no CFG anywhere in the family). */
	numSteps: number;
	textEncoder: { graph: string; shards: readonly string[] };
	transformer: { graph: string; shards: readonly string[] };
	vae: Flux2VaeConfig;
};

export type ImageModelDef = {
	id: string;
	/** Diffusion family this def belongs to. */
	engine: ImageModelEngine;
	task: 't2i';
	repo: string;
	revision: 'main';
	dtype: 'fp16' | 'fp32';
	files: readonly ImageModelFile[];
	sizeBytes: number;
	/** Fixed square output edge (SD-family engines). */
	resolution?: number;
	/** Selectable square edges in px, multiples of 16 (variable engines). */
	sizes?: readonly number[];
	/** UNet cross-attention width (text embedding dim). SD engines. */
	crossAttentionDim?: 768 | 1024;
	/** VAE scale applied before decoding (TAESD uses 1.0). SD engines. */
	vaeScale?: number;
	/** SD-family graph wiring, independent of weight precision. */
	sd?: SdConfig;
	/** Engine-specific wiring, present iff the engine needs one. */
	flux2?: Flux2Config;
	/** License family for UX notice purposes. */
	license: ImageModelLicense;
	languages: readonly string[];
};

const f = (path: string, bytes?: number): ImageModelFile => ({ path, bytes });

/**
 * Single-step distilled SD 2.1 (Euler, timestep 999, no CFG). Browser recipe
 * proven by Microsoft's ORT WebGPU js/sd-turbo example against this exact
 * single-file repo layout.
 */
export const SD_TURBO: ImageModelDef = {
	id: 'sd-turbo',
	engine: 'sd-turbo',
	task: 't2i',
	repo: 'schmuell/sd-turbo-ort-web',
	revision: 'main',
	dtype: 'fp32',
	files: [
		f('tokenizer/merges.txt', 524_619),
		f('tokenizer/vocab.json', 1_059_962),
		f('tokenizer/tokenizer_config.json'),
		f('tokenizer/special_tokens_map.json'),
		f('text_encoder/model.onnx', 681_393_168),
		f('unet/model.onnx', 1_733_430_199),
		f('vae_decoder/model.onnx', 99_094_314)
	],
	sizeBytes: 2_515_502_262,
	resolution: 512,
	crossAttentionDim: 1024,
	vaeScale: 0.18215,
	sd: { inputIdsType: 'int32', timestepType: 'int64', decoderInput: 'latent_sample', decoderOutput: 'sample' },
	license: 'stability-ai-community',
	languages: ['en']
};

/**
 * Single-step SDXS Dreamshaper (Euler, timestep 999, TAESD decoder).
 * Smaller and faster than SD-Turbo (~0.85 GB, sub-second in Chrome once
 * sessions are built); fp16 weights with fp32 IO.
 */
export const SDXS_DREAMSHAPER: ImageModelDef = {
	id: 'sdxs-dreamshaper',
	engine: 'sdxs',
	task: 't2i',
	repo: 'skillsafeai/sdxs-512-dreamshaper-onnx-webgpu',
	revision: 'main',
	dtype: 'fp16',
	files: [
		f('tokenizer/merges.txt'),
		f('tokenizer/vocab.json'),
		f('text_encoder.onnx', 246_275_486),
		f('unet.onnx', 631_766_742),
		f('vae_decoder.onnx', 2_467_568)
	],
	sizeBytes: 880_509_796,
	resolution: 512,
	crossAttentionDim: 768,
	vaeScale: 1.0,
	sd: { inputIdsType: 'int64', timestepType: 'float32', decoderInput: 'latent', decoderOutput: 'image' },
	license: 'stability-ai-community',
	languages: ['en']
};

/**
 * FLUX.2 [klein] 4B, Apache 2.0 (Black Forest Labs upstream, weights and
 * this quantization). Four-step distilled flow matching, guidance 1.0 — no
 * CFG — rendered by a MatMulNBits q4 transformer with fp16-selective
 * activations, exported for ORT WebGPU jsep (exported with ORT Python
 * 1.25.1; the worker runs `onnxruntime-web-flux2`, a pin of the matching
 * dev line). Staged fp16 VAE decoder: pre (residual + q/kt/v) →
 * chunked attention → post stages 0-3. Tensor names verified by parsing
 * the bundle's ONNX graphs directly. Sizes are multiples of 16; the
 * chunked attention pads the final query chunk to `chunkSeq`.
 */
export const FLUX2_KLEIN_4B: ImageModelDef = {
	id: 'flux2-klein-4b',
	engine: 'flux2-klein',
	task: 't2i',
	repo: 'MarkShark2/flux2-klein-4b-onnx-webgpu-q4',
	revision: 'main',
	dtype: 'fp16',
	files: [
		f('flux2-config.json', 10_641),
		f('tokenizer/tokenizer.json', 11_422_650),
		f('tokenizer/chat_template.jinja', 4_168),
		f('tokenizer/tokenizer_config.json', 377),
		f('text-encoder-q4-manifest.json', 77),
		f('flux2-klein-4b-text-encoder-q4.onnx', 1_844_725),
		f('text-encoder-q4-00001.onnx_data', 2_136_381_440),
		f('text-encoder-q4-00002.onnx_data', 430_080_000),
		f('transformer-q4-manifest.json', 75),
		f('flux2-klein-4b-transformer-q4.onnx', 1_550_157),
		f('transformer-q4-00001.onnx_data', 2_128_121_856),
		f('transformer-q4-00002.onnx_data', 415_703_040),
		f('flux2-klein-4b-vae-decoder-pre-attn-fp16.onnx', 11_352_251),
		f('flux2-klein-4b-vae-decoder-attn-chunk-fp16.onnx', 480),
		f('flux2-klein-4b-vae-decoder-post-stage0-fp16.onnx', 85_202_062),
		f('flux2-klein-4b-vae-decoder-post-stage1-fp16.onnx', 2_141_312),
		f('flux2-klein-4b-vae-decoder-post-stage2-fp16.onnx', 1_196_419),
		f('flux2-klein-4b-vae-decoder-post-stage3-fp16.onnx', 10_460)
	],
	sizeBytes: 5_225_022_190,
	sizes: [256, 512, 768, 1024],
	flux2: {
		textSeqLen: 512,
		contextDim: 7680,
		latentChannels: 128,
		latentDownsample: 16,
		numSteps: 4,
		textEncoder: {
			graph: 'flux2-klein-4b-text-encoder-q4.onnx',
			shards: ['text-encoder-q4-00001.onnx_data', 'text-encoder-q4-00002.onnx_data']
		},
		transformer: {
			graph: 'flux2-klein-4b-transformer-q4.onnx',
			shards: ['transformer-q4-00001.onnx_data', 'transformer-q4-00002.onnx_data']
		},
		vae: {
			pre: 'flux2-klein-4b-vae-decoder-pre-attn-fp16.onnx',
			preOutputs: {
				residual: '/decoder/block_1/Add_output_0',
				q: '/decoder/attn_1/Mul_6_output_0',
				kt: '/decoder/attn_1/Mul_7_output_0',
				v: '/decoder/attn_1/Reshape_2_output_0'
			},
			attnChunk: 'flux2-klein-4b-vae-decoder-attn-chunk-fp16.onnx',
			chunkSeq: 1024,
			post: [
				'flux2-klein-4b-vae-decoder-post-stage0-fp16.onnx',
				'flux2-klein-4b-vae-decoder-post-stage1-fp16.onnx',
				'flux2-klein-4b-vae-decoder-post-stage2-fp16.onnx',
				'flux2-klein-4b-vae-decoder-post-stage3-fp16.onnx'
			]
		}
	},
	license: 'apache-2.0',
	languages: ['en']
};

export const IMAGE_MODEL_CATALOG: readonly ImageModelDef[] = [
	SD_TURBO,
	SDXS_DREAMSHAPER,
	FLUX2_KLEIN_4B
];

export function imageModelDef(id: string): ImageModelDef {
	const found = IMAGE_MODEL_CATALOG.find((m) => m.id === id);
	if (!found) throw new Error(`Unknown image model: ${id}`);
	return found;
}

/** Resolve URL for one file inside an image model repo. */
export function hfImageResolveUrl(def: Pick<ImageModelDef, 'repo' | 'revision'>, path: string): string {
	return `https://huggingface.co/${def.repo}/resolve/${def.revision}/${path}`;
}
