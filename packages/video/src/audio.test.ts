import { describe, expect, it, vi } from 'vitest';
import { openAudioChunks } from './audio.js';

// The fake AudioSample models the slice of the real API openAudioChunks
// touches: allocationSize({planeIndex}), copyTo(dest, {planeIndex}), trim(),
// close(), and the property surface the chunks are built from.
type FakeSampleInit = {
	timestamp: number;
	numberOfFrames: number;
	numberOfChannels: number;
	sampleRate: number;
	format: AudioSampleFormat;
};

class FakeSample {
	closed = false;
	trimmed: [number, number | undefined] | null = null;
	constructor(public init: FakeSampleInit) {}
	get format() {
		return this.init.format;
	}
	get numberOfFrames() {
		return this.init.numberOfFrames;
	}
	get numberOfChannels() {
		return this.init.numberOfChannels;
	}
	get sampleRate() {
		return this.init.sampleRate;
	}
	get timestamp() {
		return this.init.timestamp;
	}
	allocationSize(_opts?: { planeIndex: number }) {
		return this.init.numberOfFrames * this.init.numberOfChannels * 2; // s16
	}
	copyTo(dest: ArrayBuffer, _opts?: { planeIndex: number }) {
		new Uint8Array(dest).set(new Uint8Array(dest.byteLength));
	}
	trim(startSample: number, endSample?: number) {
		this.trimmed = [startSample, endSample];
		const frames = (endSample ?? this.init.numberOfFrames) - startSample;
		return new FakeSample({
			...this.init,
			timestamp: this.init.timestamp + startSample / this.init.sampleRate,
			numberOfFrames: frames
		}) as unknown as FakeSample;
	}
	close() {
		this.closed = true;
	}
}

const sinkSamples = vi.fn();
const primaryAudioTrack = vi.fn();

vi.mock('mediabunny', () => {
	class BlobSource {
		constructor(_blob: unknown) {}
	}
	const ALL_FORMATS = ['mp4', 'webm'];
	class Input {
		source: unknown;
		formats: unknown;
		constructor(opts: { source: unknown; formats: unknown }) {
			this.source = opts.source;
			this.formats = opts.formats;
		}
		getPrimaryAudioTrack() {
			return primaryAudioTrack();
		}
		getPrimaryVideoTrack() {
			return Promise.resolve(null);
		}
		dispose() {}
	}
	class AudioSampleSink {
		constructor(_track: unknown) {}
		samples(start?: number, end?: number) {
			return sinkSamples(start, end);
		}
	}
	return { BlobSource, ALL_FORMATS, Input, AudioSampleSink };
});

function fakeTrack() {
	return { kind: 'audio-track' } as unknown as NonNullable<
		Awaited<ReturnType<typeof primaryAudioTrack>>
	>;
}

describe('openAudioChunks', () => {
	it('yields chunks copied from the sink samples and closes each sample', async () => {
		const sample = new FakeSample({
			timestamp: 1,
			numberOfFrames: 100,
			numberOfChannels: 2,
			sampleRate: 48_000,
			format: 's16'
		});
		primaryAudioTrack.mockReturnValue(
			Promise.resolve({ codec: 'aac', numberOfChannels: 2, getSampleRate: async () => 48_000 })
		);
		sinkSamples.mockReturnValue(
			(async function* () {
				yield sample;
			})()
		);

		const chunks = [];
		for await (const chunk of openAudioChunks(new Blob(['x']))) chunks.push(chunk);
		expect(sinkSamples).toHaveBeenCalledWith(0, undefined);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			format: 's16',
			numberOfChannels: 2,
			sampleRate: 48_000,
			timestamp: 1
		});
		expect(chunks[0]!.data.byteLength).toBe(100 * 2 * 2);
		expect(sample.closed).toBe(true);
	});

	it('trims a head sample that starts before startSec', async () => {
		// Sample spans 1.0s–1.5s; the range starts at 1.25s.
		const sample = new FakeSample({
			timestamp: 1,
			numberOfFrames: 24_000,
			numberOfChannels: 1,
			sampleRate: 48_000,
			format: 's16'
		});
		primaryAudioTrack.mockReturnValue(
			Promise.resolve({ codec: 'aac', numberOfChannels: 1, getSampleRate: async () => 48_000 })
		);
		sinkSamples.mockReturnValue(
			(async function* () {
				yield sample;
			})()
		);

		const chunks = [];
		for await (const chunk of openAudioChunks(new Blob(['x']), {
			startSec: 1.25,
			endSec: 1.5
		})) {
			chunks.push(chunk);
		}
		expect(sinkSamples).toHaveBeenCalledWith(1.25, 1.5);
		expect(sample.trimmed).toEqual([12_000, undefined]);
		expect(chunks[0]!.timestamp).toBeCloseTo(1.25, 10);
		expect(chunks[0]!.data.byteLength).toBe(12_000 * 2);
	});

	it('yields nothing when the source has no audio track', async () => {
		primaryAudioTrack.mockReturnValue(Promise.resolve(null));
		const chunks = [];
		for await (const chunk of openAudioChunks(new Blob(['x']))) chunks.push(chunk);
		expect(chunks).toHaveLength(0);
	});
});