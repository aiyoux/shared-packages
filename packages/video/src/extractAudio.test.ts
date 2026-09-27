import { describe, expect, it, vi } from 'vitest';
import { extractAudio, suggestAudioExtractName } from './extractAudio.js';

const added: { packet: { timestamp: number }; meta: unknown }[] = [];
const constructed: string[] = [];
let supportedCodecs: string[] = ['aac'];
let trackCodec: string | null = 'aac';
let trackPresent = true;

function fakePacket(timestamp: number) {
	return {
		timestamp,
		duration: 0.5,
		data: new Uint8Array([1, 2, 3]),
		type: 'key',
		clone(opts?: { timestamp?: number }) {
			return fakePacket(opts?.timestamp ?? timestamp);
		}
	};
}

const ALL_PACKETS = [fakePacket(0), fakePacket(0.5), fakePacket(1)];

vi.mock('mediabunny', () => {
	class BlobSource {
		constructor(_blob: unknown) {}
	}
	class Input {
		constructor(_opts: unknown) {}
		async getPrimaryAudioTrack() {
			if (!trackPresent) return null;
			return {
				getCodec: async () => trackCodec,
				getDecoderConfig: async () => ({ codec: 'mp4a.40.2' })
			};
		}
		dispose() {}
	}
	class Mp4OutputFormat {
		constructor(_opts?: unknown) {
			constructed.push('mp4');
		}
		getSupportedCodecs() {
			return supportedCodecs;
		}
	}
	class WavOutputFormat {
		constructor() {
			constructed.push('wav');
		}
	}
	class BufferTarget {
		buffer = new Uint8Array([9, 9, 9]);
	}
	class Output {
		target = new BufferTarget();
		constructor(_opts: unknown) {}
		addAudioTrack(_source: unknown) {}
		async start() {}
		async finalize() {}
	}
	class EncodedAudioPacketSource {
		constructor(_codec: unknown) {}
		async add(packet: { timestamp: number }, meta?: unknown) {
			added.push({ packet, meta });
		}
	}
	class AudioSampleSource {
		constructor(_config: unknown) {}
		async add(_sample: unknown) {}
	}
	class EncodedPacketSink {
		constructor(_track: unknown) {}
		async getPacket(t: number) {
			let found = null;
			for (const p of ALL_PACKETS) {
				if (p.timestamp <= t) found = p;
			}
			return found;
		}
		async *packets(from?: unknown) {
			let started = !from;
			for (const p of ALL_PACKETS) {
				if (!started && p === from) started = true;
				if (started) yield p;
			}
		}
	}
	class AudioSampleSink {
		constructor(_track: unknown) {}
		// eslint-disable-next-line require-yield
		async *samples(_start?: number, _end?: number) {}
	}
	return {
		ALL_FORMATS: ['mp4'],
		AudioSampleSink,
		AudioSampleSource,
		BlobSource,
		BufferTarget,
		EncodedAudioPacketSource,
		EncodedPacketSink,
		Input,
		Mp4OutputFormat,
		Output,
		WavOutputFormat
	};
});

function reset() {
	added.length = 0;
	constructed.length = 0;
	supportedCodecs = ['aac'];
	trackCodec = 'aac';
	trackPresent = true;
}

describe('suggestAudioExtractName', () => {
	it('names the sibling after the source clip', () => {
		expect(suggestAudioExtractName('Holiday.mov', 'm4a')).toBe('Holiday (audio).m4a');
		expect(suggestAudioExtractName('take.wav', 'wav')).toBe('take (audio).wav');
	});
});

describe('extractAudio', () => {
	it('copies supported packets with timestamps rebased to zero', async () => {
		reset();
		const out = await extractAudio(new Blob(['x']), { startSec: 0.5, endSec: 1.5 });
		expect(out.container).toBe('m4a');
		expect(out.copied).toBe(true);
		expect(out.codec).toBe('aac');
		expect(out.contentType).toBe('audio/mp4');
		// Iteration starts at the 0.5 packet; timestamps rebase to zero.
		expect(added.map((a) => a.packet.timestamp)).toEqual([0, 0.5]);
		expect(added[0]!.meta).toMatchObject({ decoderConfig: { codec: 'mp4a.40.2' } });
		expect(added[1]!.meta).toBeUndefined();
	});

	it('falls back to WAV when the codec is not MP4-muxable', async () => {
		reset();
		trackCodec = 'flac';
		supportedCodecs = ['aac'];
		// No decoded chunks flow in node (AudioSampleSink mocked empty),
		// so the fallback runs dry and reports the empty range.
		await expect(extractAudio(new Blob(['x']))).rejects.toThrow(
			'No audio packets in the trimmed range'
		);
		expect(constructed).toContain('wav');
	});

	it('throws when the source has no audio track', async () => {
		reset();
		trackPresent = false;
		await expect(extractAudio(new Blob(['x']))).rejects.toThrow('No audio track to extract');
	});
});
