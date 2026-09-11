/**
 * Document detection, written as self-contained function declarations.
 *
 * Every function here is emitted verbatim into the OpenCV classic worker by
 * `buildWorkerSource()`, so the rules are strict:
 *   - function declarations only. A minifier rewrites `fn.name` and every call
 *     site together, so the emitted source stays internally consistent;
 *     `const fn = () => {}` loses its name and breaks that.
 *   - no module-scope references: no imports, no shared constants, no enums.
 *   - `import type` is fine — types are erased before stringification.
 *
 * Only the cv-touching entry points need OpenCV. The scoring model is pure, so
 * it is unit-testable in plain Node.
 */
import type { CvMat, CvRotatedRect, OpenCv } from '../cv-types.js';
import type { Point, Quad } from '../types.js';

/** Luminance/saturation lookup tables for one frame at detect scale. */
export type FrameEvidence = {
	width: number;
	height: number;
	lum: Float32Array;
	sat: Float32Array;
};

/** Per-term breakdown, kept for tests and for tuning against a labelled corpus. */
export type DocScore = {
	score: number;
	size: number;
	neutral: number;
	flat: number;
	border: number;
	contrast: number;
	sign: number;
	ortho: number;
	aspect: number;
	bright: number;
};

/**
 * Every constant the scoring model uses, in one place.
 *
 * These describe what a document *is* — near-neutral, flat, bounded by four
 * real edges, brighter than what it rests on — rather than what any single
 * photo happens to need. Change them against the labelled corpus, never
 * against one image.
 */
export function docConstants() {
	return {
		/** Interior grid resolution for colour/texture statistics. */
		interiorGrid: 22,
		/** Fraction of the quad ignored at each border when sampling interior. */
		interiorInset: 0.08,
		/** Samples taken along each of the four edges. */
		edgeSamples: 28,
		/** Border probe offset, as a fraction of the frame's short side. */
		probeRatio: 0.013,
		/** |inner - outer| luminance that counts as a real edge. */
		edgeDelta: 9,
		/** Saturation (0..255) at and below which a surface reads as neutral. */
		satLow: 34,
		/** Saturation at and above which a surface reads as coloured, not paper. */
		satHigh: 105,
		/** Local contrast that marks an interior sample as textured. */
		textureDelta: 22,
		/** Frame fraction below/above which a candidate is the wrong size. */
		fillMin: 0.02,
		fillRampTo: 0.1,
		fillPlateauTo: 0.7,
		fillMax: 0.985,
		/**
		 * Minimum combined score for a candidate to be reported at all.
		 * Measured on the labelled corpus: real documents score 0.87-0.99,
		 * document-free scenes peak at 0.37. This sits in that gap.
		 */
		acceptFloor: 0.6,
		weights: {
			size: 0.8,
			neutral: 1,
			flat: 0.7,
			border: 1.7,
			contrast: 0.9,
			sign: 0.8,
			ortho: 1,
			aspect: 0.6,
			bright: 0.35
		}
	};
}

export function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0 at `a`, 1 at `b`, linear between, clamped outside. */
export function ramp(v: number, a: number, b: number): number {
	if (a === b) return v >= b ? 1 : 0;
	return clamp01((v - a) / (b - a));
}

export function dist(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function orderCorners(pts: Point[]): Quad {
	const bySum = pts.slice().sort(function (a, b) {
		return a.x + a.y - (b.x + b.y);
	});
	const tl = bySum[0] as Point;
	const br = bySum[3] as Point;
	const rest = [bySum[1] as Point, bySum[2] as Point];
	const tr = rest[0].x >= rest[1].x ? rest[0] : rest[1];
	const bl = rest[0].x >= rest[1].x ? rest[1] : rest[0];
	return [tl, tr, br, bl];
}

export function quadArea(pts: Point[]): number {
	let acc = 0;
	for (let i = 0; i < 4; i++) {
		const a = pts[i] as Point;
		const b = pts[(i + 1) % 4] as Point;
		acc += a.x * b.y - b.x * a.y;
	}
	return Math.abs(acc) / 2;
}

export function quadCentroid(pts: Point[]): Point {
	let x = 0;
	let y = 0;
	for (let i = 0; i < 4; i++) {
		x += (pts[i] as Point).x;
		y += (pts[i] as Point).y;
	}
	return { x: x / 4, y: y / 4 };
}

/** Mean "how square is this corner", 1 when all four corners are right angles. */
export function orthoScore(pts: Point[]): number {
	let acc = 0;
	for (let i = 0; i < 4; i++) {
		const b = pts[i] as Point;
		const a = pts[(i + 3) % 4] as Point;
		const c = pts[(i + 1) % 4] as Point;
		const v1x = a.x - b.x;
		const v1y = a.y - b.y;
		const v2x = c.x - b.x;
		const v2y = c.y - b.y;
		const n1 = Math.hypot(v1x, v1y) || 1;
		const n2 = Math.hypot(v2x, v2y) || 1;
		acc += 1 - Math.min(1, Math.abs((v1x * v2x + v1y * v2y) / (n1 * n2)));
	}
	return acc / 4;
}

export function nearestOdd(n: number): number {
	const v = Math.max(3, Math.round(n));
	return v % 2 === 0 ? v + 1 : v;
}

export function outputSize(quad: Quad, maxEdge = 1600) {
	const limit = maxEdge || 1600;
	const tl = quad[0];
	const tr = quad[1];
	const br = quad[2];
	const bl = quad[3];
	const w = Math.max(dist(tl, tr), dist(bl, br));
	const h = Math.max(dist(tl, bl), dist(tr, br));
	if (!(w > 1) || !(h > 1)) return { width: 800, height: 1100 };
	const scale = Math.min(1, limit / Math.max(w, h));
	return {
		width: Math.max(2, Math.round((w * scale) / 2) * 2),
		height: Math.max(2, Math.round((h * scale) / 2) * 2)
	};
}

/** Geometric sanity only — appearance is judged separately by `scoreDocument`. */
export function usableQuad(pts: Point[] | null, width: number, height: number, minArea: number): boolean {
	if (!pts || pts.length !== 4) return false;
	if (quadArea(pts) < minArea) return false;
	const minSide = Math.min(width, height) * 0.06;
	for (let i = 0; i < 4; i++) {
		if (dist(pts[i] as Point, pts[(i + 1) % 4] as Point) < minSide) return false;
	}
	const slack = Math.max(width, height) * 0.08;
	for (let j = 0; j < 4; j++) {
		const p = pts[j] as Point;
		if (p.x < -slack || p.y < -slack) return false;
		if (p.x > width + slack || p.y > height + slack) return false;
	}
	return true;
}

/** Bilinear position inside a quad; u,v run 0..1 from the TL corner. */
export function quadPointAt(quad: Quad, u: number, v: number): Point {
	const tl = quad[0];
	const tr = quad[1];
	const br = quad[2];
	const bl = quad[3];
	const topX = tl.x + (tr.x - tl.x) * u;
	const topY = tl.y + (tr.y - tl.y) * u;
	const botX = bl.x + (br.x - bl.x) * u;
	const botY = bl.y + (br.y - bl.y) * u;
	return { x: topX + (botX - topX) * v, y: topY + (botY - topY) * v };
}

export function buildEvidence(rgba: Uint8ClampedArray, width: number, height: number): FrameEvidence {
	const n = width * height;
	const lum = new Float32Array(n);
	const sat = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const j = i * 4;
		const r = rgba[j] as number;
		const g = rgba[j + 1] as number;
		const b = rgba[j + 2] as number;
		lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
		const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
		const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
		sat[i] = mx - mn;
	}
	return { width: width, height: height, lum: lum, sat: sat };
}

export function insideFrame(ev: FrameEvidence, x: number, y: number): boolean {
	return x >= 0 && y >= 0 && x <= ev.width - 1 && y <= ev.height - 1;
}

export function sampleLum(ev: FrameEvidence, x: number, y: number): number {
	const px = x < 0 ? 0 : x > ev.width - 1 ? ev.width - 1 : x;
	const py = y < 0 ? 0 : y > ev.height - 1 ? ev.height - 1 : y;
	return ev.lum[(Math.round(py) * ev.width + Math.round(px)) | 0] as number;
}

export function sampleSat(ev: FrameEvidence, x: number, y: number): number {
	const px = x < 0 ? 0 : x > ev.width - 1 ? ev.width - 1 : x;
	const py = y < 0 ? 0 : y > ev.height - 1 ? ev.height - 1 : y;
	return ev.sat[(Math.round(py) * ev.width + Math.round(px)) | 0] as number;
}

/**
 * Edge evidence: does each side sit on a real luminance step, and do all four
 * sides step the same way?
 *
 * This is what stops the surface a document rests on from being reported as the
 * document. A cutting mat or a desk that runs out of frame has no step along the
 * sides that leave the picture, so its weakest side scores ~0. A page lying on
 * that surface has all four.
 */
export function edgeStats(ev: FrameEvidence, quad: Quad) {
	const k = docConstants();
	const centre = quadCentroid(quad);
	const probe = Math.max(2, Math.round(Math.min(ev.width, ev.height) * k.probeRatio));
	const supports: number[] = [];
	const medians: number[] = [];
	for (let s = 0; s < 4; s++) {
		const a = quad[s] as Point;
		const b = quad[(s + 1) % 4] as Point;
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const len = Math.hypot(ex, ey) || 1;
		let nx = -ey / len;
		let ny = ex / len;
		// Point the normal inwards.
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		if ((centre.x - mid.x) * nx + (centre.y - mid.y) * ny < 0) {
			nx = -nx;
			ny = -ny;
		}
		let supported = 0;
		const deltas: number[] = [];
		for (let i = 0; i < k.edgeSamples; i++) {
			const t = (i + 0.5) / k.edgeSamples;
			const px = a.x + ex * t;
			const py = a.y + ey * t;
			const ox = px - nx * probe;
			const oy = py - ny * probe;
			// A side that leaves the frame has no evidence behind it. Treat it as
			// unsupported rather than guessing, so "the whole surface" cannot win.
			if (!insideFrame(ev, ox, oy)) continue;
			const inner = sampleLum(ev, px + nx * probe, py + ny * probe);
			const outer = sampleLum(ev, ox, oy);
			const d = inner - outer;
			deltas.push(d);
			if (Math.abs(d) >= k.edgeDelta) supported++;
		}
		supports.push(supported / k.edgeSamples);
		if (deltas.length) {
			deltas.sort(function (x, y) {
				return x - y;
			});
			medians.push(deltas[(deltas.length / 2) | 0] as number);
		} else {
			medians.push(0);
		}
	}
	let weakest = 1;
	for (let i = 0; i < 4; i++) weakest = Math.min(weakest, supports[i] as number);
	let absAcc = 0;
	let signAcc = 0;
	for (let i = 0; i < 4; i++) {
		const m = medians[i] as number;
		absAcc += Math.abs(m);
		signAcc += m > 0 ? 1 : m < 0 ? -1 : 0;
	}
	return {
		weakestSide: weakest,
		meanAbsDelta: absAcc / 4,
		signConsistency: Math.abs(signAcc) / 4,
		brighterInside: signAcc > 0
	};
}

/**
 * Interior evidence: is the surface neutral, flat and light?
 *
 * `modeShare` is the fraction of the interior sitting near its most common
 * tone. A page — even a dense page of text — is mostly one tone; a printed
 * grid, a keyboard or a wood grain is not.
 */
export function interiorStats(ev: FrameEvidence, quad: Quad) {
	const k = docConstants();
	const lo = k.interiorInset;
	const hi = 1 - k.interiorInset;
	const step = Math.max(2, Math.round(Math.min(ev.width, ev.height) * 0.008));
	const bins = new Float32Array(32);
	let n = 0;
	let satAcc = 0;
	let lumAcc = 0;
	let textured = 0;
	for (let gy = 0; gy < k.interiorGrid; gy++) {
		for (let gx = 0; gx < k.interiorGrid; gx++) {
			const u = lo + ((hi - lo) * (gx + 0.5)) / k.interiorGrid;
			const v = lo + ((hi - lo) * (gy + 0.5)) / k.interiorGrid;
			const p = quadPointAt(quad, u, v);
			const l = sampleLum(ev, p.x, p.y);
			satAcc += sampleSat(ev, p.x, p.y);
			lumAcc += l;
			bins[Math.min(31, (l / 8) | 0)] = (bins[Math.min(31, (l / 8) | 0)] as number) + 1;
			const local = Math.max(
				Math.abs(l - sampleLum(ev, p.x - step, p.y)),
				Math.abs(l - sampleLum(ev, p.x + step, p.y)),
				Math.abs(l - sampleLum(ev, p.x, p.y - step)),
				Math.abs(l - sampleLum(ev, p.x, p.y + step))
			);
			if (local >= k.textureDelta) textured++;
			n++;
		}
	}
	if (!n) return { meanSat: 255, meanLum: 0, modeShare: 0, textureShare: 1 };
	let mode = 0;
	for (let i = 1; i < 32; i++) if ((bins[i] as number) > (bins[mode] as number)) mode = i;
	const near =
		(bins[mode] as number) +
		(mode > 0 ? (bins[mode - 1] as number) : 0) +
		(mode < 31 ? (bins[mode + 1] as number) : 0);
	return {
		meanSat: satAcc / n,
		meanLum: lumAcc / n,
		modeShare: near / n,
		textureShare: textured / n
	};
}

/**
 * Combine the evidence into one 0..1 score.
 *
 * A weighted geometric mean, so a term near zero vetoes the candidate rather
 * than being averaged away — a quad with one imaginary side is not a document
 * no matter how large or how white it is. Note that raw area is deliberately
 * absent: size enters only through the bounded `size` term, which is why the
 * biggest rectangle in frame no longer wins by default.
 */
export function scoreDocument(ev: FrameEvidence, quad: Quad): DocScore {
	const k = docConstants();
	const frameArea = ev.width * ev.height || 1;
	const fill = quadArea(quad) / frameArea;

	let size: number;
	if (fill <= k.fillMin) size = 0;
	else if (fill < k.fillRampTo) size = ramp(fill, k.fillMin, k.fillRampTo);
	else if (fill <= k.fillPlateauTo) size = 1;
	else size = 0.12 + 0.88 * (1 - ramp(fill, k.fillPlateauTo, k.fillMax));

	const inner = interiorStats(ev, quad);
	const edges = edgeStats(ev, quad);

	const neutral = 0.06 + 0.94 * (1 - ramp(inner.meanSat, k.satLow, k.satHigh));
	const flat = 0.1 + 0.9 * clamp01(inner.modeShare * 1.25 - 0.15) * (1 - 0.55 * clamp01(inner.textureShare * 1.6));
	const bright = 0.35 + 0.65 * ramp(inner.meanLum, 45, 135);

	const border = 0.02 + 0.98 * ramp(edges.weakestSide, 0.15, 0.7);
	const contrast = 0.08 + 0.92 * ramp(edges.meanAbsDelta, 6, 34);
	// A document is uniformly lighter (or uniformly darker) than what surrounds
	// it. Sides that disagree mean the quad straddles unrelated regions.
	const sign = 0.15 + 0.85 * edges.signConsistency * (edges.brighterInside ? 1 : 0.75);

	const ortho = 0.05 + 0.95 * orthoScore(quad);
	const w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
	const h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
	let ar = w / (h || 1);
	if (ar < 1) ar = 1 / ar;
	const aspect = ar < 2.2 ? 1 : ar < 3 ? 0.5 : 0.12;

	const wt = k.weights;
	const logSum =
		wt.size * Math.log(Math.max(1e-6, size)) +
		wt.neutral * Math.log(Math.max(1e-6, neutral)) +
		wt.flat * Math.log(Math.max(1e-6, flat)) +
		wt.border * Math.log(Math.max(1e-6, border)) +
		wt.contrast * Math.log(Math.max(1e-6, contrast)) +
		wt.sign * Math.log(Math.max(1e-6, sign)) +
		wt.ortho * Math.log(Math.max(1e-6, ortho)) +
		wt.aspect * Math.log(Math.max(1e-6, aspect)) +
		wt.bright * Math.log(Math.max(1e-6, bright));
	const totalW =
		wt.size + wt.neutral + wt.flat + wt.border + wt.contrast + wt.sign + wt.ortho + wt.aspect + wt.bright;

	return {
		score: Math.exp(logSum / totalW),
		size: size,
		neutral: neutral,
		flat: flat,
		border: border,
		contrast: contrast,
		sign: sign,
		ortho: ortho,
		aspect: aspect,
		bright: bright
	};
}

/** True when two quads describe the same rectangle, within `tol` px per corner. */
export function quadsSame(a: Quad, b: Quad, tol: number): boolean {
	for (let i = 0; i < 4; i++) {
		if (dist(a[i] as Point, b[i] as Point) > tol) return false;
	}
	return true;
}

export function addCandidate(list: Quad[], quad: Quad, tol: number): void {
	for (let i = 0; i < list.length; i++) {
		if (quadsSame(list[i] as Quad, quad, tol)) return;
	}
	list.push(quad);
}

/* ------------------------------------------------------------------ *
 * OpenCV-facing half: candidate generation, warp and enhance.
 * Candidates are only *proposed* here; `scoreDocument` decides.
 * ------------------------------------------------------------------ */

export function matByteLength(mat: CvMat): number {
	const rows = mat.rows || 0;
	const cols = mat.cols || 0;
	let elem = 1;
	try {
		if (typeof mat.elemSize === 'function') elem = mat.elemSize();
		else if (typeof mat.channels === 'function') elem = mat.channels();
	} catch (e) {
		elem = 4;
	}
	return rows * cols * elem;
}

export function matBytes(mat: CvMat): Uint8ClampedArray {
	const n = matByteLength(mat);
	const src = mat.data;
	const copy = new Uint8ClampedArray(n);
	if (src && src.length >= n) {
		if (src.subarray) copy.set(src.subarray(0, n));
		else copy.set(src);
	} else if (src) {
		copy.set(src);
	}
	return copy;
}

export function toRgbaImageData(cv: OpenCv, mat: CvMat) {
	let channels = 0;
	try {
		channels = typeof mat.channels === 'function' ? mat.channels() : 0;
	} catch (e) {
		channels = 0;
	}
	if (channels === 4) {
		return { buffer: matBytes(mat).buffer, width: mat.cols, height: mat.rows };
	}
	const rgba = new cv.Mat();
	try {
		cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
		return { buffer: matBytes(rgba).buffer, width: rgba.cols, height: rgba.rows };
	} catch (err) {
		return { buffer: matBytes(mat).buffer, width: mat.cols, height: mat.rows };
	} finally {
		try {
			rgba.delete();
		} catch (e) {
			/* unused */
		}
	}
}

export function pointsFromMat(cv: OpenCv, mat: CvMat | null): Point[] | null {
	if (!mat) return null;
	let data: ArrayLike<number> | null = null;
	try {
		if (typeof mat.depth === 'function' && typeof cv.CV_32F === 'number' && mat.depth() === cv.CV_32F) {
			data = mat.data32F;
		} else {
			data = mat.data32S || mat.data32F;
		}
	} catch (e) {
		data = mat.data32S || mat.data32F;
	}
	if (!data || data.length < 8) return null;
	const pts: Point[] = [];
	for (let i = 0; i < 4; i++) {
		pts.push({ x: data[i * 2] as number, y: data[i * 2 + 1] as number });
	}
	return pts;
}

export function pointsFromBox(cv: OpenCv, rect: CvRotatedRect): Point[] | null {
	try {
		if (cv.RotatedRect && typeof cv.RotatedRect.points === 'function') {
			const raw = cv.RotatedRect.points(rect);
			if (raw && raw.length === 4) {
				return [
					{ x: raw[0].x, y: raw[0].y },
					{ x: raw[1].x, y: raw[1].y },
					{ x: raw[2].x, y: raw[2].y },
					{ x: raw[3].x, y: raw[3].y }
				];
			}
		}
	} catch (e) {
		/* try boxPoints */
	}
	if (typeof cv.boxPoints === 'function') {
		const box = new cv.Mat();
		try {
			cv.boxPoints(rect, box);
			return pointsFromMat(cv, box);
		} finally {
			box.delete();
		}
	}
	return null;
}

export function isConvex(cv: OpenCv, approx: CvMat): boolean {
	try {
		if (typeof cv.isContourConvex !== 'function') return true;
		return cv.isContourConvex(approx);
	} catch (e) {
		return true;
	}
}

/** Reduce one contour to a four-corner quad, or null when it is not one. */
export function contourToQuad(cv: OpenCv, cnt: CvMat): Quad | null {
	const peri = cv.arcLength(cnt, true);
	const approx = new cv.Mat();
	const hull = new cv.Mat();
	try {
		const epsilons = [0.015, 0.02, 0.03, 0.045, 0.06, 0.08];
		const sources = [cnt];
		try {
			cv.convexHull(cnt, hull, false, true);
			if (hull.rows >= 4) sources.push(hull);
		} catch (e) {
			/* hull optional */
		}
		for (let s = 0; s < sources.length; s++) {
			for (let e = 0; e < epsilons.length; e++) {
				cv.approxPolyDP(sources[s] as CvMat, approx, (epsilons[e] as number) * peri, true);
				if (approx.rows !== 4) continue;
				if (!isConvex(cv, approx)) continue;
				const pts = pointsFromMat(cv, approx);
				if (pts) return orderCorners(pts);
			}
		}
		// minAreaRect of a C-shaped blob is a huge diamond that is not a page.
		// Only keep it when the contour already fills that rectangle.
		try {
			const rect = cv.minAreaRect(cnt);
			const boxPts = pointsFromBox(cv, rect);
			if (boxPts && boxPts.length === 4) {
				const ordered = orderCorners(boxPts);
				const rw = rect.size && rect.size.width ? rect.size.width : 0;
				const rh = rect.size && rect.size.height ? rect.size.height : 0;
				const rectArea = Math.abs(rw * rh);
				const filled = rectArea > 1 ? cv.contourArea(cnt) / rectArea : 0;
				if (filled >= 0.82 && orthoScore(ordered) >= 0.62) return ordered;
			}
		} catch (err) {
			/* minAreaRect optional */
		}
		return null;
	} finally {
		approx.delete();
		hull.delete();
	}
}

/** Every plausible quad in one binary image, appended to `out`. */
export function collectFromEdges(
	cv: OpenCv,
	edges: CvMat,
	minArea: number,
	width: number,
	height: number,
	out: Quad[]
): void {
	const modes = [cv.RETR_EXTERNAL, cv.RETR_LIST];
	const maxKeep = 24;
	const tol = Math.max(2, Math.min(width, height) * 0.02);
	for (let m = 0; m < modes.length; m++) {
		const src = edges.clone();
		const contours = new cv.MatVector();
		const hierarchy = new cv.Mat();
		try {
			cv.findContours(src, contours, hierarchy, modes[m] as number, cv.CHAIN_APPROX_SIMPLE);
			const ranked: { i: number; area: number }[] = [];
			const total = contours.size();
			for (let i = 0; i < total; i++) {
				const area = cv.contourArea(contours.get(i));
				if (area >= minArea) ranked.push({ i: i, area: area });
			}
			ranked.sort(function (a, b) {
				return b.area - a.area;
			});
			const n = Math.min(ranked.length, maxKeep);
			for (let r = 0; r < n; r++) {
				const quad = contourToQuad(cv, contours.get((ranked[r] as { i: number }).i));
				if (!quad || !usableQuad(quad, width, height, minArea)) continue;
				addCandidate(out, quad, tol);
			}
		} finally {
			src.delete();
			contours.delete();
			hierarchy.delete();
		}
	}
}

/**
 * Propose candidates from several binarizations of one grayscale image.
 *
 * Each strategy is good at a different scene (Otsu for a pale page on a dark
 * surface, Canny for a page on a busy one, adaptive threshold for uneven
 * light), so they all run and everything they find is pooled. Deciding between
 * them is `scoreDocument`'s job, not theirs.
 */
export function collectOnGray(
	cv: OpenCv,
	gray: CvMat,
	minArea: number,
	width: number,
	height: number,
	out: Quad[]
): void {
	const work = new cv.Mat();
	const edges = new cv.Mat();
	const closeK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
	const dilateK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
	const openK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
	try {
		try {
			cv.GaussianBlur(gray, work, new cv.Size(7, 7), 0);
			cv.threshold(work, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
			cv.morphologyEx(edges, edges, cv.MORPH_OPEN, openK);
			cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
			collectFromEdges(cv, edges, minArea, width, height, out);
			cv.threshold(work, edges, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
			cv.morphologyEx(edges, edges, cv.MORPH_OPEN, openK);
			cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
			collectFromEdges(cv, edges, minArea, width, height, out);
		} catch (e) {
			/* Otsu optional */
		}
		cv.GaussianBlur(gray, work, new cv.Size(5, 5), 0);
		const cannyPairs = [
			[40, 120],
			[75, 200],
			[20, 70]
		];
		for (let c = 0; c < cannyPairs.length; c++) {
			try {
				const pair = cannyPairs[c] as number[];
				cv.Canny(work, edges, pair[0] as number, pair[1] as number);
				cv.dilate(edges, edges, dilateK);
				cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
				collectFromEdges(cv, edges, minArea, width, height, out);
			} catch (e) {
				/* next Canny pair */
			}
		}
		const threshModes = [
			[cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 5],
			[cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5],
			[cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 15, 4]
		];
		for (let t = 0; t < threshModes.length; t++) {
			try {
				const mode = threshModes[t] as number[];
				cv.adaptiveThreshold(
					gray,
					edges,
					255,
					mode[0] as number,
					mode[1] as number,
					mode[2] as number,
					mode[3] as number
				);
				cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
				collectFromEdges(cv, edges, minArea, width, height, out);
			} catch (e) {
				/* next threshold */
			}
		}
	} finally {
		work.delete();
		edges.delete();
		closeK.delete();
		dilateK.delete();
		openK.delete();
	}
}

export function matFromRgba(cv: OpenCv, buffer: ArrayBuffer | Uint8Array, width: number, height: number): CvMat {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8ClampedArray(buffer);
	if (typeof cv.CV_8UC4 !== 'number') {
		throw new Error('OpenCV CV_8UC4 missing');
	}
	const expected = width * height * 4;
	if (bytes.length < expected) {
		throw new Error('Image buffer is shorter than width*height*4');
	}
	const src = new cv.Mat(height, width, cv.CV_8UC4);
	src.data.set(bytes.subarray ? bytes.subarray(0, expected) : bytes);
	return src;
}

export function scaleFoundQuad(quad: Quad | null, scale: number): Quad | null {
	if (!quad || scale === 1) return quad;
	const inv = 1 / scale;
	return [
		{ x: quad[0].x * inv, y: quad[0].y * inv },
		{ x: quad[1].x * inv, y: quad[1].y * inv },
		{ x: quad[2].x * inv, y: quad[2].y * inv },
		{ x: quad[3].x * inv, y: quad[3].y * inv }
	];
}

/**
 * Pick the best-scoring document in the frame, or null when there isn't one.
 *
 * Returning null matters: a bare desk or an empty cutting mat must not report
 * itself as a page. Auto-capture would otherwise fire on the furniture.
 */
export function chooseBest(ev: FrameEvidence, candidates: Quad[]): Quad | null {
	const floor = docConstants().acceptFloor;
	let best: Quad | null = null;
	let bestScore = 0;
	for (let i = 0; i < candidates.length; i++) {
		const quad = candidates[i] as Quad;
		const result = scoreDocument(ev, quad);
		if (result.score > bestScore) {
			bestScore = result.score;
			best = quad;
		}
	}
	return bestScore >= floor ? best : null;
}

export function detectQuad(
	cv: OpenCv,
	buffer: ArrayBuffer | Uint8Array,
	width: number,
	height: number,
	opts: { maxDetectEdge?: number; minAreaRatio?: number } | undefined
): Quad | null {
	const options = opts || {};
	const maxEdge = options.maxDetectEdge != null ? options.maxDetectEdge : 480;
	const src = matFromRgba(cv, buffer, width, height);
	let resized: CvMat | null = null;
	let scale = 1;
	try {
		const longest = Math.max(width, height);
		let work = src;
		let dw = width;
		let dh = height;
		// Tiny frames hit pathological OpenCV.js paths (detect never returns).
		// Always run around 360-480px on the long edge.
		const minEdge = 360;
		if (longest > maxEdge || longest < minEdge) {
			scale = (longest > maxEdge ? maxEdge : minEdge) / longest;
			dw = Math.max(2, Math.round(width * scale));
			dh = Math.max(2, Math.round(height * scale));
			resized = new cv.Mat();
			cv.resize(src, resized, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
			work = resized;
		}
		const minArea = (options.minAreaRatio != null ? options.minAreaRatio : 0.02) * dw * dh;
		const gray = new cv.Mat();
		const boosted = new cv.Mat();
		try {
			// Score against colour at detect scale: saturation separates a printed
			// mat or a wooden desk from paper, and grayscale throws that away.
			const ev = buildEvidence(matBytes(work), dw, dh);
			const candidates: Quad[] = [];
			cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
			collectOnGray(cv, gray, minArea, dw, dh, candidates);
			let best = chooseBest(ev, candidates);
			// A low-contrast page can be invisible to every plain threshold.
			// Re-run on a contrast-boosted copy before giving up.
			if (!best) {
				try {
					if (typeof cv.CLAHE === 'function') {
						const clahe = new cv.CLAHE(2, new cv.Size(8, 8));
						clahe.apply(gray, boosted);
						clahe.delete();
						const extra: Quad[] = [];
						collectOnGray(cv, boosted, minArea, dw, dh, extra);
						best = chooseBest(ev, extra);
					}
				} catch (e) {
					/* CLAHE optional */
				}
			}
			return scaleFoundQuad(best, scale);
		} finally {
			gray.delete();
			boosted.delete();
		}
	} finally {
		src.delete();
		if (resized) resized.delete();
	}
}

export function warpImage(
	cv: OpenCv,
	buffer: ArrayBuffer | Uint8Array,
	width: number,
	height: number,
	quad: Quad,
	opts: { maxEdge?: number } | undefined
) {
	const options = opts || {};
	const size = outputSize(quad, options.maxEdge || 1600);
	const src = matFromRgba(cv, buffer, width, height);
	const pts = [
		+quad[0].x,
		+quad[0].y,
		+quad[1].x,
		+quad[1].y,
		+quad[2].x,
		+quad[2].y,
		+quad[3].x,
		+quad[3].y
	];
	const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, pts);
	const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
		0,
		0,
		size.width,
		0,
		size.width,
		size.height,
		0,
		size.height
	]);
	const dest = new cv.Mat(size.height, size.width, src.type ? src.type() : cv.CV_8UC4);
	let M: CvMat | null = null;
	try {
		M = cv.getPerspectiveTransform(srcTri, dstTri);
		cv.warpPerspective(src, dest, M, new cv.Size(size.width, size.height));
		return toRgbaImageData(cv, dest);
	} finally {
		src.delete();
		srcTri.delete();
		dstTri.delete();
		dest.delete();
		if (M) M.delete();
	}
}

export function enhanceImage(
	cv: OpenCv,
	buffer: ArrayBuffer | Uint8Array,
	width: number,
	height: number,
	opts: { blockSize?: number; C?: number } | undefined
) {
	const options = opts || {};
	const src = matFromRgba(cv, buffer, width, height);
	const gray = new cv.Mat();
	const out = new cv.Mat();
	const block = nearestOdd(options.blockSize || 15);
	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		cv.adaptiveThreshold(
			gray,
			out,
			255,
			cv.ADAPTIVE_THRESH_GAUSSIAN_C,
			cv.THRESH_BINARY,
			block,
			options.C != null ? options.C : 8
		);
		return toRgbaImageData(cv, out);
	} finally {
		src.delete();
		gray.delete();
		out.delete();
	}
}
