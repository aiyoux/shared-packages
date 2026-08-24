import type { PdfPageFit } from './types.js';

export const PDF_PAGE_DIM_MIN = 100;
export const PDF_PAGE_DIM_MAX = 10000;
export const PDF_FILE_SIZE_WARN_BYTES = 50 * 1024 * 1024;
export const PDF_PAGE_COUNT_WARN = 100;

/**
 * Clamps a PDF page dimension to a safe range, falling back when the value is
 * missing, non-finite, or out of bounds.
 */
export function clampPageDimension(value: number, fallback: number): number {
	if (!Number.isFinite(value) || value < PDF_PAGE_DIM_MIN || value > PDF_PAGE_DIM_MAX) {
		return fallback;
	}
	return value;
}

/**
 * Parses page ranges like "1-3, 5, 8-10" or "all" into zero-indexed indices.
 * Empty / "all" returns every page. Invalid/unparseable input returns [].
 */
export function parsePageRange(rangeStr: string, pageCount: number): number[] {
	if (!rangeStr || !rangeStr.trim() || rangeStr.trim().toLowerCase() === 'all') {
		return Array.from({ length: pageCount }, (_, i) => i);
	}

	const indices = new Set<number>();
	const parts = rangeStr.split(',');

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		if (trimmed.includes('-')) {
			const [startStr, endStr] = trimmed.split('-');
			const start = parseInt(startStr, 10);
			const end = parseInt(endStr, 10);
			if (!isNaN(start) && !isNaN(end)) {
				const low = Math.max(1, Math.min(start, end));
				const high = Math.min(pageCount, Math.max(start, end));
				for (let p = low; p <= high; p++) {
					indices.add(p - 1);
				}
			}
		} else {
			const pageNum = parseInt(trimmed, 10);
			if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= pageCount) {
				indices.add(pageNum - 1);
			}
		}
	}

	return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Fits PDF page dimensions (points) onto a target, preserving aspect ratio.
 */
export function calculatePageFit(
	pageWidthPt: number,
	pageHeightPt: number,
	targetWidth: number,
	targetHeight: number
): PdfPageFit {
	if (
		!Number.isFinite(pageWidthPt) ||
		!Number.isFinite(pageHeightPt) ||
		pageWidthPt <= 0 ||
		pageHeightPt <= 0 ||
		!Number.isFinite(targetWidth) ||
		!Number.isFinite(targetHeight) ||
		targetWidth <= 0 ||
		targetHeight <= 0
	) {
		return { width: targetWidth, height: targetHeight, x: 0, y: 0, scale: 1 };
	}
	const scale = Math.min(targetWidth / pageWidthPt, targetHeight / pageHeightPt);
	const width = pageWidthPt * scale;
	const height = pageHeightPt * scale;
	const x = (targetWidth - width) / 2;
	const y = (targetHeight - height) / 2;
	return { width, height, x, y, scale };
}
