import { describe, expect, it } from 'vitest';
import { concatWav, encodeWav, resampleLinear, wavBytesFor } from './wav.js';

describe('encodeWav', () => {
	it('writes a 44-byte PCM16 header', () => {
		const wav = encodeWav(new Float32Array(16), 16000, 1);
		expect(wav.byteLength).toBe(44 + 32);
		const header = new TextDecoder().decode(wav.slice(0, 4));
		const riffSize = new DataView(wav.buffer).getUint32(4, true);
		expect(header).toBe('RIFF');
		expect(riffSize).toBe(36 + 32);
	});

	it('round-trips sample values within PCM16 quantization', () => {
		const samples = new Float32Array([0, 0.5, 1, -1, 0.25, -0.75]);
		const wav = encodeWav(samples, 24000, 1);
		const view = new DataView(wav.buffer);
		const quantized = (s: number) => Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
		for (let i = 0; i < samples.length; i++) {
			expect(view.getInt16(44 + i * 2, true)).toBe(quantized(samples[i]!));
		}
	});

	it('clamps out-of-range samples', () => {
		const wav = encodeWav(new Float32Array([2, -2]), 8000, 1);
		const view = new DataView(wav.buffer);
		expect(view.getInt16(44, true)).toBe(0x7fff);
		expect(view.getInt16(46, true)).toBe(-0x8000);
	});
});

describe('concatWav', () => {
	it('resamples segments to the target rate before joining', () => {
		const seg1 = { samples: new Float32Array(24000).fill(0.1), sampleRate: 24000 };
		const seg2 = { samples: new Float32Array(16000).fill(0.2), sampleRate: 16000 };
		const wav = concatWav([seg1, seg2], 16000);
		// seg1 resamples 24000@24k → 16000@16k (1 s), seg2 stays 1 s → 2 s total.
		const dataBytes = wav.byteLength - 44;
		expect(dataBytes).toBe(16000 * 2 * 2);
	});
});

describe('resampleLinear', () => {
	it('is identity at equal rates', () => {
		const input = new Float32Array([1, 2, 3]);
		expect(resampleLinear(input, 16000, 16000)).toBe(input);
	});

	it('halves length when downsampling 2×', () => {
		const input = new Float32Array(1000).fill(0.5);
		const out = resampleLinear(input, 32000, 16000);
		expect(out.length).toBe(500);
	});
});

describe('wavBytesFor', () => {
	it('estimates 16 kHz mono duration sizes', () => {
		expect(wavBytesFor(1000)).toBe(44 + 16000 * 2);
	});
});