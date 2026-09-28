/**
 * Scanic detector adapter (classical Canny + DocCornerNet ML backends).
 *
 * `scanic` is a real dependency but only ever dynamic-imported, so hosts
 * that never select this detector never load it. Detection runs
 * `scanDocument(image, { detector: 'ml', mode: 'detect' })` against the
 * vendored scanic-ml assets (`assetBaseUrl`); an explicit `modelUrl`
 * overrides just the weights. A failed or shape-changed result throws a
 * readable error — it never silently becomes another detector.
 */
import { orderCorners } from '../geometry.js';
import type { CornerPoints } from 'scanic';
import type { DetectOptions, EnhanceOptions, Quad, ScanEngine, WarpOptions } from '../types.js';
import { learnedEnhance, learnedWarp } from './learned.js';

/** Same-origin base for the scanic-ml `.ort` model + minimal ORT wasm. */
export const DEFAULT_SCANIC_ASSET_BASE_URL = '/vendor/scanic-ml/';

export type ScanicEngineConfig = {
	assetBaseUrl?: string;
	modelUrl?: string;
};

export function scanicCornersToQuad(corners: CornerPoints | null | undefined): Quad | null {
	if (!corners) return null;
	const { topLeft, topRight, bottomRight, bottomLeft } = corners;
	for (const p of [topLeft, topRight, bottomRight, bottomLeft]) {
		if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
	}
	return orderCorners([topLeft, topRight, bottomRight, bottomLeft]);
}

export function createScanicEngine(config: ScanicEngineConfig = {}): ScanEngine {
	let scanDocument: typeof import('scanic').scanDocument | null = null;
	let loadPromise: Promise<void> | null = null;

	async function load() {
		if (scanDocument) return;
		if (!loadPromise) {
			loadPromise = (async () => {
				const mod = await import('scanic');
				if (typeof mod.scanDocument !== 'function') {
					throw new Error('scanic has no scanDocument export. Refusing to substitute another detector.');
				}
				scanDocument = mod.scanDocument;
			})().catch((err) => {
				loadPromise = null;
				throw err;
			});
		}
		await loadPromise;
	}

	return {
		id: 'scanic',

		async load() {
			await load();
		},

		async detectQuad(image: ImageData, _opts: DetectOptions = {}) {
			await load();
			if (!scanDocument) throw new Error('Scanic detector is not loaded.');
			const result = await scanDocument(image, {
				detector: 'ml',
				mode: 'detect',
				ml: {
					assetBaseUrl: config.assetBaseUrl ?? DEFAULT_SCANIC_ASSET_BASE_URL,
					...(config.modelUrl ? { modelUrl: config.modelUrl } : {})
				}
			});
			if (!result.success) return null;
			return scanicCornersToQuad(result.corners);
		},

		async warp(image, quad, opts: WarpOptions = {}) {
			return learnedWarp(image, quad, opts);
		},

		async enhance(image, _opts: EnhanceOptions = {}) {
			return learnedEnhance(image);
		}
	};
}
