import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
	calculatePageFit,
	clampPageDimension,
	destroy,
	interpretPage,
	irToSvg,
	openPdf,
	pageCount,
	pageSizePt,
	parsePageRange,
	PDF_PAGE_DIM_MAX,
	PDF_PAGE_DIM_MIN,
	renderRaster,
	resetPdfEngineForTests,
	type PdfHandle,
	type PdfIrTextElement
} from './index.js';

const openHandles: PdfHandle[] = [];

afterEach(() => {
	for (const h of openHandles.splice(0)) {
		try {
			destroy(h);
		} catch {
			// ignore
		}
	}
	resetPdfEngineForTests();
});

async function track(bytes: Uint8Array): Promise<PdfHandle> {
	const handle = await openPdf(bytes);
	openHandles.push(handle);
	return handle;
}

async function makeTextPdf(heading = 'Heading'): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([200, 120]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText(heading, {
		x: 16,
		y: 70,
		size: 18,
		font,
		color: rgb(0, 0, 0)
	});
	return new Uint8Array(await doc.save());
}

async function makeRectPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([200, 120]);
	page.drawRectangle({
		x: 20,
		y: 30,
		width: 80,
		height: 40,
		color: rgb(0.9, 0.1, 0.1)
	});
	return new Uint8Array(await doc.save());
}

describe('openPdf', () => {
	it('rejects an empty buffer', async () => {
		await expect(openPdf(new Uint8Array())).rejects.toThrow(/empty/i);
	});

	it('rejects a buffer missing %PDF-', async () => {
		await expect(openPdf(new TextEncoder().encode('not a pdf'))).rejects.toThrow(/%PDF/i);
	});

	it('opens a tiny PDF and reports page count and size', async () => {
		const handle = await track(await makeTextPdf());
		expect(pageCount(handle)).toBe(1);
		const size = pageSizePt(handle, 0);
		expect(size.width).toBeCloseTo(200, 0);
		expect(size.height).toBeCloseTo(120, 0);
	});
});

describe('interpretPage', () => {
	it('extracts a text element containing the heading word', async () => {
		const handle = await track(await makeTextPdf('Heading'));
		const result = await interpretPage(handle, 0, { targetWidth: 400, targetHeight: 240 });
		expect(result.width).toBe(400);
		expect(result.height).toBe(240);
		const texts = result.elements.filter((e) => e.type === 'text');
		expect(texts.length).toBeGreaterThanOrEqual(1);
		expect(texts.some((e) => e.type === 'text' && e.str.includes('Heading'))).toBe(true);
		expect(result.stats.texts).toBeGreaterThanOrEqual(1);
	});

	it('extracts at least one path from a rectangle page', async () => {
		const handle = await track(await makeRectPdf());
		const result = await interpretPage(handle, 0, { targetWidth: 400, targetHeight: 240 });
		const paths = result.elements.filter((e) => e.type === 'path');
		expect(paths.length).toBeGreaterThanOrEqual(1);
		expect(result.stats.paths).toBeGreaterThanOrEqual(1);
	});
});

describe('irToSvg', () => {
	it('reflects a translated text element', async () => {
		const handle = await track(await makeTextPdf('Heading'));
		const result = await interpretPage(handle, 0, { targetWidth: 400, targetHeight: 240 });
		const text = result.elements.find((e): e is PdfIrTextElement => e.type === 'text');
		expect(text).toBeTruthy();
		text!.transform = { x: 42, y: 8 };
		const svg = irToSvg(result.elements, result.width, result.height);
		expect(svg).toMatch(/translate/);
	});

	it('never includes <script', async () => {
		const handle = await track(await makeTextPdf('Heading'));
		const result = await interpretPage(handle, 0, { targetWidth: 200, targetHeight: 120 });
		const text = result.elements.find((e): e is PdfIrTextElement => e.type === 'text');
		if (text) text.str = '<script>alert(1)</script>';
		const svg = irToSvg(
			text
				? [text]
				: [
						{
							type: 'text',
							id: 't',
							str: '<script>alert(1)</script>',
							x: 0,
							y: 0,
							width: 10,
							height: 10,
							fill: '#000',
							fontSize: 12,
							d: ''
						}
					],
			200,
			120
		);
		expect(svg.includes('<script')).toBe(false);
		expect(svg).toContain('&lt;script');
	});
});

describe('parsePageRange', () => {
	it('returns every page for "all"', () => {
		expect(parsePageRange('all', 3)).toEqual([0, 1, 2]);
		expect(parsePageRange('  ALL ', 4)).toEqual([0, 1, 2, 3]);
	});

	it('parses comma-separated ranges', () => {
		expect(parsePageRange('1-3,5', 5)).toEqual([0, 1, 2, 4]);
		expect(parsePageRange('1-3, 5', 5)).toEqual([0, 1, 2, 4]);
	});

	it('returns [] for invalid input', () => {
		expect(parsePageRange('invalid', 3)).toEqual([]);
	});

	it('returns every page for an empty range string', () => {
		expect(parsePageRange('', 5)).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('calculatePageFit', () => {
	it('scales landscape and portrait pages', () => {
		const land = calculatePageFit(800, 400, 1000, 1000);
		expect(land.scale).toBe(1.25);
		expect(land.width).toBe(1000);
		expect(land.height).toBe(500);
		expect(land.x).toBe(0);
		expect(land.y).toBe(250);

		const port = calculatePageFit(400, 800, 1000, 1000);
		expect(port.scale).toBe(1.25);
		expect(port.width).toBe(500);
		expect(port.height).toBe(1000);
		expect(port.x).toBe(250);
		expect(port.y).toBe(0);
	});

	it('identity-guards non-finite or non-positive dimensions', () => {
		expect(calculatePageFit(0, 100, 100, 100)).toEqual({
			width: 100,
			height: 100,
			x: 0,
			y: 0,
			scale: 1
		});
		expect(calculatePageFit(Number.NaN, 100, 200, 300)).toEqual({
			width: 200,
			height: 300,
			x: 0,
			y: 0,
			scale: 1
		});
		expect(calculatePageFit(100, 100, -1, 50)).toEqual({
			width: -1,
			height: 50,
			x: 0,
			y: 0,
			scale: 1
		});
	});
});

describe('clampPageDimension', () => {
	it('falls back outside the safe range', () => {
		expect(clampPageDimension(50, 800)).toBe(800);
		expect(clampPageDimension(PDF_PAGE_DIM_MIN, 800)).toBe(PDF_PAGE_DIM_MIN);
		expect(clampPageDimension(500, 800)).toBe(500);
		expect(clampPageDimension(PDF_PAGE_DIM_MAX + 1, 800)).toBe(800);
		expect(clampPageDimension(Number.NaN, 800)).toBe(800);
	});
});

describe('renderRaster', () => {
	it('rasterizes a page to PNG when a canvas is available', async () => {
		const hasCanvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
		if (!hasCanvas) return;
		const handle = await track(await makeTextPdf());
		const raster = await renderRaster(handle, 0, { scale: 1 });
		expect(raster.width).toBeGreaterThan(0);
		expect(raster.height).toBeGreaterThan(0);
		expect(raster.png.byteLength).toBeGreaterThan(8);
		expect(String.fromCharCode(...raster.png.subarray(1, 4))).toBe('PNG');
	});
});
