import type { Point } from './types.js';

/** Stage zoom while Fine tune is on — also scales down pointer travel. */
export const FINE_TUNE_ZOOM = 2.75;
/** Loupe diameter in CSS pixels. */
export const LOUPE_SIZE = 148;
/** How many source pixels the loupe shows across its diameter. */
export const LOUPE_SRC_PX = 64;

export function fineTuneZoom(enabled: boolean): number {
	return enabled ? FINE_TUNE_ZOOM : 1;
}

/**
 * Map a pointer in the stage box back to unzoomed overlay coordinates.
 * Fine-tune scales the view around `focus`, so 1px of finger is 1/zoom display px.
 */
export function stageToOverlay(
	stage: Point,
	focus: Point,
	stageSize: { w: number; h: number },
	zoom: number
): Point {
	if (zoom <= 1) return stage;
	return {
		x: (stage.x - stageSize.w / 2) / zoom + focus.x,
		y: (stage.y - stageSize.h / 2) / zoom + focus.y
	};
}

/** Overlay/display point → where it appears in the stage after fine-tune zoom. */
export function overlayToStage(
	display: Point,
	focus: Point,
	stageSize: { w: number; h: number },
	zoom: number
): Point {
	if (zoom <= 1) return display;
	return {
		x: stageSize.w / 2 + (display.x - focus.x) * zoom,
		y: stageSize.h / 2 + (display.y - focus.y) * zoom
	};
}

/** CSS transform that keeps `focus` in the middle of the stage. */
export function fineTuneTransform(
	focus: Point,
	stageSize: { w: number; h: number },
	zoom: number
): string {
	if (zoom <= 1) return 'none';
	const tx = stageSize.w / 2 - focus.x * zoom;
	const ty = stageSize.h / 2 - focus.y * zoom;
	return `translate(${tx}px, ${ty}px) scale(${zoom})`;
}

export function loupeImageOffset(
	img: Point,
	srcW: number,
	srcH: number,
	loupeSize = LOUPE_SIZE,
	srcWindow = LOUPE_SRC_PX
): { width: number; height: number; left: number; top: number; scale: number } {
	const scale = loupeSize / srcWindow;
	return {
		scale,
		width: srcW * scale,
		height: srcH * scale,
		left: loupeSize / 2 - img.x * scale,
		top: loupeSize / 2 - img.y * scale
	};
}

/** Sit the loupe above the handle, flipping below if it would clip the top. */
export function placeLoupe(
	handleStage: Point,
	stageSize: { w: number; h: number },
	loupeSize = LOUPE_SIZE,
	gap = 18
): Point {
	let x = handleStage.x - loupeSize / 2;
	let y = handleStage.y - loupeSize - gap;
	if (y < 8) y = handleStage.y + gap;
	x = Math.max(8, Math.min(stageSize.w - loupeSize - 8, x));
	y = Math.max(8, Math.min(stageSize.h - loupeSize - 8, y));
	return { x, y };
}
