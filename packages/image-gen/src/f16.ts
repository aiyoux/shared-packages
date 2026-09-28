/**
 * IEEE half-precision (float16) conversions. ORT WebGPU hands fp16 tensor
 * data over as `Uint16Array` bit patterns; the FLUX.2 pipeline crosses the
 * fp16/fp32 boundary around every session call (scheduler math, Euler
 * accumulation and RGBA packing all stay in fp32).
 *
 * Round-to-nearest-even, ±65504 overflow → infinity, subnormals preserved.
 * Pure bit twiddling — no imports, unit-testable in node.
 */

const F32_BUF = new ArrayBuffer(4);
const F32 = new Float32Array(F32_BUF);
const U32 = new Uint32Array(F32_BUF);

/** float32 value → float16 bits. */
export function f32ToF16Bits(value: number): number {
	F32[0] = value;
	const x = U32[0]!;
	const sign = (x >>> 16) & 0x8000;
	const exp = (x >>> 23) & 0xff;
	const man = x & 0x7fffff;
	if (exp === 0xff) {
		// ±Inf stays Inf; NaN becomes a quiet NaN.
		return sign | (man !== 0 ? 0x7e00 : 0x7c00);
	}
	const e = exp - 127 + 15;
	if (e >= 0x1f) return sign | 0x7c00; // overflow → ±Inf
	if (e <= 0) {
		if (e < -10) return sign; // underflow → ±0
		// Subnormal: shift the implicit-1 mantissa down with nearest-even.
		const mant = man | 0x800000;
		const shift = 14 - e;
		const half = mant >> shift;
		const rem = mant & ((1 << shift) - 1);
		const round = rem > (1 << (shift - 1)) || (rem === 1 << (shift - 1) && (half & 1) === 1);
		return sign | (half + (round ? 1 : 0));
	}
	const half = (e << 10) | (man >> 13);
	const rem = man & 0x1fff;
	const round = rem > 0x1000 || (rem === 0x1000 && (half & 1) === 1);
	return sign | (half + (round ? 1 : 0));
}

/** float16 bits → float32 value. */
export function f16BitsToF32(h: number): number {
	const sign = h & 0x8000;
	const exp = (h & 0x7c00) >> 10;
	const frac = h & 0x03ff;
	let out: number;
	if (exp === 0) out = frac * 2 ** -24;
	else if (exp === 0x1f) out = frac !== 0 ? NaN : Infinity;
	else out = (frac | 0x400) * 2 ** (exp - 25);
	return sign ? -out : out;
}

/** fp16 bit array → new Float32Array. */
export function f16ToFloat32(bits: Uint16Array): Float32Array {
	const out = new Float32Array(bits.length);
	for (let i = 0; i < bits.length; i++) out[i] = f16BitsToF32(bits[i]!);
	return out;
}

/** Float32Array → new fp16 bit array. */
export function float32ToF16(values: Float32Array): Uint16Array {
	const out = new Uint16Array(values.length);
	for (let i = 0; i < values.length; i++) out[i] = f32ToF16Bits(values[i]!);
	return out;
}