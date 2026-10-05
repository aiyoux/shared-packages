/**
 * The interactive core both trim timelines share: the video one here and the
 * hub's audio one. Viewport (zoom, scroll, fit), the drag state machine
 * (start/end handles, slip, playhead scrub, Alt-drag pan), keyboard nudges,
 * playhead-to-edge buttons and the scrub preview throttle.
 *
 * Markup, CSS, test ids and what the bar draws (a waveform, a filmstrip)
 * stay in each component. Call during component init: it registers effects.
 */
import {
	ZOOM_STEP,
	clampScrollX,
	createTimelineViewport,
	rulerTicks,
	zoomAtAnchor,
	zoomToFitDuration,
	zoomToTimeRange
} from '@shared-packages/composition';
import { createTimelinePan } from '@shared-packages/ui/timeline/pan';
import {
	MIN_TRIM_SPAN,
	clampTrimEnd,
	clampTrimStart,
	playheadNear,
	setTrimFromPlayhead,
	slipRange
} from './timelineScale.js';

/** Scrub previews seek the media at most this often while dragging. */
const PREVIEW_MS = 80;
/** Keyboard nudge per press (one frame at 30 fps); Shift jumps a second. */
const KEY_STEP_S = 1 / 30;
const KEY_SHIFT_STEP_S = 1;

export type TrimDrag = 'start' | 'end' | 'slip' | 'playhead';

export type TrimTimelineConfig = {
	duration(): number;
	currentTime(): number;
	trimStart(): number;
	trimEnd(): number;
	setTrim(start: number, end: number): void;
	/** The element whose time the scrubber previews. */
	media(): HTMLMediaElement | null;
	/** The box time maps across: its width is the viewport, its left edge is
	 *  where the visible range starts. Pointer maths, measuring and the wheel
	 *  anchor all use it. */
	view(): HTMLElement | null;
	/** The element that takes pointer capture during a drag. */
	capture(): HTMLElement | null;
	/** Told of each committed and previewed seek, after the media seeks. */
	onSeek?: (t: number) => void;
};

export function createTrimTimeline(cfg: TrimTimelineConfig) {
	let isDragging = $state<TrimDrag | null>(null);
	let isPanning = $state(false);
	let zoom = $state(1);
	let scrollX = $state(0);
	let viewportPx = $state(0);
	let fittedDurationMs = $state(-1);
	let headTime = $state<number | null>(null);
	let panStart = { x: 0, scroll: 0, clickX: 0, clickY: 0 };
	let hasMoved = false;
	let slipOrigin = { t: 0, start: 0, end: 0 };
	let dragOrigin = { left: 0, scrollX: 0 };
	let lastPreviewAt = 0;
	let pendingSeek = -1;

	const durationMs = $derived(Math.max(0, cfg.duration() * 1000));
	const vp = $derived(createTimelineViewport({ durationMs, viewportPx, zoom, scrollX }));
	const ticks = $derived(rulerTicks(vp));
	const displayTime = $derived(headTime ?? cfg.currentTime());
	const keepLeftPx = $derived(vp.timeToPx(cfg.trimStart() * 1000));
	const keepRightPx = $derived(vp.timeToPx(cfg.trimEnd() * 1000));

	const viewportPan = createTimelinePan({
		getSurface: () => cfg.view(),
		getViewport: () => vp,
		onScroll: (s) => (scrollX = s),
		onZoom: (z, s) => {
			zoom = z;
			scrollX = s;
		},
		zoomOnPlainWheel: () => true,
		shouldDragPan: () => false
	});

	function seekMedia(t: number): void {
		const media = cfg.media();
		if (media) {
			try {
				media.currentTime = t;
			} catch {
				/* a refused seek resolves on the next tick */
			}
		}
		cfg.onSeek?.(t);
	}

	function scrubPreview(t: number): void {
		const next = Math.max(0, Math.min(cfg.duration(), t));
		headTime = next;
		pendingSeek = next;
		// Let an in-flight seek decode its frame before replacing it, as the
		// preview player does; the release flush (or the next tick) applies
		// the latest position.
		if (cfg.media()?.seeking) return;
		const now = performance.now();
		if (now - lastPreviewAt < PREVIEW_MS) return;
		lastPreviewAt = now;
		seekMedia(next);
	}

	function flushScrub(): void {
		if (pendingSeek >= 0) seekMedia(pendingSeek);
		lastPreviewAt = 0;
		pendingSeek = -1;
	}

	function timeAt(e: PointerEvent | MouseEvent | TouchEvent): number {
		if (durationMs <= 0) return 0;
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		return Math.max(0, Math.min(cfg.duration(), vp.pxToTime(dragOrigin.scrollX + clientX - dragOrigin.left) / 1000));
	}

	function setEdges(next: { start: number; end: number }): void {
		cfg.setTrim(next.start, next.end);
	}

	function moveStart(t: number): void {
		const start = clampTrimStart(t, cfg.trimEnd(), cfg.duration(), MIN_TRIM_SPAN);
		cfg.setTrim(start, cfg.trimEnd());
		scrubPreview(start);
	}

	function moveEnd(t: number): void {
		const end = clampTrimEnd(t, cfg.trimStart(), cfg.duration(), MIN_TRIM_SPAN);
		cfg.setTrim(cfg.trimStart(), end);
		scrubPreview(end);
	}

	function applyZoom(nextZoom: number, anchorX: number): void {
		const next = zoomAtAnchor(vp, nextZoom, anchorX);
		zoom = next.zoom;
		scrollX = next.scrollX;
	}

	$effect(() => {
		if (headTime == null || isDragging === 'playhead' || isDragging === 'start' || isDragging === 'end') return;
		if (Math.abs(cfg.currentTime() - headTime) < 0.05) headTime = null;
	});

	$effect(() => {
		if (vp.scrollX !== scrollX) scrollX = vp.scrollX;
		if (vp.zoom !== zoom) zoom = vp.zoom;
	});

	$effect(() => {
		const d = durationMs;
		const w = viewportPx;
		if (d > 0 && w > 0 && d !== fittedDurationMs) {
			fittedDurationMs = d;
			zoom = zoomToFitDuration(d, w);
			scrollX = 0;
		}
	});

	$effect(() => {
		const el = cfg.view();
		if (!el) return;
		const measure = () => (viewportPx = el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	return {
		get isDragging() { return isDragging; },
		get isPanning() { return isPanning; },
		get zoom() { return zoom; },
		set zoom(v: number) { zoom = v; },
		get scrollX() { return scrollX; },
		set scrollX(v: number) { scrollX = v; },
		get viewportPx() { return viewportPx; },
		get vp() { return vp; },
		get ticks() { return ticks; },
		get displayTime() { return displayTime; },
		get keepSpan() { return Math.max(0, cfg.trimEnd() - cfg.trimStart()); },
		get keepLeftPx() { return keepLeftPx; },
		get keepRightPx() { return keepRightPx; },
		get keepWidthPx() { return Math.max(0, keepRightPx - keepLeftPx); },
		get playPx() { return vp.timeToPx(displayTime * 1000); },
		get playheadOffHandles() {
			return !playheadNear(displayTime, cfg.trimStart()) && !playheadNear(displayTime, cfg.trimEnd());
		},
		get atClipStart() { return playheadNear(displayTime, 0); },
		get atClipEnd() { return cfg.duration() > 0 && playheadNear(displayTime, cfg.duration()); },

		/** `use:` action: wheel zoom/pan on the timeline. */
		bindPan(node: HTMLElement) {
			node.addEventListener('wheel', viewportPan.onwheel, { passive: false });
			return {
				destroy() {
					node.removeEventListener('wheel', viewportPan.onwheel);
					viewportPan.destroy();
				}
			};
		},
		zoomIn() { applyZoom(vp.zoom * ZOOM_STEP, viewportPx / 2); },
		zoomOut() { applyZoom(vp.zoom / ZOOM_STEP, viewportPx / 2); },
		zoomFit() {
			zoom = zoomToFitDuration(durationMs, viewportPx);
			scrollX = 0;
		},
		zoomSelection() {
			const next = zoomToTimeRange(durationMs, viewportPx, cfg.trimStart() * 1000, cfg.trimEnd() * 1000);
			zoom = next.zoom;
			scrollX = next.scrollX;
		},
		setPlayheadAsStart() {
			setEdges(setTrimFromPlayhead('start', displayTime, cfg.trimStart(), cfg.trimEnd(), cfg.duration()));
		},
		setPlayheadAsEnd() {
			setEdges(setTrimFromPlayhead('end', displayTime, cfg.trimStart(), cfg.trimEnd(), cfg.duration()));
		},
		/** Arrow keys on a focused handle nudge it a frame; Shift a second. */
		nudgeTrim(which: 'start' | 'end', e: KeyboardEvent) {
			const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
			if (dir === 0) return;
			e.preventDefault();
			const step = (e.shiftKey ? KEY_SHIFT_STEP_S : KEY_STEP_S) * dir;
			if (which === 'start') moveStart(cfg.trimStart() + step);
			else moveEnd(cfg.trimEnd() + step);
		},
		handlePointerDown(e: PointerEvent) {
			const view = cfg.view();
			const capture = cfg.capture();
			if (!view || !capture || durationMs <= 0) return;
			if (e.button !== 0 && e.pointerType === 'mouse') return;
			e.preventDefault();
			dragOrigin = { left: view.getBoundingClientRect().left, scrollX: vp.scrollX };
			const kind = (e.target as HTMLElement | null)
				?.closest?.('[data-trim-handle]')
				?.getAttribute('data-trim-handle') as TrimDrag | null;
			const t = timeAt(e);
			if (kind === 'start' || kind === 'end') {
				isDragging = kind;
				scrubPreview(kind === 'start' ? cfg.trimStart() : cfg.trimEnd());
			} else if (kind === 'slip') {
				isDragging = 'slip';
				slipOrigin = { t, start: cfg.trimStart(), end: cfg.trimEnd() };
			} else if (kind !== 'playhead' && e.altKey) {
				isPanning = true;
				panStart = { x: e.clientX, scroll: vp.scrollX, clickX: e.clientX, clickY: e.clientY };
				hasMoved = false;
			} else {
				isDragging = 'playhead';
				scrubPreview(t);
			}
			try {
				capture.setPointerCapture(e.pointerId);
			} catch {
				/* capture is optional */
			}
		},
		handlePointerMove(e: PointerEvent) {
			if (isDragging) {
				const t = timeAt(e);
				if (isDragging === 'start') moveStart(t);
				else if (isDragging === 'end') moveEnd(t);
				else if (isDragging === 'playhead') scrubPreview(t);
				else setEdges(slipRange(slipOrigin.start, slipOrigin.end, t - slipOrigin.t, cfg.duration()));
			}
			if (isPanning) {
				if (Math.abs(e.clientX - panStart.clickX) > 3 || Math.abs(e.clientY - panStart.clickY) > 3) hasMoved = true;
				if (hasMoved) scrollX = clampScrollX(vp, panStart.scroll + (panStart.x - e.clientX));
			}
		},
		handlePointerUp(e: PointerEvent) {
			// An Alt-click that never moved is a seek, not a pan.
			if (isPanning && !hasMoved && cfg.media()) pendingSeek = timeAt(e);
			if (isDragging === 'start') pendingSeek = cfg.trimStart();
			if (isDragging === 'end') pendingSeek = cfg.trimEnd();
			if (isDragging === 'playhead') pendingSeek = timeAt(e);
			flushScrub();
			isDragging = null;
			isPanning = false;
			hasMoved = false;
		}
	};
}

export type TrimTimeline = ReturnType<typeof createTrimTimeline>;
