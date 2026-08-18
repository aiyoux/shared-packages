import { outputSize } from './geometry.js';
import type { Point, Quad } from './types.js';

/**
 * Perspective-warp `image` so `quad` becomes a flat rectangle.
 * Runs on the main thread — OpenCV.js warpPerspective wedges in the worker
 * in the build we ship, so Keep page cannot depend on it.
 */
export function warpImageData(image: ImageData, quad: Quad, maxEdge = 1600): ImageData {
	const size = outputSize(quad, maxEdge);
	if (!(size.width > 1) || !(size.height > 1) || size.width * size.height > 8_000_000) {
		throw new Error(`Refusing to warp to ${size.width}×${size.height}`);
	}
	const H = destToSrcHomography(quad, size.width, size.height);
	const src = image.data;
	const sw = image.width;
	const sh = image.height;
	const out = new ImageData(size.width, size.height);
	const dst = out.data;
	for (let y = 0; y < size.height; y++) {
		for (let x = 0; x < size.width; x++) {
			const p = applyH(H, x + 0.5, y + 0.5);
			const i = (y * size.width + x) * 4;
			sampleBilinear(src, sw, sh, p.x, p.y, dst, i);
		}
	}
	return out;
}

/** 3×3 row-major homography mapping dest pixels → source pixels. */
export function destToSrcHomography(srcQuad: Quad, destW: number, destH: number): number[] {
	const dest: Quad = [
		{ x: 0, y: 0 },
		{ x: destW, y: 0 },
		{ x: destW, y: destH },
		{ x: 0, y: destH }
	];
	return homography(dest, srcQuad);
}

export function applyH(H: number[], x: number, y: number): Point {
	const w = H[6]! * x + H[7]! * y + H[8]!;
	const inv = w !== 0 ? 1 / w : 0;
	return {
		x: (H[0]! * x + H[1]! * y + H[2]!) * inv,
		y: (H[3]! * x + H[4]! * y + H[5]!) * inv
	};
}

/** Direct linear transform, H[8] normalized to 1. */
export function homography(from: Quad, to: Quad): number[] {
	const A: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const x = from[i]!.x;
		const y = from[i]!.y;
		const u = to[i]!.x;
		const v = to[i]!.y;
		A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
		b.push(u);
		A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
		b.push(v);
	}
	const h = solve8(A, b);
	h.push(1);
	return h;
}

function solve8(A: number[][], b: number[]): number[] {
	const n = 8;
	const M = A.map((row, i) => [...row, b[i]!]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) {
			if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
		}
		const tmp = M[col]!;
		M[col] = M[pivot]!;
		M[pivot] = tmp;
		const div = M[col]![col]!;
		if (Math.abs(div) < 1e-12) continue;
		for (let c = col; c <= n; c++) M[col]![c]! /= div;
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = M[r]![col]!;
			for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
		}
	}
	return M.map((row) => row[n]!);
}

function sampleBilinear(
	src: Uint8ClampedArray,
	w: number,
	h: number,
	x: number,
	y: number,
	dst: Uint8ClampedArray,
	di: number
) {
	if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) {
		const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
		const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
		const si = (iy * w + ix) * 4;
		dst[di] = src[si]!;
		dst[di + 1] = src[si + 1]!;
		dst[di + 2] = src[si + 2]!;
		dst[di + 3] = src[si + 3]!;
		return;
	}
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const dx = x - x0;
	const dy = y - y0;
	const x1 = x0 + 1;
	const y1 = y0 + 1;
	const i00 = (y0 * w + x0) * 4;
	const i10 = (y0 * w + x1) * 4;
	const i01 = (y1 * w + x0) * 4;
	const i11 = (y1 * w + x1) * 4;
	for (let c = 0; c < 4; c++) {
		const v00 = src[i00 + c]!;
		const v10 = src[i10 + c]!;
		const v01 = src[i01 + c]!;
		const v11 = src[i11 + c]!;
		dst[di + c] = Math.round(
			v00 * (1 - dx) * (1 - dy) + v10 * dx * (1 - dy) + v01 * (1 - dx) * dy + v11 * dx * dy
		);
	}
}
