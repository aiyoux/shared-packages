import { describe, expect, it } from 'vitest';
import {
	heatmapToQuad,
	letterboxFor,
	unletterbox,
	yoloPoseToQuad
} from './onnxQuad.js';


describe('letterbox mapping', () => {
	it('round-trips the image center for a wide frame', () => {
		const map = letterboxFor(640, 480, 256);
		expect(map.scale).toBeCloseTo(0.4);
		const c = unletterbox(128, 128, map);
		expect(c.x).toBeCloseTo(320);
		expect(c.y).toBeCloseTo(240);
	});
});

describe('heatmapToQuad', () => {
	it('decodes one peak per channel and canonicalizes corner order', () => {
		const W = 8;
		const H = 8;
		const data = new Float32Array(4 * W * H).fill(-10);
		// Peaks at model-space (1,1), (6,1), (6,6), (1,6) in shuffled channel order.
		data[3 * W * H + 6 * W + 6] = 10; // channel 3 -> BR
		data[2 * W * H + 1 * W + 6] = 10; // channel 2 -> TR
		data[1 * W * H + 6 * W + 1] = 10; // channel 1 -> BL
		data[0 * W * H + 1 * W + 1] = 10; // channel 0 -> TL
		const map = { size: 8, scale: 1, dx: 0, dy: 0 };
		const quad = heatmapToQuad({ data, channels: 4, height: H, width: W }, map);
		expect(quad).not.toBeNull();
		const [tl, tr, br, bl] = quad!;
		expect(tl.x).toBeLessThan(tr.x);
		expect(bl.x).toBeLessThan(br.x);
		expect(tl.y).toBeLessThan(bl.y);
		expect(tr.y).toBeLessThan(br.y);
	});

	it('rejects flat heatmaps below the peak gate', () => {
		const W = 4;
		const H = 4;
		const quad = heatmapToQuad(
			{ data: new Float32Array(4 * W * H).fill(-10), channels: 4, height: H, width: W },
			{ size: 4, scale: 1, dx: 0, dy: 0 }
		);
		expect(quad).toBeNull();
	});
});

describe('yoloPoseToQuad', () => {
	type Kpt = [number, number, number];
	function poseOutput(scores: number[], kpts: Kpt[][]): Float32Array {
		const rows = 17;
		const cols = scores.length;
		const data = new Float32Array(rows * cols);
		scores.forEach((s, n) => {
			data[4 * cols + n] = s;
		});
		// Winner column keypoints in normalized coords.
		const win = scores.indexOf(Math.max(...scores));
		kpts[win]!.forEach(([x, y, c], k) => {
			data[(5 + 3 * k) * cols + win] = x;
			data[(5 + 3 * k + 1) * cols + win] = y;
			data[(5 + 3 * k + 2) * cols + win] = c;
		});
		// Winner box center covers the keypoints.
		data[0 * cols + win] = 0.5;
		data[1 * cols + win] = 0.5;
		return data;
	}

	it('picks the best detection and denormalizes its keypoints', () => {
		const corners: Kpt[] = [
			[0.2, 0.2, 5],
			[0.8, 0.2, 5],
			[0.8, 0.8, 5],
			[0.2, 0.8, 5]
		];
		const data = poseOutput([-2, 3], [[], corners]);
		const quad = yoloPoseToQuad(
			{ data, rows: 17, cols: 2 },
			{ size: 640, scale: 1, dx: 0, dy: 0 }
		);
		expect(quad).not.toBeNull();
		const [tl, tr, br, bl] = quad!;
		for (const [p, x, y] of [
			[tl, 128, 128],
			[tr, 512, 128],
			[br, 512, 512],
			[bl, 128, 512]
		] as const) {
			expect(p.x).toBeCloseTo(x, 3);
			expect(p.y).toBeCloseTo(y, 3);
		}
	});

	it('rejects all-low-score frames', () => {
		const data = new Float32Array(17 * 3).fill(-5);
		expect(
			yoloPoseToQuad({ data, rows: 17, cols: 3 }, { size: 640, scale: 1, dx: 0, dy: 0 })
		).toBeNull();
	});
});
