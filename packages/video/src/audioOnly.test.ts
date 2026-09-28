import { describe, expect, it, vi } from 'vitest';
import { audioOnlyContainer, encodeAudioOnly } from './audioOnly.js';
import type { RawAudioChunk } from './audio.js';

const added: unknown[] = [];
const tracks: string[] = [];

vi.mock('mediabunny', () => {
	class BufferTarget {
		buffer: ArrayBuffer | null = null;
	}
	class Mp4OutputFormat {
		constructor(public opts?: unknown) {}
	}
	class OggOutputFormat {
		constructor(public opts?: unknown) {}
	}
	class AudioSample {
		closed = false;
		constructor(public init: Record<string, unknown>) {}
		close() {
			this.closed = true;
		}
	}
	class AudioSampleSource {
		constructor(public config: unknown) {}
		async add(sample: unknown) {
			added.push(sample);
		}
	}
	class Output {
		target: BufferTarget;
		constructor(public opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
		addAudioTrack() {
			tracks.push('audio');
		}
		addVideoTrack() {
			tracks.push('video');
		}
		async start() {}
		async finalize() {
			tracks.push('finalize');
			this.target.buffer = new Uint8Array([9, 9, 9]).buffer;
		}
	}
	return {
		Output,
		Mp4OutputFormat,
		OggOutputFormat,
		BufferTarget,
		AudioSample,
		AudioSampleSource
	};
});

function chunk(timestamp: number, frames = 480): RawAudioChunk {
	return {
		data: new Uint8Array(new ArrayBuffer(frames * 2 * 4)),
		format: 'f32',
		numberOfChannels: 2,
		sampleRate: 48_000,
		timestamp
	};
}

async function* feed(chunks: RawAudioChunk[]) {
	yield* chunks;
}

describe('audioOnlyContainer', () => {
	it('names web-ready containers', () => {
		expect(audioOnlyContainer('m4a')).toEqual({ mime: 'audio/mp4', ext: '.m4a' });
		expect(audioOnlyContainer('ogg')).toEqual({ mime: 'audio/ogg', ext: '.ogg' });
	});
});

describe('encodeAudioOnly', () => {
	it('muxes audio with no video track', async () => {
		added.length = 0;
		tracks.length = 0;
		const out = await encodeAudioOnly(feed([chunk(0), chunk(0.01)]), 'm4a');
		expect([...out]).toEqual([9, 9, 9]);
		expect(tracks).toEqual(['audio', 'finalize']);
		expect(added).toHaveLength(2);
	});

	it('refuses an empty stream instead of writing a header-only file', async () => {
		await expect(encodeAudioOnly(feed([]), 'ogg')).rejects.toThrow(/No audio/);
	});
});
