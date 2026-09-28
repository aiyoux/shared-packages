import { warpImageData } from '../warp.js';
import { snapshotImageData } from '../pixels.js';
import type { Quad, WarpOptions } from '../types.js';

/** Perspective warp on the main thread (pure JS, same as commitScan). */
export async function learnedWarp(image: ImageData, quad: Quad, opts: WarpOptions = {}) {
	return warpImageData(snapshotImageData(image), quad, opts.maxEdge);
}

/** Enhance stays on the OpenCV worker for every learned detector. */
export async function learnedEnhance(image: ImageData) {
	const { opencvEngine } = await import('./opencv.js');
	await opencvEngine.load();
	return opencvEngine.enhance(snapshotImageData(image));
}
