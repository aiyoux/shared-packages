/**
 * FLUX.2 [klein] flow-matching math — sigma schedule, positional ids, noise
 * and output packing. The pure-math counterpart of `sdEuler.ts` for the
 * FLUX.2 engine: no onnxruntime import, unit-testable in node.
 *
 * The scheduler is diffusers' FlowMatchEulerDiscreteScheduler with the
 * resolution-dependent empirical-mu sigma shift the FLUX.2 exports are
 * tuned for. Sigmas descend from 1 (pure noise) to 0 (image); the model
 * predicts the noise→image velocity, so each Euler step adds
 * `(sigmaNext - sigma) * pred` with a negative coefficient.
 */

import { mulberry32, type Rng } from './sdEuler.js';
import { f16BitsToF32 } from './f16.js';

export const FLUX2_TEXT_SEQ_LEN = 512;
export const FLUX2_CONTEXT_DIM = 7680;
export const FLUX2_LATENT_CHANNELS = 128;
export const FLUX2_LATENT_DOWNSAMPLE = 16;

/** Linear t schedule, descending from 1 (pure noise) to 0 (image). */
export function linearSchedule(numSteps: number): Float64Array {
	const t = new Float64Array(numSteps + 1);
	for (let i = 0; i <= numSteps; i++) t[i] = 1 - i / numSteps;
	return t;
}

/**
 * Empirical mu fit for the sigma shift, from the FLUX.2 export recipe:
 * piecewise-linear in image sequence length (fit at 10 and 200 steps'
 * resolution), capped past 4300 tokens where the fit saturates.
 */
export function computeEmpiricalMu(imageSeqLen: number, numSteps: number): number {
	const a1 = 8.73809524e-05;
	const b1 = 1.89833333;
	const a2 = 0.00016927;
	const b2 = 0.45666666;
	if (imageSeqLen > 4300) return a2 * imageSeqLen + b2;
	const m200 = a2 * imageSeqLen + b2;
	const m10 = a1 * imageSeqLen + b1;
	const a = (m200 - m10) / 190.0;
	const b = m200 - 200.0 * a;
	return a * numSteps + b;
}

/** One sigma through the shift `exp(mu) / (exp(mu) + 1/t - 1)`; 1→1, 0→0. */
export function shiftSigma(t: number, mu: number): number {
	if (t >= 1) return 1;
	if (t <= 0) return 0;
	const expMu = Math.exp(mu);
	return expMu / (expMu + 1 / t - 1);
}

/** Full shifted sigma schedule (`numSteps + 1` values, descending). */
export function shiftedSchedule(numSteps: number, mu: number): Float64Array {
	const linear = linearSchedule(numSteps);
	const out = new Float64Array(linear.length);
	for (let i = 0; i < linear.length; i++) out[i] = shiftSigma(linear[i]!, mu);
	return out;
}

/**
 * One plain Euler flow step in place: `x += (sigmaNext - sigma) * pred`.
 */
export function flowEulerStep(
	x: Float32Array,
	pred: Float32Array,
	sigma: number,
	sigmaNext: number
): void {
	if (x.length !== pred.length) {
		throw new Error('flowEulerStep: sample and model output lengths differ');
	}
	const dt = sigmaNext - sigma;
	for (let i = 0; i < x.length; i++) x[i] += dt * pred[i]!;
}

/**
 * RoPE token ids for the transformer: image tokens get `(0, row, col, 0)`
 * in latent space, text tokens get `(0, 0, 0, i)` — returned separately
 * since the transformer takes `x_ids` and `ctx_ids` as distinct inputs.
 */
export function imageTokenIds(latentWidth: number, latentHeight: number): Float32Array {
	const out = new Float32Array(latentWidth * latentHeight * 4);
	let o = 0;
	for (let h = 0; h < latentHeight; h++) {
		for (let w = 0; w < latentWidth; w++) {
			out[o++] = 0;
			out[o++] = h;
			out[o++] = w;
			out[o++] = 0;
		}
	}
	return out;
}

export function textTokenIds(textSeqLen: number): Float32Array {
	const out = new Float32Array(textSeqLen * 4);
	for (let i = 0; i < textSeqLen; i++) {
		out[4 * i] = 0;
		out[4 * i + 1] = 0;
		out[4 * i + 2] = 0;
		out[4 * i + 3] = i;
	}
	return out;
}

/** Standard-normal latents via Box–Muller over an (optionally seeded) rng. */
export function randnLatentsF32(length: number, rng: Rng = Math.random): Float32Array {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i += 2) {
		const u1 = Math.max(rng(), Number.EPSILON);
		const u2 = rng();
		const r = Math.sqrt(-2 * Math.log(u1));
		out[i] = r * Math.cos(2 * Math.PI * u2);
		if (i + 1 < length) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
	}
	return out;
}

/**
 * Token-major latents `[seq, channels]` → channel-first fp16 bit pattern
 * `[channels, height, width]`, as the VAE pre-stage expects.
 */
export function tokensToChannelFirst(
	tokens: Uint16Array,
	latentWidth: number,
	latentHeight: number,
	channels: number
): Uint16Array {
	if (tokens.length < latentWidth * latentHeight * channels) {
		throw new Error('tokensToChannelFirst: short buffer');
	}
	const out = new Uint16Array(channels * latentHeight * latentWidth);
	for (let h = 0; h < latentHeight; h++) {
		for (let w = 0; w < latentWidth; w++) {
			const token = (h * latentWidth + w) * channels;
			for (let c = 0; c < channels; c++) {
				out[(c * latentHeight + h) * latentWidth + w] = tokens[token + c]!;
			}
		}
	}
	return out;
}

/** fp16 `[1, 3, H, W]` CHW frame in `[-1, 1]` → RGBA bytes, alpha 255. */
export function chwToRgba(chw: Uint16Array, width: number, height: number): Uint8ClampedArray {
	const pixels = width * height;
	if (chw.length < 3 * pixels) throw new Error('chwToRgba: short buffer');
	const out = new Uint8ClampedArray(4 * pixels);
	for (let i = 0; i < pixels; i++) {
		out[4 * i] = Math.round((f16BitsToF32(chw[i]!) + 1) * 127.5);
		out[4 * i + 1] = Math.round((f16BitsToF32(chw[pixels + i]!) + 1) * 127.5);
		out[4 * i + 2] = Math.round((f16BitsToF32(chw[2 * pixels + i]!) + 1) * 127.5);
		out[4 * i + 3] = 255;
	}
	return out;
}

/** Seeded PRNG re-export so callers only import from one math module. */
export { mulberry32 };