import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';
import type { ProcessOptions } from './types.js';

export type { ProcessOptions };

type RVFCMetadata = VideoFrameCallbackMetadata;

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
function avcLevelByte(width: number, height: number): string {
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

/**
 * Trim and optionally resize a video using WebCodecs.
 *
 * Frames are captured from the source via requestVideoFrameCallback, which
 * yields the original media-time PTS for each decoded frame. That PTS is
 * used directly as the encoder timestamp, so the output's frame timing
 * exactly mirrors the source — even if the source plays slowly due to
 * decoder throttling. Encoded with H.264 (AVC) and muxed into an MP4 via
 * Mediabunny, which writes proper duration metadata so playback is consistent
 * everywhere the blob is consumed.
 *
 * Requires modern Chromium (Chrome / Edge / Brave). No Safari fallback.
 */
export async function processVideo(inputBlob: Blob, options: ProcessOptions): Promise<Blob> {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new Error('Video processing requires WebCodecs (modern Chromium-based browsers).');
	}

	const trimDuration = options.end - options.start;
	if (!(trimDuration > 0)) {
		throw new Error('Trim end must be greater than trim start.');
	}

	const video = document.createElement('video') as HTMLVideoElement;
	if (typeof video.requestVideoFrameCallback !== 'function') {
		throw new Error('Video processing requires requestVideoFrameCallback.');
	}

	video.src = URL.createObjectURL(inputBlob);
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';

	// The element must be in the layout for Chrome to keep decoding it
	// promptly. Even at full size visually we'd be fine; we just hide it.
	const host = document.createElement('div');
	host.style.position = 'fixed';
	host.style.inset = '0 0 auto auto'; // top-right corner
	host.style.width = '2px';
	host.style.height = '2px';
	host.style.opacity = '0.01';
	host.style.pointerEvents = 'none';
	host.style.zIndex = '-1';
	video.style.width = '100%';
	video.style.height = '100%';
	host.appendChild(video);
	document.body.appendChild(host);

	const cleanupDom = () => {
		if (host.parentNode) host.parentNode.removeChild(host);
		URL.revokeObjectURL(video.src);
	};

	try {
		await new Promise<void>((resolve, reject) => {
			video.onloadedmetadata = () => resolve();
			video.onerror = () => reject(new Error('Failed to load video metadata'));
		});

		await new Promise<void>((resolve) => {
			const onSeeked = () => {
				video.removeEventListener('seeked', onSeeked);
				resolve();
			};
			video.addEventListener('seeked', onSeeked);
			video.currentTime = options.start;
		});

		let outWidth = options.width ?? video.videoWidth;
		let outHeight = options.height ?? video.videoHeight;

		// Ensure width and height are even for H.264 / WebCodecs compatibility
		outWidth = Math.floor(outWidth / 2) * 2;
		outHeight = Math.floor(outHeight / 2) * 2;

		const needsResize = outWidth !== video.videoWidth || outHeight !== video.videoHeight;

		const offscreen = needsResize ? new OffscreenCanvas(outWidth, outHeight) : null;
		const offCtx = offscreen
			? offscreen.getContext('2d', { alpha: false }) ?? undefined
			: undefined;
		if (needsResize && !offCtx) {
			throw new Error('Could not acquire a 2D context on OffscreenCanvas for resize.');
		}

		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
			target: new BufferTarget()
		});
		const videoSource = new EncodedVideoPacketSource('avc');
		output.addVideoTrack(videoSource);
		await output.start();

		const bitsPerSecond = parseBitrate(options.bitrate);
		let encoderError: Error | null = null;
		let muxError: Error | null = null;
		// EncodedVideoPacketSource.add() is async (for writer/encoder
		// backpressure). Chain the calls so packets are muxed in the order the
		// encoder emits them, and so we can await completion before finalizing.
		// Errors are captured rather than left to reject the chain unhandled.
		let muxChain: Promise<void> = Promise.resolve();
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
		const codec = `avc1.42E0${avcLevelByte(outWidth, outHeight)}`;
		encoder.configure({
			codec,
			width: outWidth,
			height: outHeight,
			bitrate: bitsPerSecond,
			framerate: 30,
			avc: { format: 'avc' }
		});

		const KEYFRAME_INTERVAL_US = 2_000_000;
		let lastKeyframeUs = -Infinity;

		let lastReportedProgress = -1;
		const reportProgress = (mediaTimeSec: number) => {
			if (!options.onProgress) return;
			const raw = ((mediaTimeSec - options.start) / trimDuration) * 100;
			const clamped = Math.min(100, Math.max(0, Math.round(raw)));
			if (clamped !== lastReportedProgress) {
				lastReportedProgress = clamped;
				options.onProgress(clamped);
			}
		};

		// Capture frames as the source plays. Each callback delivers
		// metadata.mediaTime — the source PTS of the frame currently painted
		// on the element — which we forward verbatim (rebased to 0) to the
		// encoder so output timing exactly mirrors source timing at whatever
		// frame rate the source actually runs at.
		const captureDone = new Promise<void>((resolve, reject) => {
			let kept = false;

			const onFrame = (_now: number, metadata: RVFCMetadata) => {
				if (encoderError) {
					reject(encoderError);
					return;
				}

				const mediaTime = metadata.mediaTime;

				if (mediaTime < options.start - 1e-3) {
					// Haven't entered the trim window yet — wait for next frame.
					video.requestVideoFrameCallback(onFrame);
					return;
				}

				if (mediaTime > options.end + 1e-3 || video.ended) {
					resolve();
					return;
				}

				const tsUs = Math.max(0, Math.round((mediaTime - options.start) * 1_000_000));

				try {
					let frame: VideoFrame;
					if (needsResize && offscreen && offCtx) {
						offCtx.drawImage(video, 0, 0, outWidth, outHeight);
						frame = new VideoFrame(offscreen, { timestamp: tsUs });
					} else {
						frame = new VideoFrame(video, { timestamp: tsUs });
					}

					const wantKeyframe = !kept || tsUs - lastKeyframeUs >= KEYFRAME_INTERVAL_US;
					if (wantKeyframe) lastKeyframeUs = tsUs;

					encoder.encode(frame, { keyFrame: wantKeyframe });
					frame.close();

					kept = true;
					reportProgress(mediaTime);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
					return;
				}

				video.requestVideoFrameCallback(onFrame);
			};

			// Detect end of source even if rVFC stops firing.
			const onEnded = () => {
				video.removeEventListener('ended', onEnded);
				resolve();
			};
			video.addEventListener('ended', onEnded);

			video.requestVideoFrameCallback(onFrame);
			video.play().catch((err) => {
				/* Autoplay may reject silently; rVFC will still fire as the
				   element decodes. Surface only hard errors. */
				if (err && err.name && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
					reject(err);
				}
			});
		});

		await captureDone;

		if (!video.paused) video.pause();

		await encoder.flush();
		if (encoderError) throw encoderError;
		encoder.close();
		await muxChain;
		if (muxError) throw muxError;
		await output.finalize();

		reportProgress(options.end);

		const buffer = (output.target as BufferTarget).buffer;
		if (!buffer) throw new Error('Muxing produced no output buffer.');
		return new Blob([buffer], { type: 'video/mp4' });
	} finally {
		cleanupDom();
	}
}

