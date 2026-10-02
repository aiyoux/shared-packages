/**
 * Shared test harness for the WebCodecs encode paths (encodeSession and
 * encodeFrames tests): a mediabunny mock that records mux order, and fake
 * VideoEncoder / VideoFrame globals. Tests install the mock with
 * `vi.mock('mediabunny', async () => (await import('./encodeTestHarness.js')).mediabunnyMock())`
 * (vi.mock is hoisted above imports, so the factory imports lazily).
 */

/** Mux calls in the order they happened; tests reset it after each case. */
export const muxOrder: string[] = [];

export function mediabunnyMock() {
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
	class AudioSample {
		closed = false;
		constructor(public init: Record<string, unknown>) {}
		close() {
			this.closed = true;
		}
	}
	class AudioSampleSource {
		static instances: AudioSampleSource[] = [];
		adds: unknown[] = [];
		constructor(public config: unknown) {
			(AudioSampleSource as unknown as { instances: unknown[] }).instances.push(this);
		}
		async add(sample: unknown) {
			this.adds.push(sample);
			muxOrder.push('audio-add');
		}
	}
	class Output {
		target: BufferTarget;
		constructor(opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
		addVideoTrack() {
			muxOrder.push('add-video-track');
		}
		addAudioTrack() {
			muxOrder.push('add-audio-track');
		}
		async start() {}
		async finalize() {
			muxOrder.push('finalize');
			this.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer;
		}
	}
	return {
		Output,
		Mp4OutputFormat,
		BufferTarget,
		EncodedVideoPacketSource,
		EncodedPacket,
		AudioSample,
		AudioSampleSource
	};
}

export type MockAudioSource = { config: unknown; adds: Array<{ init: Record<string, unknown>; closed: boolean }> };

export type EncodeCall = { timestamp: number; keyFrame?: boolean };

export class FakeVideoFrame {
	timestamp: number;
	closed = false;
	constructor(_source?: unknown, init?: { timestamp?: number }) {
		this.timestamp = init?.timestamp ?? 0;
	}
	close() {
		this.closed = true;
	}
}

export class FakeVideoEncoder {
	static instances: FakeVideoEncoder[] = [];
	static reset() {
		FakeVideoEncoder.instances = [];
	}

	configureCalls: VideoEncoderConfig[] = [];
	encodeCalls: EncodeCall[] = [];
	flushCount = 0;
	closeCount = 0;

	constructor(private init: VideoEncoderInit) {
		FakeVideoEncoder.instances.push(this);
	}

	configure(config: VideoEncoderConfig) {
		this.configureCalls.push(config);
	}

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

	async flush() {
		this.flushCount += 1;
	}

	close() {
		this.closeCount += 1;
	}
}

export function installCodecs() {
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
