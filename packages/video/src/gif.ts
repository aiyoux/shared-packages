import gifenc from 'gifenc';

// gifenc is CJS. Named ESM imports 500 under Vite SSR (`applyPalette` is not
// a named export). The default object is the runtime module.
const { GIFEncoder, quantize, applyPalette } = gifenc;
import type { FrameSource } from './encodeFrames.js';

export type EncodeGifOpts = {
	onProgress?: (n: number) => void;
	/** Colors per frame (GIF palette limit). Default 256. */
	maxColors?: number;
};

/**
 * Browser GIF playback clamps delays under 2 centiseconds to 2cs, which
 * makes a real frame rate above ~50 fps unrepresentable. Clamp the written
 * delay so what-you-see matches the arithmetic.
 */
const MIN_DELAY_CS = 2;

/**
 * Render a FrameSource onto a fixed fps grid and encode an animated GIF.
 *
 * Delays use cumulative-error centisecond quantization: GIF stores whole
 * centiseconds, so a naive per-frame `round(1000/fps/10)` drifts — the
 * difference of the cumulative rounding keeps total duration exact and each
 * frame within 10ms of its grid slot.
 */
export async function encodeGif(
	source: FrameSource,
	opts: EncodeGifOpts = {}
): Promise<Blob> {
	const width = source.width;
	const height = source.height;
	const maxColors = opts.maxColors ?? 256;
	// Same ceil semantics as encodeFrames: keep the frame overlapping the cut.
	const frameCount = Math.max(1, Math.ceil((source.durationMs / 1000) * source.fps));

	const canvas =
		typeof OffscreenCanvas !== 'undefined'
			? new OffscreenCanvas(width, height)
			: (() => {
					if (typeof document === 'undefined') {
						throw new Error('GIF encoding needs a canvas to draw frames');
					}
					const el = document.createElement('canvas');
					el.width = width;
					el.height = height;
					return el;
				})();
	const ctx = canvas.getContext('2d', { alpha: false }) as
		| OffscreenCanvasRenderingContext2D
		| CanvasRenderingContext2D
		| null;
	if (!ctx) throw new Error('Could not acquire a 2D context for GIF encoding');

	const encoder = GIFEncoder();
	try {
		for (let i = 0; i < frameCount; i++) {
			const tMs = (i / source.fps) * 1000;
			const img = await source.pull(tMs);
			try {
				ctx.drawImage(img as CanvasImageSource, 0, 0, width, height);
			} finally {
				if (typeof VideoFrame !== 'undefined' && img instanceof VideoFrame) img.close();
			}
			const rgba = ctx.getImageData(0, 0, width, height).data;
			const palette = quantize(rgba, maxColors);
			const index = applyPalette(rgba, palette);
			// Cumulative-error delay in centiseconds; gifenc's `delay` is in
			// milliseconds and divides by 10 internally, so feed exact ms.
			const delayCs = Math.max(
				MIN_DELAY_CS,
				Math.round(((i + 1) * 1000) / source.fps / 10) - Math.round((i * 1000) / source.fps / 10)
			);
			encoder.writeFrame(index, width, height, { palette, delay: delayCs * 10 });
			opts.onProgress?.(i + 1);
		}
	} finally {
		encoder.finish();
	}
	return new Blob([encoder.bytesView() as unknown as BlobPart], { type: 'image/gif' });
}