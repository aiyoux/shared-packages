import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';

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

export interface EncodeSession {
	readonly width: number;
	readonly height: number;
	/** Push one frame. `frame.timestamp` is used as PTS (µs). */
	encode(frame: VideoFrame, opts?: { keyFrame?: boolean }): void;
	/** flush encoder + mux chain + finalize → video/mp4 Blob. */
	flush(): Promise<Blob>;
	close(): void;
}

export function createEncodeSession(opts: {
	width: number;
	height: number;
	bitrate: string;
	fpsHint?: number;
	onProgress?: (n: number) => void;
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
	// Factory is sync; mux waits on start so encode() can push immediately.
	const started = output.start();

	let encoderError: Error | null = null;
	let muxError: Error | null = null;
	let muxChain: Promise<void> = started.then(() => undefined).catch((e) => {
		muxError = muxError ?? (e instanceof Error ? e : new Error(String(e)));
	});

	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
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
	encoder.configure({
		codec,
		width,
		height,
		bitrate: parseBitrate(opts.bitrate),
		framerate: fpsHint,
		avc: { format: 'avc' }
	});

	let lastKeyframeUs = -Infinity;
	let encoded = 0;
	let closed = false;
	let encoderClosed = false;

	const closeEncoder = () => {
		if (encoderClosed) return;
		encoderClosed = true;
		try {
			encoder.close();
		} catch {
			/* already closed after flush */
		}
	};

	return {
		width,
		height,
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
			await encoder.flush();
			if (encoderError) throw encoderError;
			closeEncoder();
			await muxChain;
			if (muxError) throw muxError;
			await output.finalize();
			const buffer = (output.target as BufferTarget).buffer;
			if (!buffer) throw new Error('Muxing produced no output buffer.');
			return new Blob([buffer], { type: 'video/mp4' });
		},
		close() {
			closed = true;
			closeEncoder();
		}
	};
}
