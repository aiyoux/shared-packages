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

	// Browser-only: rasterize of a 2×2 rect must produce non-empty pixels.
	// Skip in node — Image.decode() of an SVG Blob is a Chromium/DOM path, and
	// createImageBitmap cannot decode SVG (WHATWG html#923).
	it.skip('rasterize of a 2×2 rect produces non-empty pixels', () => {
		// Implemented in a browser runner: new Image() + object URL + decode + getImageData.
	});
});
