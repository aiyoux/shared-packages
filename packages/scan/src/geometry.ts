import { plainQuad } from './cloneable.js';
import {
	dist,
	orderCorners as orderCornersUnchecked,
	orthoScore,
	outputSize,
	quadArea
} from './detect/algorithm.js';
import type { ContainRect, Point, Quad } from './types.js';

// Single source of truth: these also have to run inside the OpenCV worker, so
// they live in ./detect/algorithm.ts, which is emitted into it as source text.
export { dist, outputSize, quadArea };

/**
 * 1 = every corner is a right angle; 0 = collapsed / wildly skewed.
 * Used to prefer a page rectangle over a diamond min-area-rect of floor grain.
 */
export const quadOrthogonality = orthoScore;

export function newScanId(): string {
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Sort four points into TL, TR, BR, BL. */
export function orderCorners(pts: Point[]): Quad {
	if (pts.length !== 4) throw new Error('orderCorners expects 4 points');
	return orderCornersUnchecked(pts);
}

export function quadsClose(a: Quad, b: Quad, maxPx: number): boolean {
	for (let i = 0; i < 4; i++) {
		if (dist(a[i]!, b[i]!) > maxPx) return false;
	}
	return true;
}

/** Fit src into box (object-fit: contain). */
export function containRect(srcW: number, srcH: number, boxW: number, boxH: number): ContainRect {
	if (!(srcW > 0) || !(srcH > 0) || !(boxW > 0) || !(boxH > 0)) {
		return { x: 0, y: 0, width: boxW, height: boxH, scale: 1 };
	}
	const scale = Math.min(boxW / srcW, boxH / srcH);
	const width = srcW * scale;
	const height = srcH * scale;
	return {
		x: (boxW - width) / 2,
		y: (boxH - height) / 2,
		width,
		height,
		scale
	};
}

export function imageToDisplay(p: Point, box: ContainRect): Point {
	return { x: box.x + p.x * box.scale, y: box.y + p.y * box.scale };
}

export function displayToImage(p: Point, box: ContainRect, srcW: number, srcH: number): Point {
	const x = (p.x - box.x) / (box.scale || 1);
	const y = (p.y - box.y) / (box.scale || 1);
	return {
		x: Math.max(0, Math.min(srcW, x)),
		y: Math.max(0, Math.min(srcH, y))
	};
}

export function fullFrameQuad(width: number, height: number, insetRatio = 0.08): Quad {
	const inset = Math.min(width, height) * insetRatio;
	return orderCorners([
		{ x: inset, y: inset },
		{ x: width - inset, y: inset },
		{ x: width - inset, y: height - inset },
		{ x: inset, y: height - inset }
	]);
}

export function cloneQuad(q: Quad): Quad {
	return plainQuad(q);
}
