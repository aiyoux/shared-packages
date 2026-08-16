import { createEncodeSession, parseBitrate } from './encodeSession.js';
import type { ProcessOptions } from './types.js';

export type { ProcessOptions };
export { parseBitrate };

type RVFCMetadata = VideoFrameCallbackMetadata;

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
 *
 * Capture is play + RVFC + metadata.mediaTime. Do not seek currentTime per frame.
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

	let session: ReturnType<typeof createEncodeSession> | null = null;

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

		session = createEncodeSession({
			width: outWidth,
			height: outHeight,
			bitrate: options.bitrate,
			fpsHint: 30
		});

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
			const onFrame = (_now: number, metadata: RVFCMetadata) => {
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

					session!.encode(frame);
					frame.close();

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

		const blob = await session.flush();
		reportProgress(options.end);
		return blob;
	} finally {
		session?.close();
		cleanupDom();
	}
}
