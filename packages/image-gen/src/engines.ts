export type ImageGenErrorCode =
	| 'NO_MODEL'
	| 'LOAD_FAILED'
	| 'GENERATE_FAILED'
	| 'UNSUPPORTED_DEVICE'
	| 'CANCELLED';

export class ImageGenError extends Error {
	constructor(
		public readonly code: ImageGenErrorCode,
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'ImageGenError';
	}
}

export type ImageGenResult = {
	/** RGBA bytes, row-major, `width × height`. */
	data: Uint8ClampedArray;
	width: number;
	height: number;
	seed: number;
};

export type ImageEngine = {
	readonly modelId: string;
	generate(
		prompt: string,
		opts?: {
			seed?: number;
			signal?: AbortSignal;
			/** Square edges in px for variable-resolution engines; ignored otherwise. */
			width?: number;
			height?: number;
		}
	): Promise<ImageGenResult>;
	dispose(): void;
};

export type EngineLoadOpts = {
	modelId?: string | null;
	dirId?: string;
	onProgress?: (note: string, fraction?: number) => void;
	signal?: AbortSignal;
};

/** Probe WebGPU + fp16 shader support (MS js/sd-turbo `hasFp16` gate). */
export async function probeWebGpu(): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		const gpu = (navigator as Navigator & { gpu?: unknown }).gpu as
			| { requestAdapter?: (opts?: object) => Promise<{ features?: { has?: (f: string) => boolean } } | null> }
			| undefined;
		if (!gpu?.requestAdapter) return { ok: false, reason: 'WebGPU is not available in this browser' };
		const adapter = await gpu.requestAdapter();
		if (!adapter) return { ok: false, reason: 'No WebGPU adapter found' };
		if (!adapter.features?.has?.('shader-f16')) {
			return { ok: false, reason: 'This GPU or browser lacks WebGPU float16 support' };
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'WebGPU probe failed'
		};
	}
}


