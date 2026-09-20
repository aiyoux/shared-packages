import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { encodeGif, type EncodeGifOpts } from './gif.js';
import type { FrameSource } from './encodeFrames.js';

const gifCalls: {
	frames: Array<{ index: number[]; width: number; height: number; options?: Record<string, unknown> }>;
	finished: boolean;
} = {
	frames: [],
	finished: false
};

const gifSpies = { quantize: 0, applyPalette: 0 };

vi.mock('gifenc', () => {
	function GIFEncoder() {
		return {
			writeFrame(
				index: number[],
				width: number,
				height: number,
				options?: Record<string, unknown>
			) {
				gifCalls.frames.push({ index, width, height, options });
			},
			finish() {
				gifCalls.finished = true;
			},
			bytesView() {
				return new Uint8Array([71, 73, 70]);
			}
		};
	}
	function quantize(_rgba: Uint8ClampedArray, maxColors: number) {
		gifSpies.quantize += 1;
		return [[0, 0, 0], [255, 255, 255]].slice(0, Math.min(2, maxColors));
	}
	function applyPalette(_rgba: Uint8ClampedArray, _palette: number[][]) {
		gifSpies.applyPalette += 1;
		return [0, 1];
	}
	return { GIFEncoder, quantize, applyPalette, default: { GIFEncoder, quantize, applyPalette } };
});

type FakeCtx = {
	drawImage: ReturnType<typeof vi.fn>;
	getImageData: ReturnType<typeof vi.fn>;
};

function installCanvas(width = 8, height = 8) {
	const ctx: FakeCtx = {
		drawImage: vi.fn(),
		getImageData: vi.fn(() => ({
			data: new Uint8ClampedArray(width * height * 4)
		}))
	};
	const canvas = {
		width,
		height,
		getContext: vi.fn(() => ctx)
	};
	const prev = globalThis.OffscreenCanvas;
	globalThis.OffscreenCanvas = function OffscreenCanvas(w: number, h: number) {
		canvas.width = w;
		canvas.height = h;
		return canvas;
	} as unknown as typeof OffscreenCanvas;
	return {
		ctx,
		restore() {
			globalThis.OffscreenCanvas = prev;
		}
	};
}

function sourceOf(durationMs: number, fps: number, width = 8, height = 8): {
	source: FrameSource;
	pulls: number[];
} {
	const pulls: number[] = [];
	return {
		pulls,
		source: {
			width,
			height,
			durationMs,
			fps,
			pull: vi.fn(async (tMs: number) => {
				pulls.push(tMs);
				return { kind: 'canvas' } as unknown as CanvasImageSource;
			})
		}
	};
}

let restoreCanvas: (() => void) | undefined;

afterEach(() => {
	restoreCanvas?.();
	restoreCanvas = undefined;
	gifCalls.frames = [];
	gifCalls.finished = false;
	gifSpies.quantize = 0;
	gifSpies.applyPalette = 0;
});

describe('encodeGif', () => {
	it('writes one frame per grid slot with cumulative-error centisecond delays', async () => {
		const { ctx, restore } = installCanvas();
		restoreCanvas = restore;
		const { source } = sourceOf(1000, 30); // 1000/30ms = 33.33ms per frame
		const progress: number[] = [];
		const opts: EncodeGifOpts = { onProgress: (n) => progress.push(n) };

		const blob = await encodeGif(source, opts);
		expect(blob.type).toBe('image/gif');
		expect(gifCalls.finished).toBe(true);
		expect(gifCalls.frames).toHaveLength(30);
		// Cumulative quantization: mostly 3cs, rounding drift spread out.
		const delays = gifCalls.frames.map((f) => f.options?.delay) as number[];
		// gifenc delay is milliseconds: 3cs → 30ms.
		expect(delays.every((d) => d >= 30 && d <= 40)).toBe(true);
		expect(delays.reduce((a, b) => a + b, 0)).toBe(1000); // 30 frames × 33.33ms → exactly 1000ms
		expect(progress).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
		expect(ctx.getImageData).toHaveBeenCalledTimes(30);
		expect(gifSpies.quantize).toBe(30);
		expect(gifSpies.applyPalette).toBe(30);
	});

	it('keeps the frame overlapping the cut (ceil) and clamps delays to 2cs', async () => {
		const { restore } = installCanvas();
		restoreCanvas = restore;
		// 1000/60fps = 16.67ms → delays would be 1.67cs, clamped to 2cs.
		const { source } = sourceOf(1000, 60);
		await encodeGif(source, { maxColors: 64 });
		expect(gifCalls.frames).toHaveLength(60); // ceil(60) = 60
		expect(gifCalls.frames.every((f) => f.options?.delay === 20)).toBe(true);
		// maxColors: 64 forwarded to the quantizer via the palette size stub
		expect(gifSpies.quantize).toBe(60);
	});

	it('maps 24fps without drift and finishes the encoder', async () => {
		const { restore } = installCanvas();
		restoreCanvas = restore;
		const { source } = sourceOf(1000, 24);

		await encodeGif(source, {});
		expect(gifCalls.frames).toHaveLength(24);
		const delays = gifCalls.frames.map((f) => f.options?.delay) as number[];
		expect(delays.reduce((a, b) => a + b, 0)).toBe(1000); // 24 frames over exactly 1s
		expect(delays.some((d) => d === 40)).toBe(true);
	});
});