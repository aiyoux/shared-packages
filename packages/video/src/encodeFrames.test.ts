import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFrames, type FrameSource } from './encodeFrames.js';

vi.mock('mediabunny', () => {
	class BufferTarget {
		buffer: ArrayBuffer | null = null;
	}
	class Mp4OutputFormat {
		constructor(_opts?: unknown) {}
	}
	class EncodedVideoPacketSource {
		async add() {}
	}
	class EncodedPacket {
		static fromEncodedChunk(chunk: unknown) {
			return { chunk };
		}
	}
	class Output {
		target: BufferTarget;
		constructor(opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
		addVideoTrack() {}
		async start() {}
		async finalize() {
			this.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		}
	}
	return { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket };
});

type EncodeCall = { timestamp: number; keyFrame?: boolean };

class FakeVideoFrame {
	timestamp: number;
	closed = false;
	constructor(_source?: unknown, init?: { timestamp?: number }) {
		this.timestamp = init?.timestamp ?? 0;
	}
	close() {
		this.closed = true;
	}
}

class FakeVideoEncoder {
	static instances: FakeVideoEncoder[] = [];
	static reset() {
		FakeVideoEncoder.instances = [];
	}

	encodeCalls: EncodeCall[] = [];

	constructor(private init: VideoEncoderInit) {
		FakeVideoEncoder.instances.push(this);
	}

	configure() {}

	encode(frame: { timestamp: number }, opts?: { keyFrame?: boolean }) {
		this.encodeCalls.push({ timestamp: frame.timestamp, keyFrame: opts?.keyFrame });
		const data = new Uint8Array([0, 0, 0, 1]);
		this.init.output(
			{
				type: opts?.keyFrame ? 'key' : 'delta',
				timestamp: frame.timestamp,
				duration: 33_333,
				byteLength: data.byteLength,
				copyTo(dest: BufferSource) {
					new Uint8Array(dest as ArrayBuffer).set(data);
				}
			} as EncodedVideoChunk,
			{ decoderConfig: { codec: 'avc1.42E01F' } }
		);
	}

	async flush() {}
	close() {}
}

function installCodecs() {
	const prevEnc = globalThis.VideoEncoder;
	const prevFrame = globalThis.VideoFrame;
	FakeVideoEncoder.reset();
	globalThis.VideoEncoder = FakeVideoEncoder as unknown as typeof VideoEncoder;
	globalThis.VideoFrame = FakeVideoFrame as unknown as typeof VideoFrame;
	return () => {
		globalThis.VideoEncoder = prevEnc;
		globalThis.VideoFrame = prevFrame;
		FakeVideoEncoder.reset();
	};
}

let restoreCodecs: (() => void) | undefined;

afterEach(() => {
	restoreCodecs?.();
	restoreCodecs = undefined;
});

describe('encodeFrames', () => {
	it('pulls once per output frame and encodes with stepped PTS', async () => {
		restoreCodecs = installCodecs();
		const pulls: number[] = [];
		const source: FrameSource = {
			width: 64,
			height: 64,
			durationMs: 1000,
			fps: 10,
			pull: vi.fn(async (tMs) => {
				pulls.push(tMs);
				return { kind: 'canvas' } as unknown as CanvasImageSource;
			}),
			close: vi.fn()
		};

		const blob = await encodeFrames(source, { bitrate: '1M' });
		expect(blob.type).toBe('video/mp4');
		expect(source.pull).toHaveBeenCalledTimes(10);
		expect(pulls).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
		expect(source.close).toHaveBeenCalledTimes(1);

		const enc = FakeVideoEncoder.instances[0]!;
		expect(enc.encodeCalls).toHaveLength(10);
		expect(enc.encodeCalls.map((c) => c.timestamp)).toEqual([
			0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000
		]);
		expect(enc.encodeCalls[0]?.keyFrame).toBe(true);
		expect(enc.encodeCalls.slice(1).every((c) => c.keyFrame === false)).toBe(true);
	});

	it('closes the source even when pull throws', async () => {
		restoreCodecs = installCodecs();
		const source: FrameSource = {
			width: 32,
			height: 32,
			durationMs: 100,
			fps: 10,
			pull: vi.fn(async () => {
				throw new Error('pull failed');
			}),
			close: vi.fn()
		};

		await expect(encodeFrames(source, { bitrate: '1M' })).rejects.toThrow('pull failed');
		expect(source.pull).toHaveBeenCalledTimes(1);
		expect(source.close).toHaveBeenCalledTimes(1);
	});
});
