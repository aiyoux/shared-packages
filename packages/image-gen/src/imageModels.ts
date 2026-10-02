import type { ModelDef, ModelFileDef } from '@shared-packages/model-store';

/**
 * Image model weight catalogs: every file each engine loads, pinned to an
 * upstream revision with sizes and Blake3 hashes streamed from it by
 * `model-store/scripts/hash-catalog.mjs`. Engines read these files only from
 * the browser model store (Settings → AI models), so the list is complete.
 */

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
	label: string;
	/** Diffusion family this def belongs to. */
	engine: ImageModelEngine;
	task: 't2i';
	repo: string;
	/** Pinned commit the sizes and hashes were generated from. */
	revision: string;
	dtype: 'fp16' | 'fp32';
	files: readonly ModelFileDef[];
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

const f = (path: string, bytes: number, blake3: string): ModelFileDef => ({ path, bytes, blake3 });

/**
 * Single-step distilled SD 2.1 (Euler, timestep 999, no CFG). Browser recipe
 * proven by Microsoft's ORT WebGPU js/sd-turbo example against this exact
 * single-file repo layout.
 */
export const SD_TURBO: ImageModelDef = {
	id: 'sd-turbo',
	label: 'SD-Turbo',
	engine: 'sd-turbo',
	task: 't2i',
	repo: 'schmuell/sd-turbo-ort-web',
	revision: 'ace89b7d2cd849f9a73914cdbb8a3ea60c853dd1',
	dtype: 'fp32',
	files: [
		f('tokenizer/merges.txt', 524619, '64a704d74f18e52434c694dac7226f4dfa267600c615929126c4795be0d3d8d9'),
		f('tokenizer/vocab.json', 1059962, 'c3d996e86b659a4c358aa0a9931bc18e4388a75753495399d874b1c3271511e4'),
		f('tokenizer/tokenizer_config.json', 855, '1e6c9bae58cd4af031ab5b6e8dafd47ae18bc24de4775549bbfa306723f88bba'),
		f('tokenizer/special_tokens_map.json', 574, 'a329c76562245867fbb39793c841ed4028fa24a523f89bf4cd803df9f4a989b7'),
		f('text_encoder/model.onnx', 681393168, '02807df49ad7380f4cfb59dfffb99bf0006a11dfeff6f60b43a201eab5f95297'),
		f('unet/model.onnx', 1733430199, '67c7c35264ff1f01ed6f7afb3361c984f03ac0fb2b5e8bf4978654e190eda0ca'),
		f('vae_decoder/model.onnx', 99094314, '26de862522d72d41e1267cc97ce84fcc020190e669b92b6ab7fca25f177a219e')
	],
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
	label: 'SDXS DreamShaper 512',
	engine: 'sdxs',
	task: 't2i',
	repo: 'skillsafeai/sdxs-512-dreamshaper-onnx-webgpu',
	revision: 'b23bf8f4f809a0beb6d095bf52b5854e0b66caef',
	dtype: 'fp16',
	files: [
		f('tokenizer/merges.txt', 524619, '64a704d74f18e52434c694dac7226f4dfa267600c615929126c4795be0d3d8d9'),
		f('tokenizer/vocab.json', 1059962, 'c3d996e86b659a4c358aa0a9931bc18e4388a75753495399d874b1c3271511e4'),
		f('text_encoder.onnx', 246275486, 'c260f3668079f4753b16ddc1b6f46b5d799c493a5b5c0d380c0a6f8124e43432'),
		f('unet.onnx', 631766742, 'c916290e62de6ca69010dc6a0099d0e09f95163dec8128aa9a8ae768edf6a65c'),
		f('vae_decoder.onnx', 2467568, 'd56505e84455c2ab007594d49443f82a885cb5646253f6701faa4b241b6f7656')
	],
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
	label: 'FLUX.2 [klein] 4B (q4)',
	engine: 'flux2-klein',
	task: 't2i',
	repo: 'MarkShark2/flux2-klein-4b-onnx-webgpu-q4',
	revision: '929085adfad60491e9af05095cd280955fc0c29d',
	dtype: 'fp16',
	files: [
		f('flux2-config.json', 10641, '00f117412f11a5a8ebc13db79d73a97df04f0b53392f2fd9f243e45a8b980063'),
		f('tokenizer/tokenizer.json', 11422650, '4cb4172c5eb12944fd15eff0238c36a26032ea4433c82a1413cbfad4ac366267'),
		f('tokenizer/chat_template.jinja', 4168, '72a1a5e64f5ff443c86b9332e82c85afd838c9e398b8e8f8bb38579d0e76d892'),
		f('tokenizer/tokenizer_config.json', 377, 'be78225ca5c14bb3186fb787df3d6969f6bb8cf1b6ccd694f2d8350f4ed52872'),
		f('text-encoder-q4-manifest.json', 77, '2ac6e078c4275ab7771854c1fcdcf96192e21047f3b040b2f6a3bd2bdbb149bf'),
		f('flux2-klein-4b-text-encoder-q4.onnx', 1844725, '1d3b3c83cd8ea7dfe4cf722676e3134bba85e34f7ce069c5bf064731327bc458'),
		f('text-encoder-q4-00001.onnx_data', 2136381440, 'da3587c2e02c574da762b7ee138501991b1bef2bef0b5b7ed4a960cdba2d86aa'),
		f('text-encoder-q4-00002.onnx_data', 430080000, 'f008ed69eb9d6f6bb0607c198286c6fdfbf8c7d8ba225eee1e949c1e25b04498'),
		f('transformer-q4-manifest.json', 75, 'b7ee9471d956b4fb58b8f272ecc9a665771c56c0eacbc15e79ae1bc8941a5e02'),
		f('flux2-klein-4b-transformer-q4.onnx', 1550157, 'd7a8cdbc2ee5c77df56940dfeda7b1a167cb293d6b19612e5e27fe2e15eed612'),
		f('transformer-q4-00001.onnx_data', 2128121856, '773e57e8fc93d01855af3ef89dc74a59616d9d6bf8617110bef9098ae2f9bbff'),
		f('transformer-q4-00002.onnx_data', 415703040, '4511fb3599b1b80084c7bf055cfee18dbf357b535275cca37b701a2d46fe6825'),
		f('flux2-klein-4b-vae-decoder-pre-attn-fp16.onnx', 11352251, '40dbd20a792dada6e97fa1278e674276d33cc5b6ed70e07b7382f04730481df5'),
		f('flux2-klein-4b-vae-decoder-attn-chunk-fp16.onnx', 480, '429b1ceab844fb3f9c4f0e36183bf707ab162e5b253caf0df774dac3c5196d23'),
		f('flux2-klein-4b-vae-decoder-post-stage0-fp16.onnx', 85202062, '85db9a6d6c4397bf031d9fd099c6d9b1523bc1409ae9578bd2163e9745d55367'),
		f('flux2-klein-4b-vae-decoder-post-stage1-fp16.onnx', 2141312, 'cc2caedecb7024175c85446d2540ed9902541dd89dc5ef83c0ca89b25340e13c'),
		f('flux2-klein-4b-vae-decoder-post-stage2-fp16.onnx', 1196419, 'bd10fc02500b1f3c0baf131b76f76d8f6286129dc9cd99939bb22a944ab20716'),
		f('flux2-klein-4b-vae-decoder-post-stage3-fp16.onnx', 10460, 'd59da4290ede287675ce12fa37d9907bf5235859f4943984c044c43e3a39eccb')
	],
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

/** Pinned download URL for one file inside an image model repo. */
export function hfImageResolveUrl(def: Pick<ImageModelDef, 'repo' | 'revision'>, path: string): string {
	return `https://huggingface.co/${def.repo}/resolve/${def.revision}/${path}`;
}

const browserModels = new WeakMap<ImageModelDef, ModelDef>();
/** The store's view of an image def — derived, so each model is declared once. */
export function imageBrowserModel(def: ImageModelDef): ModelDef {
	let model = browserModels.get(def);
	if (!model) {
		model = {
			id: `image:${def.id}`,
			task: 'image-generation',
			label: def.label,
			license: def.license,
			files: def.files.map((file) => ({ ...file, url: hfImageResolveUrl(def, file.path) })),
			origin: { kind: 'hf', repo: def.repo, revision: def.revision }
		};
		browserModels.set(def, model);
	}
	return model;
}

/** Total download size, from the catalog's file sizes. */
export function imageModelBytes(def: ImageModelDef): number {
	return def.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
}
