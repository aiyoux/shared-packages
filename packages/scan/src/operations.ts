import { loadScanEngine } from './engines.js';
import { newScanId } from './geometry.js';
import { imageDataToBlob } from './pixels.js';
import type { Quad, ScanPage } from './types.js';

export type CommitOptions = {
	enhance?: boolean;
	ocr?: boolean;
	maxEdge?: number;
};

/** Warp a still (and optionally enhance + OCR) into a session page. */
export async function commitScan(
	image: ImageData,
	quad: Quad,
	opts: CommitOptions = {}
): Promise<ScanPage> {
	const engine = await loadScanEngine();
	let warped = engine.warp(image, quad, { maxEdge: opts.maxEdge });
	if (opts.enhance) warped = engine.enhance(warped);
	const blob = await imageDataToBlob(warped, 'image/jpeg', 0.92);
	let text: string | undefined;
	if (opts.ocr) {
		const { recognizeText } = await import('./ocr.js');
		text = await recognizeText(blob);
	}
	return {
		id: newScanId(),
		blob,
		width: warped.width,
		height: warped.height,
		text
	};
}
