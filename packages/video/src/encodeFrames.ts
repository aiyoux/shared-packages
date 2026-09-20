import { AudioSample } from 'mediabunny';
import { createEncodeSession, type AudioExportCodec } from './encodeSession.js';
import type { RawAudioChunk } from './audio.js';

export interface FrameSource {
	width: number;
	height: number;
	durationMs: number;
	fps: number;
	pull(tMs: number): Promise<CanvasImageSource | VideoFrame>;
	close?(): void | Promise<void>;
}

export type EncodeFramesAudio = {
	/** Audio chunks with timestamps already rebased to the output timeline (seconds). */
	chunks: AsyncIterable<RawAudioChunk>;
	codec?: AudioExportCodec;
	bitrate?: number;
};

/** Generated-frame PULL client. Steps t = 0 .. duration at 1/fps and pushes into EncodeSession. */
export async function encodeFrames(
	source: FrameSource,
	options: { bitrate: string; audio?: EncodeFramesAudio; onProgress?: (n: number) => void }
): Promise<Blob> {
	const session = createEncodeSession({
		width: source.width,
		height: source.height,
		bitrate: options.bitrate,
		fpsHint: source.fps,
		audio: options.audio
			? { codec: options.audio.codec ?? 'aac', bitrate: options.audio.bitrate }
			: undefined,
		onProgress: options.onProgress
	});
	// Ceil: the last frame that overlaps the kept range is kept, so a trim
	// never drops visible content (output may run up to one frame long).
	const frameCount = Math.max(1, Math.ceil((source.durationMs / 1000) * source.fps));
	const dtUs = Math.round(1_000_000 / source.fps);

	const drainAudio = async (): Promise<void> => {
		if (!options.audio) return;
		let shape: { sampleRate: number; numberOfChannels: number } | undefined;
		for await (const chunk of options.audio.chunks) {
			const sample = new AudioSample({
				data: chunk.data,
				format: chunk.format,
				numberOfChannels: chunk.numberOfChannels,
				sampleRate: chunk.sampleRate,
				timestamp: chunk.timestamp
			});
			try {
				// First chunk fixes the output shape; mediabunny resamples and
				// remixes any later chunk that differs (mixed-rate stacks).
				await session.addAudio(sample, (shape ??= chunk));
			} finally {
				sample.close();
			}
		}
	};

	try {
		// Audio drains concurrently with the video pull; both must finish
		// before flush, which finalizes the output. Swallow an early
		// rejection if the video loop throws first; the await below still
		// surfaces audio errors on the happy path.
		const audioDrain = drainAudio();
		audioDrain.catch(() => {});
		for (let i = 0; i < frameCount; i++) {
			const tMs = (i / source.fps) * 1000;
			const img = await source.pull(tMs);
			const ts = i * dtUs;
			const vf = img instanceof VideoFrame ? img : new VideoFrame(img, { timestamp: ts });
			session.encode(vf); // session keys first frame + every 2 s of PTS
			if (img instanceof VideoFrame === false) vf.close();
			else img.close();
		}
		await audioDrain;
		return await session.flush();
	} finally {
		session.close();
		await source.close?.();
	}
}