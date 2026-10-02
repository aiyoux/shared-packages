import { browserModelStore } from '@shared-packages/model-store';
import { SCAN_DETECTORS, resolveDetectorId } from './detectors.js';
import type { ScanDetectorId, ScanEngine, ScanLoadProgress } from './types.js';

const CACHE_KEY = '__spScanEngine';
const LAST_KEY = '__spScanLastDetector';
const URL_KEY = '__spScanOpenCvUrl';

const engines = new Map<ScanDetectorId, ScanEngine>();
let opencvUrl: string | undefined = (globalThis as Record<string, unknown>)[URL_KEY] as
	| string
	| undefined;

function getLast(): ScanDetectorId | null {
	const saved = (globalThis as Record<string, unknown>)[LAST_KEY] as unknown;
	const id = resolveDetectorId(saved);
	if (saved !== id) return null;
	return (saved as ScanDetectorId) ?? null;
}

function rememberLast(id: ScanDetectorId) {
	(globalThis as Record<string, unknown>)[LAST_KEY] = id;
	(globalThis as Record<string, unknown>)[CACHE_KEY] = engines.get(id) ?? null;
}

export type LoadScanOptions = {
	/** Detector backend. Defaults to the last loaded one, else `opencv`. */
	detector?: ScanDetectorId | string;
	/** Classic-script URL for opencv.js (required in Vite/ESM). */
	opencvUrl?: string;
	/** Download / init progress. Safe to call from the UI. */
	onProgress?: (info: ScanLoadProgress) => void;
};

export function setOpenCvUrl(url: string) {
	opencvUrl = url;
	(globalThis as Record<string, unknown>)[URL_KEY] = url;
}

export function getOpenCvUrl(): string | undefined {
	return opencvUrl ?? ((globalThis as Record<string, unknown>)[URL_KEY] as string | undefined);
}

/** Load (and cache, per detector) the selected detector engine. Safe to call from the UI. */
export async function loadScanEngine(opts: LoadScanOptions = {}): Promise<ScanEngine> {
	if (opts.detector !== undefined && resolveDetectorId(opts.detector) !== opts.detector) {
		throw new Error(`Unknown scan detector '${opts.detector}'. Refusing to substitute another backend.`);
	}
	const detector = resolveDetectorId(opts.detector ?? getLast() ?? undefined);
	if (opts.opencvUrl) setOpenCvUrl(opts.opencvUrl);
	const hit = engines.get(detector);
	if (hit) {
		rememberLast(detector);
		return hit;
	}
	const meta = SCAN_DETECTORS[detector];
	// Learned detectors fail here, naming the missing file, before any runtime loads.
	if (meta.model) await browserModelStore.require(meta.model);
	let engine: ScanEngine;
	if (detector === 'opencv') {
		const { opencvEngine, setOpenCvProgress } = await import('./engines/opencv.js');
		setOpenCvProgress(opts.onProgress);
		try {
			await opencvEngine.load();
		} finally {
			setOpenCvProgress(undefined);
		}
		engine = opencvEngine;
	} else if (detector === 'scanic') {
		const { createScanicEngine } = await import('./engines/scanic.js');
		engine = createScanicEngine({});
		await engine.load();
	} else {
		const { createOnnxQuadEngine } = await import('./engines/onnxQuad.js');
		const model = meta.model!;
		engine = createOnnxQuadEngine({
			id: detector,
			loadModel: (signal) => browserModelStore.readReady(model, async (files) =>
				new Uint8Array(await (await files.file(model.files[0]!.path)).arrayBuffer()), { signal }),
			mode: meta.decode ?? 'heatmap',
			inputSize: meta.modelInputSize ?? 256,
			keypoints: 4,
			onProgress: opts.onProgress
		});
		await engine.load();
	}
	engines.set(detector, engine);
	rememberLast(detector);
	return engine;
}

export function peekScanEngine(): ScanEngine | null {
	const last = getLast();
	if (last) return engines.get(last) ?? null;
	return (globalThis as Record<string, unknown>)[CACHE_KEY] as ScanEngine | null ?? null;
}
