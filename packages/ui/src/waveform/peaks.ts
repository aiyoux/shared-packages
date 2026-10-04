/**
 * Waveform peaks: the loudest sample in each slice of audio, 0..1.
 *
 * One implementation for every waveform in the apps. Voice draws a recording
 * from these; the file preview draws a file's waveform from them (decoded
 * here, or computed on a monitor and sent as numbers).
 */

/** Peak of each run of `samplesPerPeak` samples. */
export function peaksFromChannel(channel: ArrayLike<number>, samplesPerPeak: number): number[] {
	const step = Math.max(1, Math.floor(samplesPerPeak));
	const out: number[] = [];
	for (let i = 0; i < channel.length; i += step) {
		let max = 0;
		const end = Math.min(channel.length, i + step);
		for (let j = i; j < end; j++) {
			const a = Math.abs(channel[j]!);
			if (a > max) max = a;
		}
		out.push(Math.min(1, max));
	}
	return out;
}

/** Peaks at `peaksPerSecond`, from a decoded buffer's first channel. */
export function peaksFromAudioBuffer(
	buffer: Pick<AudioBuffer, 'getChannelData' | 'sampleRate' | 'duration'>,
	peaksPerSecond: number
): { samples: number[]; duration: number } {
	return {
		samples: peaksFromChannel(buffer.getChannelData(0), buffer.sampleRate / peaksPerSecond),
		duration: buffer.duration
	};
}

/** Decode `blob` and take its peaks. The whole file is decoded in memory. */
export async function peaksFromBlob(
	blob: Blob,
	peaksPerSecond: number
): Promise<{ samples: number[]; duration: number }> {
	const ctx = new AudioContext();
	try {
		return peaksFromAudioBuffer(await ctx.decodeAudioData(await blob.arrayBuffer()), peaksPerSecond);
	} finally {
		await ctx.close().catch(() => {
			/* already closed */
		});
	}
}

/**
 * Exactly `count` peaks from any number: each output takes the loudest input
 * it covers, so a short peak never vanishes when a long file is drawn small.
 */
export function resamplePeaks(peaks: ArrayLike<number>, count: number): number[] {
	const n = Math.max(0, Math.floor(count));
	if (n === 0 || peaks.length === 0) return new Array(n).fill(0);
	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const from = Math.floor((i * peaks.length) / n);
		const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
		let max = 0;
		for (let j = from; j < to && j < peaks.length; j++) if (peaks[j]! > max) max = peaks[j]!;
		out[i] = max;
	}
	return out;
}
