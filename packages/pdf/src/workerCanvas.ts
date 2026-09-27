/**
 * pdf.js factories for a Web Worker. Its defaults reach for `document`
 * (DOMCanvasFactory creates `<canvas>`, DOMFilterFactory builds SVG filters),
 * so a worker renders with OffscreenCanvas and no SVG filters. pdf.js 6 does
 * not export its base classes; these match their duck-typed shape.
 */

type CanvasEntry = {
	canvas: OffscreenCanvas | null;
	context: OffscreenCanvasRenderingContext2D | null;
};

export function isWorkerScope(): boolean {
	return (
		typeof document === 'undefined' &&
		typeof OffscreenCanvas !== 'undefined' &&
		typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
	);
}

export class OffscreenCanvasFactory {
	constructor(_opts?: unknown) {}

	create(width: number, height: number): CanvasEntry {
		if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
		const canvas = new OffscreenCanvas(width, height);
		return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
	}

	reset(entry: CanvasEntry, width: number, height: number): void {
		if (!entry.canvas) throw new Error('Canvas is not specified');
		if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
		entry.canvas.width = width;
		entry.canvas.height = height;
	}

	destroy(entry: CanvasEntry): void {
		if (!entry.canvas) throw new Error('Canvas is not specified');
		entry.canvas.width = entry.canvas.height = 0;
		entry.canvas = null;
		entry.context = null;
	}
}

/**
 * Transfer functions and high-contrast modes are SVG filters on the main
 * thread; a worker has no DOM to hold them, so they are skipped. Rare in
 * page content, and a preview is still faithful without them.
 */
export class NoopFilterFactory {
	constructor(_opts?: unknown) {}
	addFilter(): string {
		return 'none';
	}
	addHCMFilter(): string {
		return 'none';
	}
	addAlphaFilter(): string {
		return 'none';
	}
	addLuminosityFilter(): string {
		return 'none';
	}
	addKnockoutFilter(): string {
		return 'none';
	}
	addHighlightHCMFilter(): string {
		return 'none';
	}
	addSelectionHCMFilter(): string {
		return 'none';
	}
	addSelectionFilter(): string {
		return 'none';
	}
	createSelectionStyle(): null {
		return null;
	}
	destroy(): void {}
}
