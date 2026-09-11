import { describe, expect, it } from 'vitest';
import {
	buildEvidence,
	chooseBest,
	docConstants,
	edgeStats,
	interiorStats,
	scoreDocument
} from './algorithm.js';
import type { Quad } from '../types.js';

const W = 300;
const H = 460;

type Paint = { quad: Quad; rgb: [number, number, number]; grid?: boolean };

function contains(quad: Quad, x: number, y: number): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i]!;
		const b = quad[(i + 1) % 4]!;
		const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
		if (cross === 0) continue;
		const s = cross > 0 ? 1 : -1;
		if (!sign) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/** Paint layers back to front into an RGBA frame, then build its evidence. */
function scene(background: [number, number, number], layers: Paint[]) {
	const rgba = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let rgb = background;
			let grid = false;
			for (const layer of layers) {
				if (!contains(layer.quad, x + 0.5, y + 0.5)) continue;
				rgb = layer.rgb;
				grid = !!layer.grid;
			}
			const i = (y * W + x) * 4;
			// A printed grid: high-frequency texture that no plain page has.
			const bump = grid && (x % 7 === 0 || y % 7 === 0) ? 70 : 0;
			rgba[i] = Math.min(255, rgb[0] + bump);
			rgba[i + 1] = Math.min(255, rgb[1] + bump);
			rgba[i + 2] = Math.min(255, rgb[2] + bump);
			rgba[i + 3] = 255;
		}
	}
	return buildEvidence(rgba, W, H);
}

const rect = (x0: number, y0: number, x1: number, y1: number): Quad => [
	{ x: x0, y: y0 },
	{ x: x1, y: y0 },
	{ x: x1, y: y1 },
	{ x: x0, y: y1 }
];

const PAGE = rect(70, 110, 230, 340);
/** A cutting mat that runs off the left and right of the frame. */
const MAT = rect(-30, 40, W + 30, 420);
const PAPER: [number, number, number] = [236, 238, 240];
const MAT_GREEN: [number, number, number] = [24, 128, 112];
const DARK: [number, number, number] = [26, 26, 30];

function matScene() {
	return scene(DARK, [
		{ quad: MAT, rgb: MAT_GREEN, grid: true },
		{ quad: PAGE, rgb: PAPER }
	]);
}

describe('scoreDocument ranks the page above the surface it rests on', () => {
	it('prefers the page to a larger cutting mat', () => {
		const ev = matScene();
		const page = scoreDocument(ev, PAGE).score;
		const mat = scoreDocument(ev, MAT).score;
		expect(page).toBeGreaterThan(mat);
		// Not a photo-finish: the gap must survive a different desk.
		expect(page - mat).toBeGreaterThan(0.25);
	});

	it('does not let raw area decide', () => {
		// The regression that made a cutting mat beat the page: the old score was
		// proportional to area, so the bigger rectangle always won.
		const ev = matScene();
		const { quadArea } = { quadArea: (q: Quad) => Math.abs(
			q.reduce((acc, p, i) => {
				const n = q[(i + 1) % 4]!;
				return acc + p.x * n.y - n.x * p.y;
			}, 0) / 2
		) };
		expect(quadArea(MAT)).toBeGreaterThan(quadArea(PAGE) * 2);
		expect(scoreDocument(ev, MAT).score).toBeLessThan(scoreDocument(ev, PAGE).score);
	});

	it('prefers the page to a neutral grey tray, where colour cannot help', () => {
		const tray = rect(10, 30, W - 10, H - 30);
		const ev = scene(DARK, [
			{ quad: tray, rgb: [186, 188, 190] },
			{ quad: PAGE, rgb: PAPER }
		]);
		expect(interiorStats(ev, tray).meanSat).toBeLessThan(20);
		expect(scoreDocument(ev, PAGE).score).toBeGreaterThan(scoreDocument(ev, tray).score);
	});
});

describe('edge evidence', () => {
	it('scores a side that leaves the frame as unsupported', () => {
		const ev = matScene();
		// The mat's left and right edges sit outside the picture: nothing behind
		// them to compare against, so the weakest side carries no support.
		expect(edgeStats(ev, MAT).weakestSide).toBeLessThan(0.1);
		expect(edgeStats(ev, PAGE).weakestSide).toBeGreaterThan(0.9);
	});

	it('marks a quad straddling unrelated regions as inconsistent', () => {
		const ev = matScene();
		// Half on the page, half on the mat: sides step in opposite directions.
		const straddle = rect(150, 110, 290, 340);
		expect(edgeStats(ev, straddle).signConsistency).toBeLessThan(
			edgeStats(ev, PAGE).signConsistency
		);
	});

	it('reports the document as brighter than its surround', () => {
		expect(edgeStats(matScene(), PAGE).brighterInside).toBe(true);
	});
});

describe('interior evidence', () => {
	it('separates a printed grid from paper', () => {
		const ev = matScene();
		expect(interiorStats(ev, PAGE).meanSat).toBeLessThan(12);
		expect(interiorStats(ev, MAT).meanSat).toBeGreaterThan(60);
		expect(interiorStats(ev, PAGE).textureShare).toBeLessThan(
			interiorStats(ev, MAT).textureShare
		);
	});

	it('still accepts a page dense with text', () => {
		// Text is high-contrast interior detail. It must not veto a real document.
		const rgba = new Uint8ClampedArray(W * H * 4);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const onPage = contains(PAGE, x + 0.5, y + 0.5);
				const ink = onPage && y % 6 < 2 && x > 85 && x < 215;
				const v = onPage ? (ink ? 40 : 238) : 70;
				const i = (y * W + x) * 4;
				rgba[i] = v;
				rgba[i + 1] = v;
				rgba[i + 2] = v;
				rgba[i + 3] = 255;
			}
		}
		const ev = buildEvidence(rgba, W, H);
		expect(scoreDocument(ev, PAGE).score).toBeGreaterThan(docConstants().acceptFloor);
	});
});

describe('chooseBest', () => {
	it('returns null when the scene holds no document', () => {
		// A bare cutting mat, nothing on it. Auto-capture must not fire.
		const ev = scene(DARK, [{ quad: MAT, rgb: MAT_GREEN, grid: true }]);
		expect(chooseBest(ev, [MAT, rect(0, 0, W - 1, H - 1)])).toBeNull();
	});

	it('returns the page when one is present', () => {
		expect(chooseBest(matScene(), [MAT, PAGE])).toEqual(PAGE);
	});

	it('keeps documents clear of the acceptance floor', () => {
		const floor = docConstants().acceptFloor;
		const ev = matScene();
		expect(scoreDocument(ev, PAGE).score).toBeGreaterThan(floor + 0.2);
		expect(scoreDocument(ev, MAT).score).toBeLessThan(floor);
	});
});

describe('size term', () => {
	it('penalises specks and frame-filling quads, not ordinary pages', () => {
		const ev = matScene();
		expect(scoreDocument(ev, PAGE).size).toBe(1);
		expect(scoreDocument(ev, rect(140, 220, 160, 240)).size).toBe(0);
		expect(scoreDocument(ev, rect(0, 0, W - 1, H - 1)).size).toBeLessThan(0.3);
	});
});
