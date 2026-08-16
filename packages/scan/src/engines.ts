import type { ScanEngine, ScanLoadProgress } from './types.js';

let cached: ScanEngine | null = null;
let opencvUrl: string | undefined;

export type LoadScanOptions = {
	/** Classic-script URL for opencv.js (required in Vite/ESM). */
	opencvUrl?: string;
	/** Download / worker-init progress. Safe to call from the UI. */
	onProgress?: (info: ScanLoadProgress) => void;
};

export function setOpenCvUrl(url: string) {
	opencvUrl = url;
}

export function getOpenCvUrl(): string | undefined {
	return opencvUrl;
}

/** Load OpenCV.js once. Safe to call from the UI on “Start camera”. */
export async function loadScanEngine(opts: LoadScanOptions = {}): Promise<ScanEngine> {
	if (opts.opencvUrl) opencvUrl = opts.opencvUrl;
	if (cached) return cached;
	const { opencvEngine, setOpenCvProgress } = await import('./engines/opencv.js');
	setOpenCvProgress(opts.onProgress);
	try {
		await opencvEngine.load();
	} finally {
		setOpenCvProgress(undefined);
	}
	cached = opencvEngine;
	return cached;
}

export function peekScanEngine(): ScanEngine | null {
	return cached;
}
