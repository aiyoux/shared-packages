/**
 * Single-step Euler diffusion math for the distilled SD-family models
 * (SD-Turbo, SDXS). Mirrors Microsoft's ORT WebGPU js/sd-turbo recipe:
 * fixed timestep 999, `sigma = 14.6146` (Euler trailing sigma_max), no CFG.
 *
 * Pure Float32Array functions — no onnxruntime import, unit-tested.
 */

/** Euler trailing sigma_max shared by the SD-Turbo/SDXS one-step recipe. */
export const EULER_SIGMA = 14.6146;

/** `1 / sqrt(sigma^2 + 1)` — UNet input pre-scale (≈0.0683). */
export function inputScale(sigma: number): number {
	return 1 / Math.sqrt(sigma * sigma + 1);
}

/** Scale latents before the UNet call (new array, input untouched). */
export function scaleModelInputs(latent: Float32Array, sigma: number): Float32Array {
	const s = inputScale(sigma);
	const out = new Float32Array(latent.length);
	for (let i = 0; i < latent.length; i++) out[i] = latent[i]! * s;
	return out;
}

/**
 * One plain-Euler step (`gamma = 0`, no ancestral noise) with VAE-scale
 * division folded in, matching the recipe's `step()`. Returns a new array.
 */
export function eulerStep(
	sample: Float32Array,
	modelOutput: Float32Array,
	sigma: number,
	vaeScale: number
): Float32Array {
	if (sample.length !== modelOutput.length) {
		throw new Error('eulerStep: sample and model output lengths differ');
	}
	const out = new Float32Array(sample.length);
	for (let i = 0; i < sample.length; i++) {
		const predOriginal = sample[i]! - sigma * modelOutput[i]!;
		const derivative = (sample[i]! - predOriginal) / sigma;
		out[i] = ((sample[i]! + derivative * -sigma) / vaeScale) as number;
	}
	return out;
}

/** VAE `[-1, 1]` output → clamped `[0, 1]` RGB. Returns a new array. */
export function vaeToRgb(sample: Float32Array): Float32Array {
	const out = new Float32Array(sample.length);
	for (let i = 0; i < sample.length; i++) {
		const v = sample[i]! / 2 + 0.5;
		out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
	}
	return out;
}

export type Rng = () => number;

/** Seeded PRNG for reproducible generations. */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Planar `[0, 1]` RGB (`3 × w × h`, channel-major) → RGBA bytes. */
export function rgbToRgbaU8(rgb: Float32Array, width: number, height: number): Uint8ClampedArray {
	const pixels = width * height;
	if (rgb.length < 3 * pixels) throw new Error('rgbToRgbaU8: short buffer');
	const out = new Uint8ClampedArray(4 * pixels);
	for (let i = 0; i < pixels; i++) {
		out[4 * i] = Math.round((rgb[i] ?? 0) * 255);
		out[4 * i + 1] = Math.round((rgb[pixels + i] ?? 0) * 255);
		out[4 * i + 2] = Math.round((rgb[2 * pixels + i] ?? 0) * 255);
		out[4 * i + 3] = 255;
	}
	return out;
}

/**
 * `randn` latents via Box–Muller, scaled by `sigma`. `rng` defaults to
 * `Math.random`; pass a seeded function in tests.
 */
export function randnLatents(length: number, sigma: number, rng: Rng = Math.random): Float32Array {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i += 2) {
		const u1 = Math.max(rng(), Number.EPSILON);
		const u2 = rng();
		const r = Math.sqrt(-2 * Math.log(u1));
		out[i] = r * Math.cos(2 * Math.PI * u2) * sigma;
		if (i + 1 < length) out[i + 1] = r * Math.sin(2 * Math.PI * u2) * sigma;
	}
	return out;
}
