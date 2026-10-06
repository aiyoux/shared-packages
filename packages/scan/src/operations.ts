import { plainQuad } from './cloneable.js';
import { loadScanEngine } from './engines.js';
import { newScanId } from './geometry.js';
import { imageDataToBlob, snapshotImageData } from './pixels.js';
import type { Quad, ScanPage } from './types.js';
import { warpImageData } from './warp.js';

export type CommitOptions = {
	enhance?: boolean;
	ocr?: boolean;
	/** Reads text for the committed page. Default: the shared tesseract 'eng' runner. */
	ocrRunner?: (blob: Blob) => Promise<string>;
	maxEdge?: number;
	/** JPEG quality 0–1. Default 0.92. */
	quality?: number;
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
	const blob = await imageDataToBlob(warped, 'image/jpeg', opts.quality ?? 0.92);
	let text: string | undefined;
	if (opts.ocr) {
		// The caller picks the engine (scan's OCR reads through the shared
		// engine selection); the default stays tesseract 'eng'.
		const readText = opts.ocrRunner ?? (async (blob: Blob) => {
			const { recognizeText } = await import('@shared-packages/ocr');
			return recognizeText(blob);
		});
		text = await readText(blob);
	}
	return {
		id: newScanId(),
		blob,
		width: warped.width,
		height: warped.height,
		text
	};
}
