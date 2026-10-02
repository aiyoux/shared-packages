import type { AiLibraryEntry, AiNativeModelInput } from './library.js';
import type { AiTask } from './catalog.js';

const RUNTIMES = {
	transcription: 'whisper-cli',
	chat: 'llama-cli',
	'text-to-speech': 'piper',
	'image-generation': 'sd-cli'
};
export const NATIVE_RUNTIME_NAMES: Readonly<Record<string, string>> = RUNTIMES;
export type NativeModelTask = keyof typeof RUNTIMES;

/** Distilled checkpoints; the 9B model requires the larger Qwen3 encoder. */
export const FLUX2_MODEL_PRESETS = {
	'4b': {
		name: 'FLUX.2 Klein 4B',
		modelExample: '/Users/you/ai-models/flux-2-klein-4b-Q4_0.gguf',
		encoderName: 'Qwen3 4B',
		encoderExample: '/Users/you/ai-models/Qwen3-4B-Q4_K_M.gguf',
		vaeExample: '/Users/you/ai-models/flux2_ae.safetensors',
		weightsUrl: 'https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF',
		encoderUrl: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF',
		vaeUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-dev/tree/main',
		note: 'Start here on a 24 GB Mac. Use quantized weights for the model and text encoder. Apache 2.0.'
	},
	'9b': {
		name: 'FLUX.2 Klein 9B',
		modelExample: '/Users/you/ai-models/flux-2-klein-9b-Q4_0.gguf',
		encoderName: 'Qwen3 8B',
		encoderExample: '/Users/you/ai-models/Qwen3-8B-Q4_K_M.gguf',
		vaeExample: '/Users/you/ai-models/flux2_ae.safetensors',
		weightsUrl: 'https://huggingface.co/leejet/FLUX.2-klein-9B-GGUF',
		encoderUrl: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF',
		vaeUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-dev/tree/main',
		note: 'Larger quality option. Start with quantized model and encoder weights on a 24 GB Mac; memory use depends on the runtime. FLUX Non-Commercial License.'
	}
} as const;

export function canConfigureNativeTask(task: string): task is NativeModelTask {
	return Object.hasOwn(NATIVE_RUNTIME_NAMES, task);
}

/** Qwen-Image-2.1 component preset: diffusion weights plus its VAE and text
 * encoder. Needs a monitor with component image support; the panel gates on
 * the `nativeImageComponents` capability. */
export const QWEN_IMAGE_PRESET = {
	name: 'Qwen-Image-2.1',
	modelExample: '/Users/you/ai-models/qwen-image-2.1-Q4_K_M.gguf',
	encoderName: 'Qwen3-VL 8B',
	encoderExample: '/Users/you/ai-models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
	vaeExample: '/Users/you/ai-models/qwen_image_2.1_vae_bf16.safetensors',
	weightsUrl: 'https://huggingface.co/unsloth/Qwen-Image-2.1-GGUF',
	encoderUrl: 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF',
	vaeUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/vae',
	note: 'Qwen-Image-2.1 needs quantized diffusion weights, its 2.1 VAE (qwen_image_2.1_vae_bf16.safetensors), and the Qwen3-VL 8B text encoder. Earlier Qwen Image VAEs are incompatible. Start at 1024×1024; memory use depends on the runtime and quantization.'
} as const;

export function nativeModelTaskPrefill(task: AiTask) {
	return {
		name: '',
		task,
		model: '',
		binary: '',
		backend: '',
		device: 'cpu' as const,
		vae: '',
		textEncoder: '',
		width: 512,
		height: 512
	};
}

/** Start with the library's task, without carrying paths from another runtime. */
export function nativeModelLibraryPrefill(entry: AiLibraryEntry) {
	return {
		...nativeModelTaskPrefill(entry.task),
		name: entry.name,
		model: entry.installedPath ?? ''
	};
}

/** Keep an integer resolution side inside the daemon's 128–2048 range. */
function cleanDim(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
	if (value < 128 || value > 2048 || value % 32 !== 0) return undefined;
	return value;
}

/** Hidden image fields must never leak into a different task's request. */
export function nativeModelFormInput(input: AiNativeModelInput): AiNativeModelInput {
	const { backend, flux2, omnisvg, vae, textEncoder, width, height, ...rest } = input;
	const image = input.task === 'image-generation';
	const cleanWidth = cleanDim(width);
	const cleanHeight = cleanDim(height);
	return {
		...rest,
		name: rest.name.trim(),
		binary: rest.binary.trim(),
		model: rest.model.trim(),
		...(image && !omnisvg && backend?.trim() ? { backend: backend.trim() } : {}),
		...(image && !omnisvg && flux2 ? {
			flux2: { variant: flux2.variant, vae: flux2.vae.trim(), llm: flux2.llm.trim() }
		} : {}),
		...(image && !omnisvg && vae?.trim() && textEncoder?.trim()
			? { vae: vae.trim(), textEncoder: textEncoder.trim() }
			: {}),
		...(image && omnisvg ? { omnisvg: { ...omnisvg, baseModel: omnisvg.baseModel.trim() } } : {}),
		...(image && cleanWidth !== undefined ? { width: cleanWidth } : {}),
		...(image && cleanHeight !== undefined ? { height: cleanHeight } : {})
	};
}

/** Official full-precision OmniSVG 1.1 checkpoints, decoded by Monitor. */
export const OMNISVG_MODEL_PRESETS = {
	'omnisvg-4b': {
		variant: '4b', name: 'OmniSVG 1.1 4B',
		weightsUrl: 'https://huggingface.co/OmniSVG/OmniSVG1.1_4B',
		baseUrl: 'https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct',
		baseName: 'Qwen2.5-VL 3B'
	},
	'omnisvg-8b': {
		variant: '8b', name: 'OmniSVG 1.1 8B',
		weightsUrl: 'https://huggingface.co/OmniSVG/OmniSVG1.1_8B',
		baseUrl: 'https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct',
		baseName: 'Qwen2.5-VL 7B'
	}
} as const;
