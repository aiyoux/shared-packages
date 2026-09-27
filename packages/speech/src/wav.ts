/**
 * Minimal PCM16 RIFF/WAVE encoder — pure, node-testable.
 *
 * Kokoro renders 24 kHz mono; piper ~22.05 kHz; the AI engine re-encodes
 * decoded audio at 16 kHz. All fit this one writer.
 */

export function encodeWav(samples: Float32Array, sampleRate: number, channels = 1): Uint8Array {
	const frames = Math.floor(samples.length / channels);
	const dataBytes = frames * channels * 2; // PCM16
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true); // byte rate
	view.setUint16(32, channels * 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (let i = 0; i < frames * channels; i++) {
		const s = clampToPcm16(samples[i] ?? 0);
		view.setInt16(offset, s, true);
		offset += 2;
	}
	return new Uint8Array(buffer);
}

/**
 * Concatenate render segments (each possibly at a different sample rate —
 * resample by simple linear interpolation to the target rate) into one WAV.
 */
export function concatWav(
	segments: readonly { samples: Float32Array; sampleRate: number }[],
	targetRate: number
): Uint8Array {
	const parts = segments.map((seg) =>
		seg.sampleRate === targetRate ? seg.samples : resampleLinear(seg.samples, seg.sampleRate, targetRate)
	);
	const total = parts.reduce((n, p) => n + p.length, 0);
	const merged = new Float32Array(total);
	let offset = 0;
	for (const p of parts) {
		merged.set(p, offset);
		offset += p.length;
	}
	return encodeWav(merged, targetRate, 1);
}

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || input.length === 0) return input;
	const ratio = fromRate / toRate;
	const outLength = Math.max(1, Math.floor(input.length / ratio));
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const frac = pos - i0;
		out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
	}
	return out;
}

function clampToPcm16(s: number): number {
	const v = Math.max(-1, Math.min(1, s));
	const scaled = v < 0 ? v * 0x8000 : v * 0x7fff;
	return Math.round(scaled);
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Estimate WAV byte size for a duration at a rate/channels (for caps/warnings). */
export function wavBytesFor(durationMs: number, sampleRate = 16000, channels = 1): number {
	return 44 + Math.ceil((durationMs / 1000) * sampleRate * channels) * 2;
}