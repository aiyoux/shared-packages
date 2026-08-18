import type { ScanEngine, ScanLoadProgress } from './types.js';

const CACHE_KEY = '__spScanEngine';
const URL_KEY = '__spScanOpenCvUrl';

function getCached(): ScanEngine | null {
	return ((globalThis as Record<string, unknown>)[CACHE_KEY] as ScanEngine | undefined) ?? null;
}

function setCached(engine: ScanEngine | null) {
	(globalThis as Record<string, unknown>)[CACHE_KEY] = engine;
}

let cached: ScanEngine | null = getCached();
let opencvUrl: string | undefined = (globalThis as Record<string, unknown>)[URL_KEY] as
	| string
	| undefined;

export type LoadScanOptions = {
	/** Classic-script URL for opencv.js (required in Vite/ESM). */
	opencvUrl?: string;
	/** Download / worker-init progress. Safe to call from the UI. */
	onProgress?: (info: ScanLoadProgress) => void;
};

export function setOpenCvUrl(url: string) {
	opencvUrl = url;
	(globalThis as Record<string, unknown>)[URL_KEY] = url;
}

export function getOpenCvUrl(): string | undefined {
	return opencvUrl ?? ((globalThis as Record<string, unknown>)[URL_KEY] as string | undefined);
}

/** Load OpenCV.js once. Safe to call from the UI on “Start camera”. */
export async function loadScanEngine(opts: LoadScanOptions = {}): Promise<ScanEngine> {
	if (opts.opencvUrl) setOpenCvUrl(opts.opencvUrl);
	cached = getCached();
	if (cached) return cached;
	const { opencvEngine, setOpenCvProgress } = await import('./engines/opencv.js');
	setOpenCvProgress(opts.onProgress);
	try {
		await opencvEngine.load();
	} finally {
		setOpenCvProgress(undefined);
	}
	cached = opencvEngine;
	setCached(cached);
	return cached;
}

export function peekScanEngine(): ScanEngine | null {
	return cached;
}
