/**
 * DOM glue for panning and zooming a timeline viewport — the wheel / drag /
 * pinch gestures, with the maths delegated to `@shared-packages/composition`.
 *
 * Stateless about the viewport itself: the host owns `zoom` + `scrollX`, exposes
 * the resolved {@link TimelineViewport} through `getViewport`, and commits
 * changes via the `onScroll` / `onZoom` callbacks. Bind the returned handlers to
 * the scroll surface (`onwheel`, `onpointerdown`) and call `destroy` on teardown.
 */
import {
	clampScrollX,
	zoomAtAnchor,
	type TimelineViewport
} from '@shared-packages/composition';

export interface TimelinePanContext {
	/** The scrolling surface — its left edge is the origin for zoom anchoring. */
	getSurface: () => HTMLElement | null | undefined;
	/** The viewport as currently resolved by the host. */
	getViewport: () => TimelineViewport;
	/** Commit a horizontal pan (already-clamped scrollX in content pixels). */
	onScroll: (scrollX: number) => void;
	/** Commit a zoom together with the scrollX that keeps the anchor pinned. */
	onZoom: (zoom: number, scrollX: number) => void;
	/**
	 * Whether a pointerdown should start a drag-pan. Default: middle button only,
	 * so left-click still reaches clips / the scrubber underneath.
	 */
	shouldDragPan?: (e: PointerEvent) => boolean;
	/** Zoom on a plain (no-modifier) wheel too. Default: only Ctrl/Cmd zooms. */
	zoomOnPlainWheel?: () => boolean;
}

export interface TimelinePanHandlers {
	onwheel: (e: WheelEvent) => void;
	onpointerdown: (e: PointerEvent) => void;
	destroy: () => void;
}

/** Trackpad pinch and mouse wheel arrive with wildly different deltas; this
 *  exponential mapping keeps both feeling proportional. */
const WHEEL_ZOOM_SENSITIVITY = 0.0018;

export function createTimelinePan(ctx: TimelinePanContext): TimelinePanHandlers {
	let drag: { pointerId: number; startClientX: number; startScrollX: number } | null = null;
	const pointers = new Map<number, number>(); // id -> clientX, for pinch
	let pinch: { startGap: number; startZoom: number } | null = null;

	const surfaceLeft = () => ctx.getSurface()?.getBoundingClientRect().left ?? 0;
	const anchorFor = (clientX: number) => clientX - surfaceLeft();

	function commitZoom(nextZoom: number, anchorPx: number) {
		const vp = ctx.getViewport();
		const next = zoomAtAnchor(vp, nextZoom, anchorPx);
		if (next.zoom !== vp.zoom || next.scrollX !== vp.scrollX) ctx.onZoom(next.zoom, next.scrollX);
	}

	function onwheel(e: WheelEvent) {
		const vp = ctx.getViewport();
		const zoomGesture = e.ctrlKey || e.metaKey || (ctx.zoomOnPlainWheel?.() ?? false);
		if (zoomGesture) {
			e.preventDefault();
			const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
			commitZoom(vp.zoom * factor, anchorFor(e.clientX));
			return;
		}
		if (vp.maxScrollX <= 0) return;
		e.preventDefault();
		// Shift-wheel and horizontal trackpad gestures both mean "scroll sideways".
		const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		ctx.onScroll(clampScrollX(vp, vp.scrollX + delta));
	}

	function onpointermove(e: PointerEvent) {
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX);

		if (pinch && pointers.size >= 2) {
			const [a, b] = [...pointers.values()];
			const gap = Math.abs(a - b);
			if (pinch.startGap > 0) {
				const mid = (a + b) / 2 - surfaceLeft();
				commitZoom(pinch.startZoom * (gap / pinch.startGap), mid);
			}
			return;
		}

		if (!drag) return;
		const vp = ctx.getViewport();
		const moved = drag.startClientX - e.clientX;
		ctx.onScroll(clampScrollX(vp, drag.startScrollX + moved));
	}

	function endPointer(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (drag && drag.pointerId === e.pointerId) {
			ctx.getSurface()?.releasePointerCapture?.(drag.pointerId);
			drag = null;
		}
		if (pointers.size === 0) {
			window.removeEventListener('pointermove', onpointermove);
			window.removeEventListener('pointerup', endPointer);
			window.removeEventListener('pointercancel', endPointer);
		}
	}

	function onpointerdown(e: PointerEvent) {
		pointers.set(e.pointerId, e.clientX);
		window.addEventListener('pointermove', onpointermove);
		window.addEventListener('pointerup', endPointer);
		window.addEventListener('pointercancel', endPointer);

		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = { startGap: Math.abs(a - b), startZoom: ctx.getViewport().zoom };
			drag = null;
			return;
		}

		const wantsPan = ctx.shouldDragPan ? ctx.shouldDragPan(e) : e.button === 1;
		if (!wantsPan) return;
		e.preventDefault();
		drag = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			startScrollX: ctx.getViewport().scrollX
		};
		ctx.getSurface()?.setPointerCapture?.(e.pointerId);
	}

	function destroy() {
		window.removeEventListener('pointermove', onpointermove);
		window.removeEventListener('pointerup', endPointer);
		window.removeEventListener('pointercancel', endPointer);
		pointers.clear();
		drag = null;
		pinch = null;
	}

	return { onwheel, onpointerdown, destroy };
}
