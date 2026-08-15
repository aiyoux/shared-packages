import type { ContainRect, Point, Quad } from './types.js';

export function newScanId(): string {
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function dist(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function quadArea(q: Quad): number {
	// Shoelace
	let acc = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i]!;
		const b = q[(i + 1) % 4]!;
		acc += a.x * b.y - b.x * a.y;
	}
	return Math.abs(acc) / 2;
}

/** Sort four points into TL, TR, BR, BL. */
export function orderCorners(pts: Point[]): Quad {
	if (pts.length !== 4) throw new Error('orderCorners expects 4 points');
	const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
	const tl = bySum[0]!;
	const br = bySum[3]!;
	const rest = [bySum[1]!, bySum[2]!];
	const tr = rest[0]!.x >= rest[1]!.x ? rest[0]! : rest[1]!;
	const bl = rest[0]!.x >= rest[1]!.x ? rest[1]! : rest[0]!;
	return [tl, tr, br, bl];
}

export function quadsClose(a: Quad, b: Quad, maxPx: number): boolean {
	for (let i = 0; i < 4; i++) {
		if (dist(a[i]!, b[i]!) > maxPx) return false;
	}
	return true;
}

export function outputSize(quad: Quad, maxEdge = 1600): { width: number; height: number } {
	const [tl, tr, br, bl] = quad;
	const w = Math.max(dist(tl, tr), dist(bl, br));
	const h = Math.max(dist(tl, bl), dist(tr, br));
	if (!(w > 1) || !(h > 1)) return { width: 800, height: 1100 };
	const scale = Math.min(1, maxEdge / Math.max(w, h));
	return {
		width: Math.max(2, Math.round(w * scale / 2) * 2),
		height: Math.max(2, Math.round(h * scale / 2) * 2)
	};
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
	return [
		{ x: q[0].x, y: q[0].y },
		{ x: q[1].x, y: q[1].y },
		{ x: q[2].x, y: q[2].y },
		{ x: q[3].x, y: q[3].y }
	];
}
