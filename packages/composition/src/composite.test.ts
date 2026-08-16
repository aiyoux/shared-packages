import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composite } from './composite.js';
import { registerClipRenderer } from './protocol.js';
import type { Clip, ClipRenderer, CompositionDoc } from './types.js';

type Labeled = { label: string };

class FakeOffscreenCanvas {
	width: number;
	height: number;
	draws: Labeled[] = [];

	constructor(w: number, h: number) {
		this.width = w;
		this.height = h;
	}

	getContext(): { drawImage: (img: Labeled) => void } {
		return {
			drawImage: (img: Labeled) => {
				this.draws.push(img);
			}
		};
	}
}

function fakeRenderer(kind: string, label: string): ClipRenderer {
	return {
		kind,
		preview() {
			return () => {};
		},
		async pullFrame(_clip: Clip, _localMs: number) {
			return { label } as unknown as CanvasImageSource;
		}
	};
}

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
					offsetMs: 0,
					payload: null
				}
			]
		}
	]
};

beforeEach(() => {
	vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
	registerClipRenderer(fakeRenderer('media', 'media'));
	registerClipRenderer(fakeRenderer('igfx', 'graphics'));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('composite', () => {
	it('paints media then graphics from two fake renderers', async () => {
		const canvas = (await composite(comp, 1_000, { w: 64, h: 32 })) as unknown as FakeOffscreenCanvas;
		expect(canvas).toBeInstanceOf(FakeOffscreenCanvas);
		expect(canvas.width).toBe(64);
		expect(canvas.height).toBe(32);
		expect(canvas.draws.map((d) => d.label)).toEqual(['media', 'graphics']);
	});

	it('allocates a new canvas per call and does not hold last pixels', async () => {
		const first = (await composite(comp, 1_000, { w: 8, h: 8 })) as unknown as FakeOffscreenCanvas;
		const second = (await composite(comp, 9_000, { w: 8, h: 8 })) as unknown as FakeOffscreenCanvas;
		expect(second).not.toBe(first);
		expect(first.draws.map((d) => d.label)).toEqual(['media', 'graphics']);
		// Media clip has ended; a fresh resolve, not a held bitmap from `first`.
		expect(second.draws.map((d) => d.label)).toEqual(['graphics']);
	});
});
