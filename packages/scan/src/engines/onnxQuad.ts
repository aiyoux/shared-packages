/**
 * Generic single-file ONNX quad detector (DocQuadNet, DocAligner, YOLO-pose).
 *
 * Weights download on first `load()` into the browser HTTP cache and run in
 * onnxruntime-web (wasm), already vendored by host apps. Warp is the shared
 * pure-JS perspective warp; enhance delegates to the OpenCV worker.
 *
 * Two output decodings, selected per detector in `detectors.ts`:
 *   - `heatmap`: corner heatmaps `[1, 4, H, W]` (TL, TR, BR, BL channels),
 *     one argmax per channel, sigmoid-normalized with a peak gate.
 *   - `yolo-pose`: standard pose output `[1, 5 + 3*K, N]` rows
 *     cx, cy, w, h, score, then (x, y, conf) per keypoint; best-scoring
 *     detection wins. K=4 document corners here, sizes normalized 0..1.
 */
import { orderCorners } from '../geometry.js';
import type { OnnxDecodeMode } from '../detectors.js';
import type { DetectOptions, EnhanceOptions, Quad, ScanDetectorId, ScanEngine, ScanLoadProgress, WarpOptions } from '../types.js';
import { learnedEnhance, learnedWarp } from './learned.js';

export type LetterboxMap = {
	size: number;
	scale: number;
	dx: number;
	dy: number;
};

export function letterboxFor(srcW: number, srcH: number, size: number): LetterboxMap {
	const scale = Math.min(size / Math.max(1, srcW), size / Math.max(1, srcH));
	return { size, scale, dx: (size - srcW * scale) / 2, dy: (size - srcH * scale) / 2 };
}

/** Model-space point back to source-image pixels. */
export function unletterbox(x: number, y: number, map: LetterboxMap): { x: number; y: number } {
	return { x: (x - map.dx) / map.scale, y: (y - map.dy) / map.scale };
}

function sigmoid(v: number): number {
	return 1 / (1 + Math.exp(-v));
}

/**
 * Letterboxed RGB float32 NCHW input. Padding is black; document models are
 * trained on dark-background letterboxes far more often than stretched input.
 */
export function preprocessLetterbox(image: ImageData, size: number): { input: Float32Array; map: LetterboxMap } {
	const map = letterboxFor(image.width, image.height, size);
	const input = new Float32Array(3 * size * size);
	const src = image.data;
	const sw = image.width;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const sx = Math.min(sw - 1, Math.max(0, Math.floor((x - map.dx) / map.scale)));
			const sy = Math.min(image.height - 1, Math.max(0, Math.floor((y - map.dy) / map.scale)));
			const si = (sy * sw + sx) * 4;
			const di = y * size + x;
			input[di] = src[si]! / 255;
			input[size * size + di] = src[si + 1]! / 255;
			input[2 * size * size + di] = src[si + 2]! / 255;
		}
	}
	return { input, map };
}

export type HeatmapTensor = { data: Float32Array; channels: number; height: number; width: number };

/**
 * Argmax each corner channel. Returns null when the weakest corner peak is
 * below `minPeak` (post-sigmoid) — tune against the labelled corpus, never
 * against one photo.
 */
export function heatmapToQuad(
	heatmap: HeatmapTensor,
	map: LetterboxMap,
	minPeak = 0.25
): Quad | null {
	const { data, channels, height, width } = heatmap;
	if (channels < 4 || height < 2 || width < 2) return null;
	const plane = height * width;
	const pts: { x: number; y: number }[] = [];
	let weakest = Infinity;
	for (let c = 0; c < 4; c++) {
		const off = c * plane;
		let best = 0;
		let bestVal = -Infinity;
		for (let i = 0; i < plane; i++) {
			const v = data[off + i]!;
			if (v > bestVal) {
				bestVal = v;
				best = i;
			}
		}
		const peak = sigmoid(bestVal);
		if (peak < weakest) weakest = peak;
		const bx = best % width;
		const by = Math.floor(best / width);
		const p = unletterbox((bx + 0.5) * (map.size / width), (by + 0.5) * (map.size / height), map);
		pts.push(p);
	}
	if (weakest < minPeak) return null;
	return orderCorners(pts);
}

export type YoloPoseTensor = { data: Float32Array; rows: number; cols: number };

/**
 * Decode a standard YOLO pose output. `keypoints` must match the trained
 * head (4 for document corners). Gate is the sigmoid box score; per-keypoint
 * confidences below `minKptConf` pull their corner toward the box center
 * rather than trusting a stray peak.
 */
export function yoloPoseToQuad(
	output: YoloPoseTensor,
	map: LetterboxMap,
	keypoints = 4,
	minScore = 0.25,
	minKptConf = 0.15
): Quad | null {
	const { data, rows, cols } = output;
	const wantRows = 5 + 3 * keypoints;
	if (rows < wantRows || cols < 1) return null;
	let best = -1;
	let bestScore = -Infinity;
	for (let n = 0; n < cols; n++) {
		const s = sigmoid(data[4 * cols + n]!);
		if (s > bestScore) {
			bestScore = s;
			best = n;
		}
	}
	if (best < 0 || bestScore < minScore) return null;
	const at = (row: number) => data[row * cols + best]!;
	const cx = at(0) * map.size;
	const cy = at(1) * map.size;
	const pts: { x: number; y: number }[] = [];
	for (let k = 0; k < keypoints; k++) {
		const kx = at(5 + 3 * k) * map.size;
		const ky = at(5 + 3 * k + 1) * map.size;
		const kc = sigmoid(at(5 + 3 * k + 2));
		const t = kc >= minKptConf ? 1 : kc / minKptConf;
		const p = unletterbox(cx + (kx - cx) * t, cy + (ky - cy) * t, map);
		pts.push(p);
	}
	return orderCorners(pts);
}

export type OnnxQuadConfig = {
	id: ScanDetectorId;
	modelUrl: string;
	mode: OnnxDecodeMode;
	inputSize: number;
	keypoints?: number;
	onProgress?: (info: ScanLoadProgress) => void;
};

/** Structural ORT surface — no dependency on the runtime's own types. */
export type OrtTensorLike = {
	readonly data: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray;
	readonly dims: readonly number[];
};
export type OrtSessionLike = {
	readonly inputNames: readonly string[];
	run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
};
export type OrtRuntimeLike = {
	InferenceSession: {
		create(model: string | Uint8Array, opts?: unknown): Promise<OrtSessionLike>;
	};
	Tensor: new (
		type: 'float32',
		data: Float32Array | Uint8ClampedArray | number[],
		dims: readonly number[]
	) => OrtTensorLike;
};
type OrtModule = OrtRuntimeLike;
type OrtSession = OrtSessionLike;

function reportProgress(config: OnnxQuadConfig, info: ScanLoadProgress) {
	try {
		config.onProgress?.(info);
	} catch {
		/* UI progress must not break load */
	}
}

async function downloadModel(url: string, config: OnnxQuadConfig): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to download ${config.id} weights from ${url} (${res.status})`);
	const total = Number(res.headers.get('content-length')) || 0;
	if (!res.body) {
		const buf = new Uint8Array(await res.arrayBuffer());
		reportProgress(config, { phase: 'download', loaded: buf.byteLength, total: buf.byteLength });
		return buf;
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			loaded += value.byteLength;
			reportProgress(config, { phase: 'download', loaded, total });
		}
	}
	const out = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	reportProgress(config, { phase: 'download', loaded, total: total || loaded });
	return out;
}

function pickTensor(
	named: Record<string, { data: unknown; dims: readonly number[] }>,
	pick: (name: string, dims: readonly number[]) => boolean
): { data: Float32Array; dims: readonly number[] } | null {
	for (const [name, tensor] of Object.entries(named)) {
		if (pick(name, tensor.dims) && tensor.data instanceof Float32Array) {
			return { data: tensor.data, dims: tensor.dims };
		}
	}
	return null;
}

export function createOnnxQuadEngine(config: OnnxQuadConfig): ScanEngine {
	let ort: OrtModule | null = null;
	let session: OrtSession | null = null;
	let loadPromise: Promise<void> | null = null;

	async function load() {
		if (session) return;
		if (!loadPromise) {
			loadPromise = (async () => {
				if (typeof Worker === 'undefined' && typeof window === 'undefined') {
					throw new Error(`${config.id} needs a browser worker context.`);
				}
				ort = (await import('onnxruntime-web')) as unknown as OrtModule;
				const bytes = await downloadModel(config.modelUrl, config);
				reportProgress(config, { phase: 'init' });
				session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
			})().catch((err) => {
				loadPromise = null;
				session = null;
				throw err;
			});
		}
		await loadPromise;
	}

	return {
		id: config.id,

		async load() {
			await load();
		},

		async detectQuad(image: ImageData, _opts: DetectOptions = {}) {
			await load();
			const active = session;
			const runtime = ort;
			if (!active || !runtime) throw new Error(`${config.id} session is not loaded.`);
			const { input, map } = preprocessLetterbox(image, config.inputSize);
			const inputName = active.inputNames[0];
			if (!inputName) throw new Error(`${config.id} model has no inputs.`);
			const feeds = {
				[inputName]: new runtime.Tensor('float32', input, [1, 3, config.inputSize, config.inputSize])
			};
			const named = (await active.run(feeds)) as Record<string, { data: unknown; dims: readonly number[] }>;
			if (config.mode === 'heatmap') {
				const found = pickTensor(
					named,
					(name, dims) => dims.length === 4 && dims[1] === 4 && name.toLowerCase().includes('heat')
				) ?? pickTensor(named, (_name, dims) => dims.length === 4 && dims[1] === 4);
				if (!found) throw new Error(`${config.id} model returned no [1,4,H,W] heatmap tensor.`);
				const [, channels, height, width] = found.dims;
				return heatmapToQuad({ data: found.data, channels: channels!, height: height!, width: width! }, map);
			}
			const found = pickTensor(named, (_name, dims) => dims.length === 3 && dims[0] === 1);
			if (!found) throw new Error(`${config.id} model returned no [1,K,N] pose tensor.`);
			const [, rows, cols] = found.dims;
			return yoloPoseToQuad(
				{ data: found.data, rows: rows!, cols: cols! },
				map,
				config.keypoints ?? 4
			);
		},

		async warp(image, quad, opts: WarpOptions = {}) {
			return learnedWarp(image, quad, opts);
		},

		async enhance(image, _opts: EnhanceOptions = {}) {
			return learnedEnhance(image);
		}
	};
}
