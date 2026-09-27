import { describe, expect, it } from 'vitest';
import {
	EULER_SIGMA,
	eulerStep,
	inputScale,
	mulberry32,
	randnLatents,
	rgbToRgbaU8,
	scaleModelInputs,
	vaeToRgb
} from './sdEuler.js';

describe('sdEuler', () => {
	it('uses the shared one-step sigma', () => {
		expect(EULER_SIGMA).toBeCloseTo(14.6146, 4);
		expect(inputScale(EULER_SIGMA)).toBeCloseTo(1 / Math.sqrt(EULER_SIGMA ** 2 + 1), 10);
	});

	it('pre-scales latents without touching the input', () => {
		const latent = new Float32Array([1, -2]);
		const out = scaleModelInputs(latent, 3);
		expect(out[0]).toBeCloseTo(1 / Math.sqrt(10), 6);
		expect(latent[0]).toBe(1);
	});

	it('collapses to pred/vaeScale for a zero model output', () => {
		// out = sample / vaeScale when the model predicts nothing.
		const out = eulerStep(new Float32Array([0.3643, -0.5]), new Float32Array(2), 14.6146, 0.18215);
		expect(out[0]).toBeCloseTo(0.3643 / 0.18215, 4);
		expect(out[1]).toBeCloseTo(-0.5 / 0.18215, 4);
	});

	it('rejects mismatched buffers', () => {
		expect(() => eulerStep(new Float32Array(2), new Float32Array(3), 1, 1)).toThrow(
			/lengths differ/
		);
	});

	it('maps VAE output into clamped RGB', () => {
		expect(Array.from(vaeToRgb(new Float32Array([-2, 0, 2])))).toEqual([0, 0.5, 1]);
	});

	it('mulberry32 is deterministic per seed', () => {
		const a = mulberry32(7);
		const b = mulberry32(7);
		expect([a(), a(), a()]).toEqual([b(), b(), b()]);
		expect(mulberry32(8)()).not.toBe(mulberry32(7)());
	});

	it('packs planar RGB into RGBA bytes', () => {
		// 1x2 image: R plane [1, 0], G plane [0, 1], B plane [0.5, 0.5].
		const rgb = new Float32Array([1, 0, 0, 1, 0.5, 0.5]);
		const out = rgbToRgbaU8(rgb, 2, 1);
		expect(Array.from(out)).toEqual([255, 0, 128, 255, 0, 255, 128, 255]);
		expect(() => rgbToRgbaU8(new Float32Array(3), 2, 1)).toThrow(/short buffer/);
	});

	it('draws seeded gaussian latents scaled by sigma', () => {
		const seq = [0.5, 0.25];
		let k = 0;
		const rng = () => seq[k++ % seq.length]!;
		const out = randnLatents(4, 2, rng);
		expect(out.length).toBe(4);
		expect(out[0]).toBeCloseTo(Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.25) * 2, 6);
	});
});
