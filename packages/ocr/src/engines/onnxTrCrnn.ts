/** docTR's OnnxTR CRNN recognizer (the sketcher `mindee` engine), moved from
 * `apps/svg-sketcher/src/lib/hwr/{mindeeEngine,onnxCrnn,ctc}.ts` — three
 * files merged, behavior byte-for-byte. Detection-free: it reads one
 * already-cropped line. Both the `OcrEngine` wrapper and the underlying
 * primitives are exported (sketcher's adapter uses the primitives to keep
 * its scene-space bounds). */
import { browserModelStore } from '@shared-packages/model-store';
import { MINDEE_MODEL } from '../models.js';
import { inputToCanvas } from '../pixels.js';
import type { OcrEngine, OcrInput, OcrResult } from '../types.js';

/** Structurally-typed ORT surface: the ort d.ts drifts between the app
 * aliases (sketcher pins `ort.wasm.min.mjs`) and the published types, so the
 * engine only names what it uses. */
type OrtTensorLike = { type: string; data: Float32Array; dims: readonly number[]; dispose(): void };
type OrtSessionLike = {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
	release(): Promise<void>;
};
type OrtModule = {
	env: { wasm: { wasmPaths: string; numThreads: number } };
	InferenceSession: {
		create(data: ArrayBuffer | Uint8Array, options?: { executionProviders?: readonly string[] }): Promise<OrtSessionLike>;
	};
	Tensor: new (type: string, data: Float32Array, dims: number[]) => { dispose(): void };
};

/** Collapse CTC best-path: skip blanks and repeated labels. */
export function decodeCtc(indices: ArrayLike<number>, vocab: string, blankIndex = vocab.length): string {
	let out = '';
	let prev = -1;
	for (let i = 0; i < indices.length; i++) {
		const k = indices[i]!;
		if (k === blankIndex) {
			prev = k;
			continue;
		}
		if (k !== prev && k >= 0 && k < vocab.length) out += vocab[k];
		prev = k;
	}
	return out;
}

/** Mindee docTR tfjs CRNN charset (blank is index 126). */
export const MINDEE_VOCAB =
	"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~°£€¥¢฿àâéèêëîïôùûüçÀÂÉÈÊËÎÏÔÙÛÜÇ";

export type CrnnConfig = {
	mean: number[];
	std: number[];
	input_shape: number[];
	vocab: string;
};

/** Fail explicitly if an imported config doesn't describe the supported CRNN. */
export function parseCrnnConfig(value: unknown): CrnnConfig {
	const cfg = value as CrnnConfig | null;
	if (!cfg || !Array.isArray(cfg.input_shape) || cfg.input_shape.length !== 3 ||
		cfg.input_shape.some((n, index) => n !== [3, 32, 128][index]) ||
		cfg.vocab !== MINDEE_VOCAB || !Array.isArray(cfg.mean) || cfg.mean.length !== 3 ||
		!cfg.mean.every(Number.isFinite) || !Array.isArray(cfg.std) || cfg.std.length !== 3 ||
		!cfg.std.every((n) => Number.isFinite(n) && n > 0)) {
		throw new Error('Unsupported OnnxTR CRNN configuration');
	}
	return cfg;
}

/** OnnxTR's aspect-preserving resize, bottom/right black padding and RGB
 * normalization. ONNX expects NCHW, whereas the old TF.js graph used NHWC. */
export function crnnInput(source: HTMLCanvasElement, cfg: CrnnConfig): Float32Array {
	if (source.width < 1 || source.height < 1) throw new Error('Empty recognition raster');
	const [, height, width] = cfg.input_shape as [number, number, number];
	// Set the limiting side exactly: floor(height * (32 / height)) can be 31
	// through floating-point rounding (e.g. a 49px source).
	const tall = source.height / source.width > height / width;
	const resizedWidth = tall ? Math.max(1, Math.floor(height * source.width / source.height)) : width;
	const resizedHeight = tall ? height : Math.max(1, Math.floor(width * source.height / source.width));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Canvas is unavailable for recognition');
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(source, 0, 0, resizedWidth, resizedHeight);
	const rgba = ctx.getImageData(0, 0, width, height).data;
	const plane = width * height;
	const data = new Float32Array(3 * plane);
	for (let channel = 0; channel < 3; channel++) {
		for (let pixel = 0; pixel < plane; pixel++) {
			data[channel * plane + pixel] = (rgba[pixel * 4 + channel]! / 255 - cfg.mean[channel]!) / cfg.std[channel]!;
		}
	}
	return data;
}

/** Greedy CTC: softmax preserves argmax, so no extra probability tensor is needed. */
export function crnnText(data: ArrayLike<number>, dims: readonly number[], vocab = MINDEE_VOCAB): string {
	const classes = vocab.length + 1;
	if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== classes ||
		!Number.isInteger(dims[1]) || dims[1]! < 1 || data.length !== dims[1]! * classes) {
		throw new Error(`Unexpected OnnxTR CRNN output shape: ${dims.join('×')}`);
	}
	const indices = new Int32Array(dims[1]!);
	for (let step = 0; step < indices.length; step++) {
		let best = 0;
		for (let label = 1; label < classes; label++) {
			if (data[step * classes + label]! > data[step * classes + best]!) best = label;
		}
		indices[step] = best;
	}
	return decodeCtc(indices, vocab).trim();
}

type CrnnHandle = { session: OrtSessionLike; config: CrnnConfig };
let model: CrnnHandle | null = null;
let loading: Promise<CrnnHandle> | null = null;

/** Weights and config are read from one ready model-store snapshot. The ORT
 * runtime is vendored on our origin; this engine never downloads weights. */
export async function getMindeeModel(): Promise<CrnnHandle> {
	if (model) return model;
	if (!loading) {
		loading = (async () => {
			const { bytes, config } = await browserModelStore.readReady(MINDEE_MODEL, async (files) => ({
				bytes: await (await files.file('model.onnx')).arrayBuffer(),
				config: parseCrnnConfig(JSON.parse(await (await files.file('config.json')).text()))
			}));
			const ort = (await import('onnxruntime-web')) as unknown as OrtModule;
			ort.env.wasm.wasmPaths = '/vendor/ort/';
			ort.env.wasm.numThreads = 1;
			const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
			if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
				await session.release();
				throw new Error('Unsupported OnnxTR CRNN inputs or outputs');
			}
			model = { session, config };
			return model;
		})().catch((error) => {
			loading = null;
			throw error;
		});
	}
	return loading;
}

/** Whole-image engine view of a detection-free recognizer: one region
 * covering the input, or none when nothing was read. */
export function createMindeeEngine(): OcrEngine {
	return {
		id: 'mindee',
		async recognize(input: OcrInput): Promise<OcrResult> {
			const { session, config } = await getMindeeModel();
			const canvas = await inputToCanvas(input);
			const { Tensor } = (await import('onnxruntime-web')) as unknown as OrtModule;
			const tensorInput = new Tensor('float32', crnnInput(canvas, config), [1, ...config.input_shape]);
			let outputs: Record<string, OrtTensorLike> | undefined;
			try {
				outputs = await session.run({ [session.inputNames[0]!]: tensorInput });
				const logits = outputs[session.outputNames[0]!]!;
				if (logits.type !== 'float32') throw new Error('Unsupported OnnxTR CRNN output type');
				const word = crnnText(logits.data, logits.dims, config.vocab);
				const box = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
				return { text: word, regions: word ? [{ text: word, box }] : [] };
			} finally {
				tensorInput.dispose();
				if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
			}
		}
	};
}