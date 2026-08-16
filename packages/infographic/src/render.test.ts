import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, rasterize, renderSvg, resolve } from './index.js';
import type { ResolvedFrame } from './types.js';

function tinyFrame(): ResolvedFrame {
	return {
		width: 2,
		height: 2,
		background: '#000000',
		nodes: [
			{
				id: 'r',
				tag: 'rect',
				attrs: { x: '0', y: '0', width: '2', height: '2', fill: '#ffffff' }
			}
		],
		warnings: []
	};
}

describe('renderSvg', () => {
	it('emits xmlns, width, height, and viewBox on the root', () => {
		const doc = createDocument();
		const svg = renderSvg(resolve(doc, 0));
		expect(svg.startsWith('<svg ')).toBe(true);
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain('width="1920"');
		expect(svg).toContain('height="1080"');
		expect(svg).toContain('viewBox="0 0 1920 1080"');
	});

	it('escapes text and attribute values', () => {
		const doc = createDocument();
		doc.marks = [
			{
				id: 't',
				kind: 'text',
				layout: { x: 10, y: 20, w: 200, h: 40 },
				bindings: { text: '<hello & "world">' }
			}
		];
		const svg = renderSvg(resolve(doc, 0));
		expect(svg).not.toContain('<hello');
		expect(svg).toContain('&lt;hello &amp; &quot;world&quot;&gt;');
	});

	it('emits a user-space clipPath rect for line progress, not CSS inset', () => {
		const doc = createDocument();
		doc.datasets = [
			{
				id: 'd',
				label: 'D',
				columns: [
					{ id: 't', label: 'T', type: 'number' },
					{ id: 'n', label: 'N', type: 'number' }
				],
				rows: [
					{ t: 0, n: 1 },
					{ t: 1, n: 2 }
				]
			}
		];
		doc.marks = [
			{
				id: 'trend',
				kind: 'line',
				layout: { x: 160, y: 200, w: 1600, h: 720 },
				bindings: { x: { ref: 'dataset:d.t' }, y: { ref: 'dataset:d.n' } }
			}
		];
		doc.timeline.tracks = [
			{
				id: 'grow',
				target: 'mark:trend.progress',
				keyframes: [
					{ tMs: 0, value: 0, easing: 'linear' },
					{ tMs: 1000, value: 1 }
				]
			}
		];
		const svg = renderSvg(resolve(doc, 500));
		expect(svg).toContain('<clipPath');
		expect(svg).toContain('clip-path="url(#trend-clip)"');
		expect(svg).not.toMatch(/clip-path="inset/);
		expect(svg).toMatch(/<rect[^>]*x="160"[^>]*width="800"/);
	});
});

describe('rasterize', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('sizes the canvas via Image + object URL (DOM stub in node)', async () => {
		// Node has no HTMLImageElement that can decode SVG. This stub covers the
		// contract; a real pixel assertion needs Chromium (see skipped test below).
		const drawImage = vi.fn();
		const clearRect = vi.fn();
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({ clearRect, drawImage })
		};
		vi.stubGlobal(
			'Image',
			class {
				src = '';
				decode() {
					return Promise.resolve();
				}
			}
		);
		vi.stubGlobal('URL', {
			createObjectURL: () => 'blob:igfx-test',
			revokeObjectURL: vi.fn()
		});

		await rasterize(tinyFrame(), canvas as unknown as HTMLCanvasElement);
		expect(canvas.width).toBe(2);
		expect(canvas.height).toBe(2);
		expect(clearRect).toHaveBeenCalled();
		expect(drawImage).toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:igfx-test');
	});

	it('rasterize of a 2×2 rect produces non-empty pixels (node canvas mock)', async () => {
		// Node cannot decode an SVG Blob (`Image` / createImageBitmap). The mock
		// paints when drawImage runs so getImageData can assert non-empty pixels.
		const pixels = new Uint8ClampedArray(2 * 2 * 4);
		const ctx = {
			clearRect: () => {
				pixels.fill(0);
			},
			drawImage: () => {
				for (let i = 0; i < pixels.length; i += 4) {
					pixels[i] = 255;
					pixels[i + 1] = 255;
					pixels[i + 2] = 255;
					pixels[i + 3] = 255;
				}
			},
			getImageData: () => ({ data: pixels, width: 2, height: 2 })
		};
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ctx
		};
		vi.stubGlobal(
			'Image',
			class {
				src = '';
				decode() {
					return Promise.resolve();
				}
			}
		);
		vi.stubGlobal('URL', {
			createObjectURL: () => 'blob:igfx-pixels',
			revokeObjectURL: vi.fn()
		});

		await rasterize(tinyFrame(), canvas as unknown as HTMLCanvasElement);
		const data = ctx.getImageData().data;
		expect(data.some((n) => n > 0)).toBe(true);
	});
});
