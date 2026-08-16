import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composite } from './composite.js';
import { registerClipRenderer } from './protocol.js';
import type { ClipRenderer, CompositionDoc } from './types.js';

type Labeled = { label: string };

class FakeOffscreenCanvas {
	width: number;
	height: number;
	draws: Array<{ label: string; w: number; h: number }> = [];
	throwOnDraw = false;

	constructor(w: number, h: number) {
		this.width = w;
		this.height = h;
	}

	getContext(): { drawImage: (img: Labeled, dx: number, dy: number, w: number, h: number) => void } {
		return {
			drawImage: (img: Labeled, _dx: number, _dy: number, w: number, h: number) => {
				if (this.throwOnDraw) throw new Error('draw failed');
				this.draws.push({ label: img.label, w, h });
			}
		};
	}
}

class FakeVideoFrame {
	label: string;
	closed = false;

	constructor(label: string) {
		this.label = label;
	}

	close(): void {
		this.closed = true;
	}
}

const pulledLocalMs: number[] = [];
const pulledFrames: FakeVideoFrame[] = [];

function fakeRenderer(kind: string, label: string): ClipRenderer {
	return {
		kind,
		preview() {
			return () => {};
		},
		async pullFrame(clip, localMs) {
			pulledLocalMs.push(localMs);
			const frame = new FakeVideoFrame(`${label}:${clip.id}`);
			pulledFrames.push(frame);
			return frame as unknown as VideoFrame;
		}
	};
}

const mediaOffsetMs = 250;

const comp: CompositionDoc = {
	durationMs: 10_000,
	width: 64,
	height: 32,
	tracks: [
		{
			id: 'graphics',
			role: 'graphics',
			clips: [
				{
					id: 'igfx-main',
					kind: 'igfx',
					startMs: 0,
					durationMs: 10_000,
					offsetMs: 0,
					payload: null
				}
			]
		},
		{
			id: 'media',
			role: 'media',
			clips: [
				{
					id: 'bed',
					kind: 'media',
					startMs: 0,
					durationMs: 8_000,
					offsetMs: mediaOffsetMs,
					payload: null
				}
			]
		}
	]
};

beforeEach(() => {
	pulledLocalMs.length = 0;
	pulledFrames.length = 0;
	vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
	vi.stubGlobal('VideoFrame', FakeVideoFrame);
	registerClipRenderer(fakeRenderer('media', 'media'));
	registerClipRenderer(fakeRenderer('igfx', 'graphics'));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('composite', () => {
	it('paints media then graphics and passes localMs not raw tMs', async () => {
		const tMs = 1_000;
		const canvas = (await composite(comp, tMs, { w: 64, h: 32 })) as unknown as FakeOffscreenCanvas;
		expect(canvas).toBeInstanceOf(FakeOffscreenCanvas);
		expect(canvas.width).toBe(64);
		expect(canvas.height).toBe(32);
		expect(canvas.draws.map((d) => d.label)).toEqual(['media:bed', 'graphics:igfx-main']);
		expect(canvas.draws.map((d) => [d.w, d.h])).toEqual([
			[64, 32],
			[64, 32]
		]);
		expect(pulledLocalMs).toEqual([tMs - 0 + mediaOffsetMs, tMs - 0 + 0]);
	});

	it('allocates a new canvas per call and does not hold last pixels', async () => {
		const first = (await composite(comp, 1_000, { w: 8, h: 8 })) as unknown as FakeOffscreenCanvas;
		const second = (await composite(comp, 9_000, { w: 8, h: 8 })) as unknown as FakeOffscreenCanvas;
		expect(second).not.toBe(first);
		expect(first.draws.map((d) => d.label)).toEqual(['media:bed', 'graphics:igfx-main']);
		// Media clip has ended; a fresh resolve, not a held bitmap from `first`.
		expect(second.draws.map((d) => d.label)).toEqual(['graphics:igfx-main']);
		expect(pulledLocalMs).toEqual([1_000 + mediaOffsetMs, 1_000, 9_000]);
	});

	it('closes VideoFrame from pullFrame after draw, including when drawImage throws', async () => {
		const ok = (await composite(comp, 1_000, { w: 16, h: 16 })) as unknown as FakeOffscreenCanvas;
		expect(pulledFrames.length).toBe(2);
		expect(pulledFrames.every((f) => f.closed)).toBe(true);
		expect(ok.draws).toHaveLength(2);

		pulledFrames.length = 0;
		pulledLocalMs.length = 0;
		const orig = FakeOffscreenCanvas.prototype.getContext;
		FakeOffscreenCanvas.prototype.getContext = function (this: FakeOffscreenCanvas) {
			this.throwOnDraw = true;
			return orig.call(this);
		};
		try {
			await expect(composite(comp, 1_000, { w: 16, h: 16 })).rejects.toThrow('draw failed');
			expect(pulledFrames.length).toBeGreaterThan(0);
			expect(pulledFrames.every((f) => f.closed)).toBe(true);
		} finally {
			FakeOffscreenCanvas.prototype.getContext = orig;
		}
	});
});
