import {
	Output,
	Mp4OutputFormat,
	BufferTarget,
	EncodedVideoPacketSource,
	EncodedPacket,
	AudioSample,
	AudioSampleSource,
	type AudioCodec
} from 'mediabunny';

export type AudioExportCodec = 'aac' | 'opus';

const AUDIO_CODEC_MAP: Record<AudioExportCodec, AudioCodec> = {
	aac: 'aac',
	opus: 'opus'
};

const DEFAULT_AUDIO_BITRATE = 128_000;

export function parseBitrate(bitrate: string): number {
	const match = bitrate.match(/^(\d+(?:\.\d+)?)\s*(k|M|G)?$/i);
	if (!match) return 1_000_000;
	const value = parseFloat(match[1]);
	const unit = match[2]?.toLowerCase();
	if (unit === 'k') return value * 1_000;
	if (unit === 'm') return value * 1_000_000;
	if (unit === 'g') return value * 1_000_000_000;
	return value;
}

/**
 * Pick the lowest H.264 level whose max frame size (in macroblocks) fits the
 * given coded dimensions, and return the level's hex byte for the codec string.
 *
 * Level 3.1 (the long-standing default here) caps the coded area at 3600
 * macroblocks (≈921,600 px), so anything larger than 720p must declare a
 * higher level or the encoder rejects the configuration outright.
 * Values from the H.264 spec, Table A-1 (MaxFS column).
 */
export function avcLevelByte(width: number, height: number): string {
	const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
	// [maxFrameSizeInMacroblocks, levelByteHex] ordered ascending.
	const levels: Array<[number, string]> = [
		[1620, '1F'], // 3.1
		[3600, '1F'], // 3.1
		[5120, '20'], // 3.2
		[8192, '28'], // 4.0
		[8704, '2A'], // 4.2
		[22080, '32'], // 5.0
		[36864, '33'] // 5.1
	];
	for (const [maxFs, byte] of levels) {
		if (macroblocks <= maxFs) return byte;
	}
	return '34'; // 5.2 — anything larger still
}

const KEYFRAME_INTERVAL_US = 2_000_000;

/**
 * Encode-queue depth the producer may run ahead to before `drain()` holds it.
 * Deep enough that hardware encoders never starve from a microtask gap, small
 * enough that a stall inside WebCodecs surfaces in tens of frames, not a
 * whole export.
 */
const ENCODE_QUEUE_HIGH = 64;

export interface EncodeSession {
	readonly width: number;
	readonly height: number;
	/** Push one frame. `frame.timestamp` is used as PTS (µs). */
	encode(frame: VideoFrame, opts?: { keyFrame?: boolean }): void;
	/**
	 * Add one decoded audio sample (timestamp in seconds, on the output
	 * timeline). The audio track is created lazily on the first call, so
	 * sources without audio never produce an empty audio track. The first
	 * call's `shape` becomes the track's shape — later samples are
	 * resampled/remixed to it, so mixed-rate sources are supported.
	 */
	addAudio(
		sample: AudioSample,
		shape?: { sampleRate: number; numberOfChannels: number }
	): Promise<void>;
	/** Declare the audio stream complete, allowing video-only output when it was empty. */
	finishAudio(): void;
	/**
	 * Yield the producer while the encode queue is deep (backpressure), then
	 * catch up on muxing; never finalizes. Cheap whenever the queue has room,
	 * so callers may await it every frame instead of on an interval.
	 */
	drain(): Promise<void>;
	/** flush encoder + mux chain + finalize → video/mp4 Blob. */
	flush(): Promise<Blob>;
	close(): void;
}

export function createEncodeSession(opts: {
	width: number;
	height: number;
	bitrate: string;
	fpsHint?: number;
	audio?: { codec?: AudioExportCodec; bitrate?: number };
	onProgress?: (n: number) => void;
	/** Cancel signal: held backpressure waits release, then the session errors. */
	signal?: AbortSignal;
}): EncodeSession {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new Error('Video processing requires WebCodecs (modern Chromium-based browsers).');
	}

	const width = Math.floor(opts.width / 2) * 2;
	const height = Math.floor(opts.height / 2) * 2;
	const fpsHint = opts.fpsHint ?? 30;

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		target: new BufferTarget()
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	// Audio is discovered asynchronously. Hold video packets until its first
	// sample registers the track, or its stream ends without any samples.
	let outputStarted = false;
	let finalized = false;
	let closed = false;
	let audioFinished = false;
	let resolveStarted!: () => void;
	let rejectStarted!: (error: unknown) => void;
	const started = new Promise<void>((resolve, reject) => {
		resolveStarted = resolve; rejectStarted = reject;
	});
	const startOutput = () => {
		if (outputStarted || closed) return;
		outputStarted = true;
		void output.start().then(resolveStarted, rejectStarted);
	};
	if (!opts.audio) startOutput();

	let encoderError: Error | null = null;
	let muxError: Error | null = null;
	let packets = 0;
	let muxChain: Promise<void> = started.then(() => undefined).catch((e) => {
		muxError = muxError ?? (e instanceof Error ? e : new Error(String(e)));
	});

	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			packets += 1;
			const packet = EncodedPacket.fromEncodedChunk(chunk);
			muxChain = muxChain
				.then(() => videoSource.add(packet, meta))
				.catch((e) => {
					muxError = muxError ?? (e instanceof Error ? e : new Error(String(e)));
				});
		},
		error: (e) => {
			encoderError = e instanceof Error ? e : new Error(String(e));
		}
	});

	// H.264 Baseline (42E0…), with the level chosen to fit the output size.
	const codec = `avc1.42E0${avcLevelByte(width, height)}`;
	const config: VideoEncoderConfig = {
		codec,
		width,
		height,
		bitrate: parseBitrate(opts.bitrate),
		framerate: fpsHint,
		avc: { format: 'avc' }
	};
	if (typeof navigator !== 'undefined' && 'webdriver' in navigator && navigator.webdriver) {
		// Deterministic tests: pin the software path.
		config.hardwareAcceleration = 'prefer-software';
	} else {
		// Offline export wants the fixed-function encoder (QuickSync/NVENC/
		// VAAPI). A hint, not a requirement: browsers fall back to software on
		// their own when no hardware path is present.
		config.hardwareAcceleration = 'prefer-hardware';
	}
	encoder.configure(config);

	let lastKeyframeUs = -Infinity;
	let encoded = 0;
	let encoderClosed = false;

	// Audio: both the source and the track are added lazily so a source
	// without audio yields an output with no audio track at all. The first
	// sample's shape fixes the output shape — mediabunny's transform
	// resamples/remixes later samples to it, so mixed-rate stacks work.
	let audioSource: AudioSampleSource | null = null;
	const addAudio = (
		sample: AudioSample,
		shape?: { sampleRate: number; numberOfChannels: number }
	): Promise<void> => {
		if (closed || audioFinished) return Promise.reject(new Error('EncodeSession audio is closed'));
		if (!opts.audio) return Promise.resolve();
		if (!audioSource) {
			audioSource = new AudioSampleSource({
				codec: AUDIO_CODEC_MAP[opts.audio.codec ?? 'aac'],
				bitrate: opts.audio.bitrate ?? DEFAULT_AUDIO_BITRATE,
				transform: shape
					? { sampleRate: shape.sampleRate, numberOfChannels: shape.numberOfChannels }
					: undefined
			});
			output.addAudioTrack(audioSource);
			startOutput();
		}
		// Serialize with the video packet adds on the same mux chain.
		const added = muxChain.then(() => audioSource!.add(sample));
		muxChain = added.then(
			() => undefined,
			(e) => {
				muxError = muxError ?? (e instanceof Error ? e : new Error(String(e)));
			}
		);
		return added;
	};

	const closeEncoder = () => {
		if (encoderClosed) return;
		encoderClosed = true;
		try {
			encoder.close();
		} catch {
			/* already closed after flush */
		}
	};
	const drain = async () => {
		if (closed) throw new Error('EncodeSession is closed');
		if (encoderError) throw encoderError;
		// Backpressure, not a flush: holding the producer while the queue has
		// room costs nothing, and waiting on dequeue keeps WebCodecs' internal
		// pipeline full where a periodic flush() would empty it every 32 frames.
		while (encoder.encodeQueueSize > ENCODE_QUEUE_HIGH) {
			await new Promise<void>((resolve, reject) => {
				const signal = opts.signal;
				const onDequeue = () => {
					cleanup();
					resolve();
				};
				const onAbort = () => {
					cleanup();
					reject(signal!.reason instanceof Error ? signal!.reason : new DOMException('Export cancelled.', 'AbortError'));
				};
				const cleanup = () => {
					encoder.removeEventListener('dequeue', onDequeue);
					signal?.removeEventListener('abort', onAbort);
				};
				encoder.addEventListener('dequeue', onDequeue);
				signal?.addEventListener('abort', onAbort);
			});
			if (encoderError) throw encoderError;
		}
		// Catch up on muxing only after the output has started. Before that
		// (audio discovered lazily), the chain can only queue packets behind
		// start, so blocking the producer there would stall video for as long
		// as the audio opener takes, not for any muxer backlog that exists.
		if (!(opts.audio && !audioSource)) {
			await muxChain;
			if (muxError) throw muxError;
		}
	};

	return {
		width,
		height,
		addAudio,
		drain,
		finishAudio() {
			audioFinished = true;
			startOutput();
		},
		encode(frame, encodeOpts) {
			if (closed || encoderClosed) {
				throw new Error('EncodeSession is closed');
			}
			if (encoderError) throw encoderError;

			const tsUs = frame.timestamp;
			// First encode is always a key; then every 2 s of PTS. keyFrame: true forces.
			const wantKeyframe =
				encodeOpts?.keyFrame === true ||
				lastKeyframeUs === -Infinity ||
				tsUs - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
			if (wantKeyframe) lastKeyframeUs = tsUs;

			encoder.encode(frame, { keyFrame: wantKeyframe });
			encoded += 1;
			opts.onProgress?.(encoded);
		},
		async flush() {
			if (closed) throw new Error('EncodeSession is closed');
			if (encoderError) throw encoderError;
			audioFinished = true;
			startOutput();
			await encoder.flush();
			if (encoderError) throw encoderError;
			closeEncoder();
			// Finalizing with no packets writes a valid-looking 152-byte MP4
			// with no tracks — it saves as a success and never plays.
			if (encoded === 0) {
				throw new Error('No video frames were captured from the source, so nothing was exported.');
			}
			if (packets === 0) {
				throw new Error(
					`The browser's H.264 encoder (${codec}, ${width}×${height}) returned no data for ${encoded} frames.`
				);
			}
			await muxChain;
			if (muxError) throw muxError;
			await output.finalize();
			finalized = true;
			const buffer = (output.target as BufferTarget).buffer;
			if (!buffer) throw new Error('Muxing produced no output buffer.');
			return new Blob([buffer], { type: 'video/mp4' });
		},
		close() {
			if (closed) return;
			closed = true;
			closeEncoder();
			rejectStarted(new Error('EncodeSession is closed'));
			if (!finalized) void output.cancel().catch(() => {});
		}
	};
}
