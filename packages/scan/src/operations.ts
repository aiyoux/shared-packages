import { plainQuad } from './cloneable.js';
import { loadScanEngine } from './engines.js';
import { newScanId } from './geometry.js';
import { imageDataToBlob, snapshotImageData } from './pixels.js';
import type { Quad, ScanPage } from './types.js';
import { warpImageData } from './warp.js';

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
	const pixels =
		ArrayBuffer.isView(image.data) && image instanceof ImageData
			? image
			: snapshotImageData(image);
	const corners = plainQuad(quad);
	let warped = warpImageData(pixels, corners, opts.maxEdge);
	if (opts.enhance) {
		const engine = await loadScanEngine();
		warped = await engine.enhance(warped);
	}
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
