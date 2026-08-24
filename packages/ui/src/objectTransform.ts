/**
 * Shared 2D frame transform for canvas objects (temp bakes, stickers, images).
 * Modes: 'all' = move+resize+rotate, 'resize' = move+resize, 'rotate' = rotate only.
 * Pass allowMove={false} to hide the move hit (sketcher resize-lock).
 */

export type TransformMode = 'all' | 'resize' | 'rotate';

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export type FrameRect = { x: number; y: number; width: number; height: number };

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
	'nw',
	'n',
	'ne',
	'e',
	'se',
	's',
	'sw',
	'w'
];

export const RESIZE_HANDLE_LABELS: Record<ResizeHandle, string> = {
	nw: 'Resize from northwest corner',
	n: 'Resize from top edge',
	ne: 'Resize from northeast corner',
	e: 'Resize from right edge',
	se: 'Resize from southeast corner',
	s: 'Resize from bottom edge',
	sw: 'Resize from southwest corner',
	w: 'Resize from left edge'
};

export const RESIZE_HANDLE_CURSORS: Record<ResizeHandle, string> = {
	nw: 'nwse-resize',
	n: 'ns-resize',
	ne: 'nesw-resize',
	w: 'ew-resize',
	e: 'ew-resize',
	sw: 'nesw-resize',
	s: 'ns-resize',
	se: 'nwse-resize'
};

export const MIN_SIZE = 30;

export function applyFrameResize(
	base: FrameRect,
	handle: ResizeHandle,
	dx: number,
	dy: number,
	minSize = MIN_SIZE
): FrameRect {
	let x = base.x;
	let y = base.y;
	let width = base.width;
	let height = base.height;

	if (handle.includes('e')) width = Math.max(minSize, base.width + dx);
	if (handle.includes('s')) height = Math.max(minSize, base.height + dy);
	if (handle.includes('w')) {
		const cappedDx = Math.min(dx, base.width - minSize);
		width = base.width - cappedDx;
		x = base.x + cappedDx;
	}
	if (handle.includes('n')) {
		const cappedDy = Math.min(dy, base.height - minSize);
		height = base.height - cappedDy;
		y = base.y + cappedDy;
	}

	return { x, y, width, height };
}

export function frameCenter(box: FrameRect): { x: number; y: number } {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function nextRotation(startRotation: number, startAngle: number, currentAngle: number): number {
	return startRotation + (currentAngle - startAngle);
}

export function rotationCss(rotation: number | undefined): string {
	if (!rotation) return '';
	return `rotate(${rotation}rad)`;
}

export function rotationSvg(box: FrameRect, rotation: number | undefined): string | undefined {
	if (!rotation) return undefined;
	const c = frameCenter(box);
	return `rotate(${(rotation * 180) / Math.PI} ${c.x} ${c.y})`;
}

export function showMoveHit(mode: TransformMode, allowMove: boolean): boolean {
	return allowMove && mode !== 'rotate';
}

export function showRotateHandle(mode: TransformMode): boolean {
	return mode !== 'resize';
}

export function showResizeHandles(mode: TransformMode): boolean {
	return mode !== 'rotate';
}
