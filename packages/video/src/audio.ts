import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';

/**
 * Plain-data audio chunk: the boundary between a decoded audio track and the
 * muxer. Lives in plain objects so callers (e.g. the hub, which must not
 * import mediabunny) can rebase/inspect timestamps without touching
 * mediabunny types. Timestamps are seconds.
 */
export type RawAudioChunk = {
	data: Uint8Array<ArrayBuffer>;
	format: AudioSampleFormat;
	numberOfChannels: number;
	sampleRate: number;
	/** Presentation timestamp in seconds, on whatever timeline the producer promised. */
	timestamp: number;
};

/**
 * Decode the primary audio track of `blob` and yield raw chunks.
 *
 * `startSec` is inclusive, `endSec` exclusive — the same trim semantics as
 * `AudioSampleSink.samples`. Boundary samples that straddle the range are
 * trimmed so the first chunk starts exactly at `startSec` (0 if omitted) and
 * nothing extends past `endSec`. Yields nothing when the source has no audio
 * track, so callers never need a special case for silent sources.
 */
export async function* openAudioChunks(
	blob: Blob,
	opts: { startSec?: number; endSec?: number } = {}
): AsyncGenerator<RawAudioChunk> {
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return;
		const sink = new AudioSampleSink(track);
		const startSec = opts.startSec ?? 0;
		for await (const sample of sink.samples(startSec, opts.endSec)) {
			let yielded = sample;
			// samples() starts at the first sample whose interval covers
			// startSec, which may begin before the range. Trim the head.
			if (yielded.timestamp < startSec) {
				const startSample = Math.round((startSec - yielded.timestamp) * yielded.sampleRate);
				const trimmed = yielded.trim(startSample);
				if (trimmed !== yielded) yielded.close();
				yielded = trimmed;
			}
			if (yielded.numberOfFrames <= 0) {
				yielded.close();
				continue;
			}
			try {
				// Interleaved formats have one plane; planar formats have one
				// per channel, concatenated in the same order AudioSampleInit
				// expects for planar data.
				const planeCount = yielded.format.endsWith('-planar') ? yielded.numberOfChannels : 1;
				const sizes: number[] = [];
				let total = 0;
				for (let p = 0; p < planeCount; p++) {
					const size = yielded.allocationSize({ planeIndex: p });
					sizes.push(size);
					total += size;
				}
				const data = new Uint8Array(new ArrayBuffer(total));
				let offset = 0;
				for (let p = 0; p < planeCount; p++) {
					yielded.copyTo(new Uint8Array(data.buffer, offset, sizes[p]!), { planeIndex: p });
					offset += sizes[p]!;
				}
				yield {
					data,
					format: yielded.format,
					numberOfChannels: yielded.numberOfChannels,
					sampleRate: yielded.sampleRate,
					timestamp: yielded.timestamp
				};
			} finally {
				yielded.close();
			}
		}
	} finally {
		input.dispose();
	}
}

/** Pure helper: shift a chunk's timestamp by `offsetSec`. */
export function mergeChunkAt(chunk: RawAudioChunk, offsetSec: number): RawAudioChunk {
	return offsetSec === 0 ? chunk : { ...chunk, timestamp: chunk.timestamp + offsetSec };
}

/** A chunk of digital silence in the given shape, `frames` long. */
export function silenceChunk(
	shape: Pick<RawAudioChunk, 'format' | 'numberOfChannels' | 'sampleRate'>,
	timestamp: number,
	frames: number
): RawAudioChunk {
	const bytesPerFrame = sampleFormatBytes(shape.format) * shape.numberOfChannels;
	return {
		data: new Uint8Array(new ArrayBuffer(Math.max(0, frames) * bytesPerFrame)),
		format: shape.format,
		numberOfChannels: shape.numberOfChannels,
		sampleRate: shape.sampleRate,
		timestamp
	};
}

function sampleFormatBytes(format: AudioSampleFormat): number {
	// Interleaved planar formats still allocate per-frame-per-channel bytes
	// of one plane each; callers only need a consistent zero buffer size.
	switch (format) {
		case 'u8':
			return 1;
		case 's16':
			return 2;
		case 's32':
			return 4;
		case 'f32':
			return 4;
		default:
			return 4; // planar variants arrive as f32/s16/s32 planes; f32-planar is the safe default
	}
}