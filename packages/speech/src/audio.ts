/**
 * Audio decode + chunking. The decode path touches browser Audio APIs; the
 * chunk math is pure and node-tested via the exported helper.
 */

import { SpeechEngineError } from './types.js';

export const TARGET_SAMPLE_RATE = 16000;
/** 30-minute warning at 16 kHz mono f32 (64 KB/s). */
export const DURATION_WARN_MS = 30 * 60_000;
/** Hard cap: 2 hours. */
export const DURATION_MAX_MS = 2 * 60 * 60_000;

export type DecodedAudio = {
	samples: Float32Array;
	sampleRate: number;
	durationMs: number;
};

/**
 * Decode any browser-decodable audio blob to mono 16 kHz Float32.
 *
 * `decodeAudioData` alone resamples inconsistently across browsers (Chrome
 * resamples to the context rate; Safari returns the file's native rate), so
 * we render through an OfflineAudioContext at 16 kHz — the one cross-browser
 * path.
 */
export async function decodeToMono16k(blob: Blob): Promise<DecodedAudio> {
	const AudioCtx =
		(window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
	if (!AudioCtx) throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'Web Audio is unavailable');
	const ctx = new AudioCtx();
	try {
		const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
		const mono = mixDown(decoded);
		const rendered = await renderRate(mono.samples, mono.sampleRate, TARGET_SAMPLE_RATE);
		return {
			samples: rendered,
			sampleRate: TARGET_SAMPLE_RATE,
			durationMs: Math.round((rendered.length / TARGET_SAMPLE_RATE) * 1000)
		};
	} finally {
		void ctx.close().catch(() => {});
	}
}

/**
 * Decode an audio blob (e.g. a piper WAV) to mono Float32 at its native
 * sample rate — no resample, so TTS output keeps its original quality.
 */
export async function decodeMono(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
	const AudioCtx =
		(window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
	if (!AudioCtx) throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'Web Audio is unavailable');
	const ctx = new AudioCtx();
	try {
		const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
		const mono = mixDown(decoded);
		return { samples: mono.samples, sampleRate: mono.sampleRate };
	} finally {
		void ctx.close().catch(() => {});
	}
}

function mixDown(buffer: AudioBuffer): { samples: Float32Array; sampleRate: number } {
	const channels = buffer.numberOfChannels;
	if (channels === 1) return { samples: buffer.getChannelData(0).slice(), sampleRate: buffer.sampleRate };
	const out = new Float32Array(buffer.length);
	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < data.length; i++) out[i] += data[i]! / channels;
	}
	return { samples: out, sampleRate: buffer.sampleRate };
}

async function renderRate(
	samples: Float32Array,
	fromRate: number,
	toRate: number
): Promise<Float32Array> {
	if (fromRate === toRate) return samples;
	const length = Math.max(1, Math.ceil((samples.length / fromRate) * toRate));
	const offline = new OfflineAudioContext(1, length, toRate);
	const buffer = offline.createBuffer(1, samples.length, fromRate);
	buffer.getChannelData(0).set(samples);
	const source = offline.createBufferSource();
	source.buffer = buffer;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
}

export type AudioChunk = {
	samples: Float32Array;
	/** Offset of this chunk's start in the source audio, in ms. */
	startMs: number;
};

export const CHUNK_SECONDS = 30;
export const CHUNK_OVERLAP_SECONDS = 1;

/**
 * Fixed-length windows with a small overlap; the split point inside the
 * overlap searches for the quietest sample so cuts land in silence where
 * possible. Pure — operates on whatever samples are given.
 */
export function chunkAudio(
	samples: Float32Array,
	sampleRate: number,
	chunkSeconds = CHUNK_SECONDS,
	overlapSeconds = CHUNK_OVERLAP_SECONDS
): AudioChunk[] {
	if (samples.length === 0) return [];
	const chunkLen = chunkSeconds * sampleRate;
	if (samples.length <= chunkLen) {
		return [{ samples, startMs: 0 }];
	}
	const overlap = overlapSeconds * sampleRate;
	const searchLen = Math.min(overlap, Math.floor(samples.length / 4));
	const chunks: AudioChunk[] = [];
	let start = 0;
	while (start < samples.length) {
		let end = Math.min(start + chunkLen, samples.length);
		if (end < samples.length && searchLen > 0) {
			// Search the overlap window before the raw cut for the quietest point.
			const searchStart = Math.max(start + chunkLen - overlap, start);
			end = quietestCut(samples, searchStart, Math.min(end + overlap, samples.length), end);
		}
		chunks.push({ samples: samples.subarray(start, end), startMs: Math.round((start / sampleRate) * 1000) });
		start = end;
	}
	return chunks;
}

/** Index in [from, to] with the lowest mean-square energy window centred there. */
export function quietestCut(samples: Float32Array, from: number, to: number, fallback: number): number {
	const win = Math.max(1, Math.floor((to - from) / 20));
	let bestIdx = fallback;
	let bestEnergy = Infinity;
	for (let i = from; i + win <= to; i += Math.max(1, Math.floor(win / 4))) {
		let sum = 0;
		for (let j = i; j < i + win; j++) sum += (samples[j] ?? 0) ** 2;
		if (sum < bestEnergy) {
			bestEnergy = sum;
			bestIdx = i + Math.floor(win / 2);
		}
	}
	return Math.min(Math.max(bestIdx, from + 1), to - 1);
}

/** Base64 from bytes, chunked to avoid the spread-call stack overflow. */
export function base64FromBytes(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}