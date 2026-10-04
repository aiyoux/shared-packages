import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import {
	destroy,
	interpretPage,
	loadPageSize,
	openPdfRanged,
	pageCount,
	pageSizePt,
	resetPdfEngineForTests
} from './index.js';

afterEach(() => resetPdfEngineForTests());

/**
 * A PDF shaped like a scanned book: each page carries a large stream (stand-in
 * for its scan) written right after it, so pages sit far apart in the file.
 */
async function makeBookPdf(pages: number, bulkPerPage = 256 * 1024): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	let seed = 1;
	for (let i = 0; i < pages; i++) {
		const page = doc.addPage([200 + i, 120 + i]);
		page.drawText(`Page ${i + 1}`, { x: 16, y: 60, size: 18, font, color: rgb(0, 0, 0) });
		const bulk = new Uint8Array(bulkPerPage);
		for (let b = 0; b < bulk.length; b++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			bulk[b] = seed >> 16;
		}
		page.node.set(PDFName.of('Bulk'), doc.context.register(doc.context.stream(bulk)));
	}
	return doc.save({ useObjectStreams: false });
}

function rangeSource(bytes: Uint8Array) {
	const asked: Array<[number, number]> = [];
	return {
		asked,
		source: {
			length: bytes.byteLength,
			async read(begin: number, end: number) {
				asked.push([begin, end]);
				return bytes.slice(begin, end);
			}
		}
	};
}

describe('openPdfRanged', () => {
	// pdf.js checks the last page on every open, which walks the page tree and
	// reads each page's dictionary: a ranged open costs about one chunk per
	// page. For a big file (scans, images) that is a small part of it.
	it('opens page 1 of a large PDF without reading most of the file', async () => {
		const bytes = await makeBookPdf(30);
		const { source, asked } = rangeSource(bytes);
		const handle = await openPdfRanged(source);
		try {
			expect(pageCount(handle)).toBe(30);
			expect(pageSizePt(handle, 0)).toEqual({ width: 200, height: 120 });
			const page = await interpretPage(handle, 0, { targetWidth: 400, targetHeight: 240 });
			expect(page.elements.some((e) => e.type === 'text' && e.str.includes('Page 1'))).toBe(true);
			const read = asked.reduce((n, [a, b]) => n + (b - a), 0);
			expect(read).toBeLessThan(bytes.byteLength / 2);
		} finally {
			destroy(handle);
		}
	});

	it('reads a later page size on demand', async () => {
		const bytes = await makeBookPdf(5, 1024);
		const { source } = rangeSource(bytes);
		const handle = await openPdfRanged(source);
		try {
			expect(() => pageSizePt(handle, 3)).toThrow(/loadPageSize/);
			expect(await loadPageSize(handle, 3)).toEqual({ width: 203, height: 123 });
			expect(pageSizePt(handle, 3)).toEqual({ width: 203, height: 123 });
		} finally {
			destroy(handle);
		}
	});
});
