import { createEncodeSession } from './encodeSession.js';

export interface FrameSource {
	width: number;
	height: number;
	durationMs: number;
	fps: number;
	pull(tMs: number): Promise<CanvasImageSource | VideoFrame>;
	close?(): void | Promise<void>;
}

/** Generated-frame PULL client. Steps t = 0 .. duration at 1/fps and pushes into EncodeSession. */
export async function encodeFrames(
	source: FrameSource,
	options: { bitrate: string; onProgress?: (n: number) => void }
): Promise<Blob> {
	const session = createEncodeSession({
		width: source.width,
		height: source.height,
		bitrate: options.bitrate,
		fpsHint: source.fps,
		onProgress: options.onProgress
	});
	const frameCount = Math.max(1, Math.round((source.durationMs / 1000) * source.fps));
	const dtUs = Math.round(1_000_000 / source.fps);
	try {
		for (let i = 0; i < frameCount; i++) {
			const tMs = (i / source.fps) * 1000;
			const img = await source.pull(tMs);
			const ts = i * dtUs;
			const vf = img instanceof VideoFrame ? img : new VideoFrame(img, { timestamp: ts });
			session.encode(vf); // session keys first frame + every 2 s of PTS
			if (img instanceof VideoFrame === false) vf.close();
			else img.close();
		}
		return await session.flush();
	} finally {
		session.close();
		await source.close?.();
	}
}
