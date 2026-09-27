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

export type ImageModelDef = {
	id: string;
	/** Diffusion family this def belongs to. */
	engine: 'sd-turbo' | 'sdxs';
	task: 't2i';
	repo: string;
	revision: 'main';
	dtype: 'fp16' | 'fp32';
	files: readonly ImageModelFile[];
	sizeBytes: number;
	/** Square output edge the pipeline renders. */
	resolution: number;
	/** UNet cross-attention width (text embedding dim). */
	crossAttentionDim: 768 | 1024;
	/** VAE scale applied before decoding (TAESD uses 1.0). */
	vaeScale: number;
	/** License family for UX notice purposes. */
	license: 'stability-ai-community';
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
	license: 'stability-ai-community',
	languages: ['en']
};

export const IMAGE_MODEL_CATALOG: readonly ImageModelDef[] = [SD_TURBO, SDXS_DREAMSHAPER];

export function imageModelDef(id: string): ImageModelDef {
	const found = IMAGE_MODEL_CATALOG.find((m) => m.id === id);
	if (!found) throw new Error(`Unknown image model: ${id}`);
	return found;
}

/** Resolve URL for one file inside an image model repo. */
export function hfImageResolveUrl(def: Pick<ImageModelDef, 'repo' | 'revision'>, path: string): string {
	return `https://huggingface.co/${def.repo}/resolve/${def.revision}/${path}`;
}
