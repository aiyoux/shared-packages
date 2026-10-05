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
		started = false;
		async add() {
			if (!this.started) throw new Error('Output has not been started.');
			muxOrder.push('video-add');
		}
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
		started = false;
		constructor(public config: unknown) {
			(AudioSampleSource as unknown as { instances: unknown[] }).instances.push(this);
		}
		async add(sample: unknown) {
			if (!this.started) throw new Error('Output has not been started.');
			this.adds.push(sample);
			muxOrder.push('audio-add');
		}
	}
	class Output {
		target: BufferTarget;
		state = 'pending';
		sources: Array<{ started: boolean }> = [];
		constructor(opts: { target: BufferTarget }) {
			this.target = opts.target;
		}
		addVideoTrack(source: EncodedVideoPacketSource) {
			if (this.state !== 'pending') throw new Error('Cannot add track after output has been started or canceled.');
			this.sources.push(source);
			muxOrder.push('add-video-track');
		}
		addAudioTrack(source: AudioSampleSource) {
			if (this.state !== 'pending') throw new Error('Cannot add track after output has been started or canceled.');
			this.sources.push(source);
			muxOrder.push('add-audio-track');
		}
		async start() {
			this.state = 'started';
			for (const source of this.sources) source.started = true;
			muxOrder.push('start');
		}
		async cancel() { this.state = 'canceled'; for (const source of this.sources) source.started = false; }
		async finalize() {
			if (this.state !== 'started') throw new Error('Output has not been started.');
			this.state = 'finalized';
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
	duration: number | undefined;
	frameId: number | undefined;
	closed = false;
	constructor(source?: unknown, init?: { timestamp?: number; duration?: number }) {
		this.timestamp = init?.timestamp ?? 0;
		this.duration = init?.duration;
		this.frameId = (source as { id?: number; frameId?: number } | undefined)?.id
			?? (source as { frameId?: number } | undefined)?.frameId;
	}
	close() {
		this.closed = true;
	}
}

export class FakeVideoEncoder {
	static instances: FakeVideoEncoder[] = [];
	/** Accept frames but emit no chunks, like an encoder that fails silently. */
	static silent = false;
	static reset() {
		FakeVideoEncoder.instances = [];
		FakeVideoEncoder.silent = false;
	}

	configureCalls: VideoEncoderConfig[] = [];
	encodeCalls: EncodeCall[] = [];
	frames: Array<{ timestamp: number; duration?: number; frameId?: number }> = [];
	flushCount = 0;
	closeCount = 0;

	constructor(private init: VideoEncoderInit) {
		FakeVideoEncoder.instances.push(this);
	}

	configure(config: VideoEncoderConfig) {
		this.configureCalls.push(config);
	}

	encode(frame: { timestamp: number }, opts?: { keyFrame?: boolean }) {
		this.frames.push(frame);
		this.encodeCalls.push({ timestamp: frame.timestamp, keyFrame: opts?.keyFrame });
		if (FakeVideoEncoder.silent) return;
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
