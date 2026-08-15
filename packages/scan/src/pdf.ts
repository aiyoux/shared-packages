import type { ScanPage } from './types.js';

/** Build a multi-page PDF. pdf-lib is imported only when exporting. */
export async function pagesToPdf(pages: readonly ScanPage[]): Promise<Blob> {
	if (!pages.length) throw new Error('No pages to export.');
	const { PDFDocument } = await import('pdf-lib');
	const pdf = await PDFDocument.create();
	for (const page of pages) {
		const bytes = new Uint8Array(await page.blob.arrayBuffer());
		const jpg = page.blob.type.includes('png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
		const sheet = pdf.addPage([jpg.width, jpg.height]);
		sheet.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
	}
	const out = await pdf.save();
	const copy = new Uint8Array(out.byteLength);
	copy.set(out);
	return new Blob([copy], { type: 'application/pdf' });
}
