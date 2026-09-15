/**
 * 2D stage pan/zoom — the same model the video player and sketcher zoom
 * bar use: fit / width / manual scale, plus a pan offset on top.
 */
export type ZoomMode = 'fit' | 'width' | 'manual';

export const PZ_ZOOM_MIN = 0.05;
export const PZ_ZOOM_MAX = 8;

export type Pan = { x: number; y: number };

export type CanvasView = {
	scale: number;
	offsetX: number;
	offsetY: number;
};

export function clampScale(s: number, min = PZ_ZOOM_MIN, max = PZ_ZOOM_MAX): number {
	if (!Number.isFinite(s)) return 1;
	return Math.min(max, Math.max(min, s));
}

export function fitScale(stageW: number, stageH: number, contentW: number, contentH: number): number {
	if (stageW <= 0 || stageH <= 0 || contentW <= 0 || contentH <= 0) return 1;
	return Math.min(stageW / contentW, stageH / contentH);
}

export function widthScale(stageW: number, contentW: number): number {
	if (stageW <= 0 || contentW <= 0) return 1;
	return stageW / contentW;
}

export function canvasView(opts: {
	mode: ZoomMode;
	manualScale: number;
	pan: Pan;
	stageW: number;
	stageH: number;
	contentW: number;
	contentH: number;
}): CanvasView {
	const fit = fitScale(opts.stageW, opts.stageH, opts.contentW, opts.contentH);
	const scale =
		opts.mode === 'width'
			? widthScale(opts.stageW, opts.contentW)
			: opts.mode === 'manual'
				? opts.manualScale
				: fit;
	return {
		scale,
		offsetX: (opts.stageW - opts.contentW * scale) / 2 + opts.pan.x,
		offsetY: (opts.stageH - opts.contentH * scale) / 2 + opts.pan.y
	};
}

/** Same wheel curve as the video / sketch stages. */
export function wheelZoomFactor(deltaY: number): number {
	return Math.pow(1.0015, -deltaY);
}

export function pointerDistance(
	a: { x: number; y: number },
	b: { x: number; y: number }
): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
