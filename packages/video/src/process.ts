import { AudioSample } from 'mediabunny';
import { createEncodeSession, parseBitrate } from './encodeSession.js';
import { openAudioChunks } from './audio.js';
import { openVideoFrames } from './videoFrames.js';
import type { ProcessOptions } from './types.js';

export type { ProcessOptions };
export { parseBitrate };

/** Trim/resize with every decoded source frame and its original presentation timing. */
export async function processVideo(inputBlob: Blob, options: ProcessOptions): Promise<Blob> {
	if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
		throw new Error('Video processing requires WebCodecs (modern Chromium-based browsers).');
	}
	const trimDuration = options.end - options.start;
	if (!(trimDuration > 0)) throw new Error('Trim end must be greater than trim start.');

	const decoded = await openVideoFrames(inputBlob, { poolSize: 1 });
	let session: ReturnType<typeof createEncodeSession> | null = null;
	try {
		const outWidth = Math.floor((options.width ?? decoded.width) / 2) * 2;
		const outHeight = Math.floor((options.height ?? decoded.height) / 2) * 2;
		const needsResize = outWidth !== decoded.width || outHeight !== decoded.height;
		const canvas = needsResize ? new OffscreenCanvas(outWidth, outHeight) : null;
		const ctx = canvas?.getContext('2d', { alpha: false });
		if (needsResize && !ctx) throw new Error('Could not acquire a 2D context for resize.');

		session = createEncodeSession({
			width: outWidth, height: outHeight, bitrate: options.bitrate,
			fpsHint: options.fpsHint ?? 30,
			audio: options.audio ? { codec: options.audio.codec ?? 'aac', bitrate: options.audio.bitrate } : undefined
		});
		const encoding = session;
		const audioDrain = options.audio
			? (async () => {
					for await (const chunk of openAudioChunks(inputBlob, {
						startSec: options.start, endSec: options.end
					})) {
						const sample = new AudioSample({
							data: chunk.data, format: chunk.format,
							numberOfChannels: chunk.numberOfChannels, sampleRate: chunk.sampleRate,
							timestamp: Math.max(0, chunk.timestamp - options.start)
						});
						try { await encoding.addAudio(sample); } finally { sample.close(); }
					}
					encoding.finishAudio();
				})()
			: null;
		// Observe failures while video decoding proceeds; await still propagates them.
		audioDrain?.catch(() => {});

		let lastProgress = -1;
		const reportProgress = (time: number) => {
			const progress = Math.min(100, Math.max(0, Math.round(((time - options.start) / trimDuration) * 100)));
			if (progress !== lastProgress) {
				lastProgress = progress;
				options.onProgress?.(progress);
			}
		};

		// Include the frame spanning the trim start, rebasing its visible part to
		// zero. Iteration preserves all subsequent source PTS, including VFR and
		// frame rates above the display refresh rate. No playback capture is involved.
		const first = await decoded.sink.getCanvas(Math.max(decoded.firstTimestamp, options.start));
		const decodeStart = first?.timestamp ?? options.start;
		let frameCount = 0;
		for await (const sample of decoded.sink.canvases(decodeStart, options.end)) {
			const start = Math.max(options.start, sample.timestamp);
			// Some containers omit a packet duration (notably the final WebM
			// frame). Keep that frame using the source-rate hint as a fallback.
			const sampleDuration = sample.duration > 0 ? sample.duration : 1 / (options.fpsHint ?? 30);
			const end = Math.min(options.end, sample.timestamp + sampleDuration);
			if (end <= start) continue;
			const timestamp = Math.max(0, Math.round((start - options.start) * 1_000_000));
			const duration = Math.max(1, Math.round((end - options.start) * 1_000_000) - timestamp);
			let image: CanvasImageSource = sample.canvas;
			if (canvas && ctx) {
				ctx.drawImage(image, 0, 0, outWidth, outHeight);
				image = canvas;
			}
			const frame = new VideoFrame(image, { timestamp, duration });
			try { encoding.encode(frame); } finally { frame.close(); }
			if (++frameCount % 32 === 0) await encoding.drain();
			reportProgress(start);
		}
		if (audioDrain) await audioDrain;
		const blob = await encoding.flush();
		reportProgress(options.end);
		return blob;
	} finally {
		session?.close();
		decoded.close();
	}
}
