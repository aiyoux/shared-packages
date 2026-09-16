<script lang="ts">
	import {
		MAX_ZOOM,
		MIN_ZOOM,
		ZOOM_STEP,
		clampScrollX,
		createTimelineViewport,
		rulerTicks,
		zoomAtAnchor,
		zoomToFitDuration,
		zoomToTimeRange
	} from '@shared-packages/composition';
	import TimelineMinimap from '@shared-packages/ui/timeline/TimelineMinimap.svelte';
	import { createTimelinePan } from '@shared-packages/ui/timeline/pan';
	import { formatTimecode } from './time.js';
	import {
		BAR_HEIGHT,
		MIN_TRIM_SPAN,
		TICK_ROW_HEIGHT,
		clampTrimEnd,
		clampTrimStart,
		filmstripLayout,
		filmstripThumbWidth,
		frameCacheKey,
		slipRange
	} from './timelineScale.js';

	let {
		duration,
		currentTime,
		trimStart = $bindable(0),
		trimEnd = $bindable(0),
		videoRef = null as HTMLVideoElement | null,
		sourceUrl = null as string | null
	}: {
		duration: number;
		currentTime: number;
		trimStart?: number;
		trimEnd?: number;
		videoRef?: HTMLVideoElement | null;
		sourceUrl?: string | null;
	} = $props();

	let isDragging = $state<'start' | 'end' | 'slip' | null>(null);
	let timelineScrollRef = $state<HTMLDivElement | null>(null);
	let stripVideo = $state<HTMLVideoElement | null>(null);
	let zoom = $state(1);
	let scrollX = $state(0);
	let viewportPx = $state(0);
	let minimapOpen = $state(true);
	let fittedDurationMs = $state(-1);
	let isPanning = $state(false);
	let panStartX = $state(0);
	let panStartScroll = $state(0);
	let clickStartX = $state(0);
	let clickStartY = $state(0);
	let hasMoved = $state(false);
	let slipOrigin = $state({ t: 0, start: 0, end: 0 });
	let aspect = $state(16 / 9);
	let frameUrls = $state<Record<string, string>>({});

	const durationMs = $derived(Math.max(0, duration * 1000));
	const vp = $derived(createTimelineViewport({ durationMs, viewportPx, zoom, scrollX }));
	const ticks = $derived(rulerTicks(vp));
	const sourceSrc = $derived(sourceUrl || videoRef?.currentSrc || videoRef?.src || '');
	const keepSpan = $derived(Math.max(0, trimEnd - trimStart));
	const keepLeftPx = $derived(vp.timeToPx(trimStart * 1000));
	const keepRightPx = $derived(vp.timeToPx(trimEnd * 1000));
	const keepWidthPx = $derived(Math.max(0, keepRightPx - keepLeftPx));
	const playPx = $derived(vp.timeToPx(currentTime * 1000));
	const thumbW = $derived(Math.round(filmstripThumbWidth(BAR_HEIGHT, aspect)));
	const filmCells = $derived(
		filmstripLayout({
			duration,
			trackWidth: vp.contentPx,
			viewLeft: vp.scrollX,
			viewWidth: vp.viewportPx,
			thumbHeight: BAR_HEIGHT,
			aspect
		})
	);

	const frameCache = new Map<string, string>();
	const cacheOrder: string[] = [];
	let lastStripSrc = '';
	let seekRaf = 0;
	let pendingSeek = -1;

	const viewportPan = createTimelinePan({
		getSurface: () => timelineScrollRef,
		getViewport: () => vp,
		onScroll: (s) => (scrollX = s),
		onZoom: (z, s) => {
			zoom = z;
			scrollX = s;
		},
		zoomOnPlainWheel: () => true,
		shouldDragPan: () => false
	});

	function bindPan(node: HTMLElement) {
		node.addEventListener('wheel', viewportPan.onwheel, { passive: false });
		return {
			destroy() {
				node.removeEventListener('wheel', viewportPan.onwheel);
				viewportPan.destroy();
			}
		};
	}

	function rememberFrame(key: string, url: string) {
		if (frameCache.has(key)) return;
		frameCache.set(key, url);
		cacheOrder.push(key);
		while (cacheOrder.length > 160) {
			const drop = cacheOrder.shift();
			if (drop) frameCache.delete(drop);
		}
		frameUrls = { ...frameUrls, [key]: url };
	}

	function scrubPreview(t: number) {
		pendingSeek = t;
		if (seekRaf) return;
		seekRaf = requestAnimationFrame(() => {
			seekRaf = 0;
			if (videoRef && pendingSeek >= 0) videoRef.currentTime = pendingSeek;
		});
	}

	function flushScrub() {
		if (seekRaf) {
			cancelAnimationFrame(seekRaf);
			seekRaf = 0;
		}
		if (videoRef && pendingSeek >= 0) videoRef.currentTime = pendingSeek;
		pendingSeek = -1;
	}

	function getTimelineTimeFromEvent(e: PointerEvent | MouseEvent | TouchEvent): number {
		if (!timelineScrollRef || durationMs <= 0) return 0;
		const rect = timelineScrollRef.getBoundingClientRect();
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const x = clientX - rect.left;
		return Math.max(0, Math.min(duration, vp.pxToTime(vp.scrollX + x) / 1000));
	}

	function applyZoom(nextZoom: number, anchorX: number) {
		const next = zoomAtAnchor(vp, nextZoom, anchorX);
		zoom = next.zoom;
		scrollX = next.scrollX;
	}

	function zoomIn() {
		applyZoom(vp.zoom * ZOOM_STEP, viewportPx / 2);
	}

	function zoomOut() {
		applyZoom(vp.zoom / ZOOM_STEP, viewportPx / 2);
	}

	function zoomFit() {
		zoom = zoomToFitDuration(durationMs, viewportPx);
		scrollX = 0;
	}

	function zoomSelection() {
		const next = zoomToTimeRange(durationMs, viewportPx, trimStart * 1000, trimEnd * 1000);
		zoom = next.zoom;
		scrollX = next.scrollX;
	}

	function handlePointerDown(e: PointerEvent) {
		if (!timelineScrollRef || durationMs <= 0) return;
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		e.preventDefault();
		const kind = (e.target as HTMLElement | null)
			?.closest?.('[data-trim-handle]')
			?.getAttribute('data-trim-handle') as 'start' | 'end' | 'slip' | null;
		const t = getTimelineTimeFromEvent(e);
		if (kind === 'start' || kind === 'end') {
			isDragging = kind;
			scrubPreview(kind === 'start' ? trimStart : trimEnd);
		} else if (kind === 'slip') {
			isDragging = 'slip';
			slipOrigin = { t, start: trimStart, end: trimEnd };
		} else {
			isPanning = true;
			panStartX = e.clientX;
			panStartScroll = vp.scrollX;
			clickStartX = e.clientX;
			clickStartY = e.clientY;
			hasMoved = false;
		}
		try {
			timelineScrollRef.setPointerCapture(e.pointerId);
		} catch {
			/* capture is optional */
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (isDragging) {
			const t = getTimelineTimeFromEvent(e);
			if (isDragging === 'start') {
				trimStart = clampTrimStart(t, trimEnd, duration, MIN_TRIM_SPAN);
				scrubPreview(trimStart);
			} else if (isDragging === 'end') {
				trimEnd = clampTrimEnd(t, trimStart, duration, MIN_TRIM_SPAN);
				scrubPreview(trimEnd);
			} else {
				const next = slipRange(slipOrigin.start, slipOrigin.end, t - slipOrigin.t, duration);
				trimStart = next.start;
				trimEnd = next.end;
			}
		}
		if (isPanning) {
			const dx = Math.abs(e.clientX - clickStartX);
			const dy = Math.abs(e.clientY - clickStartY);
			if (dx > 3 || dy > 3) hasMoved = true;
			if (hasMoved) {
				scrollX = clampScrollX(vp, panStartScroll + (panStartX - e.clientX));
			}
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (isPanning && !hasMoved && videoRef) {
			const t = getTimelineTimeFromEvent(e);
			pendingSeek = Math.max(trimStart, Math.min(trimEnd, t));
		}
		if (isDragging === 'start') pendingSeek = trimStart;
		if (isDragging === 'end') pendingSeek = trimEnd;
		flushScrub();
		isDragging = null;
		isPanning = false;
		hasMoved = false;
	}

	function seekHidden(video: HTMLVideoElement, t: number): Promise<void> {
		const target = Math.max(0, Math.min(Math.max(0, duration - 0.001), t));
		if (Math.abs(video.currentTime - target) < 0.03) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				video.removeEventListener('seeked', done);
				resolve();
			};
			video.addEventListener('seeked', done);
			try {
				video.currentTime = target;
			} catch {
				video.removeEventListener('seeked', done);
				resolve();
			}
		});
	}

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
		const v = videoRef;
		if (!v) return;
		const apply = () => {
			if (v.videoWidth > 0 && v.videoHeight > 0) aspect = v.videoWidth / v.videoHeight;
		};
		apply();
		v.addEventListener('loadedmetadata', apply);
		return () => v.removeEventListener('loadedmetadata', apply);
	});

	$effect(() => {
		const el = timelineScrollRef;
		if (!el) return;
		const measure = () => (viewportPx = el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	$effect(() => {
		const src = sourceSrc;
		const video = stripVideo;
		const cells = filmCells;
		const w = thumbW;
		const h = BAR_HEIGHT;
		const busy = isDragging !== null || isPanning;
		if (src !== lastStripSrc) {
			frameCache.clear();
			cacheOrder.length = 0;
			frameUrls = {};
			lastStripSrc = src;
		}
		if (busy || !src || !video || !cells.length) return;
		let cancelled = false;
		const missing = cells.filter((c) => !frameCache.has(frameCacheKey(c.t, w, h)));
		if (!missing.length) return;
		const timer = setTimeout(() => {
			void (async () => {
				if (cancelled) return;
				if (video.getAttribute('src') !== src) {
					video.src = src;
					await new Promise<void>((resolve) => {
						if (video.readyState >= 1) {
							resolve();
							return;
						}
						const onMeta = () => {
							video.removeEventListener('loadedmetadata', onMeta);
							resolve();
						};
						video.addEventListener('loadedmetadata', onMeta);
					});
				}
				if (cancelled) return;
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (!ctx) return;
				for (const cell of missing) {
					if (cancelled) return;
					const key = frameCacheKey(cell.t, w, h);
					if (frameCache.has(key)) continue;
					try {
						await seekHidden(video, cell.t);
						if (cancelled) return;
						ctx.drawImage(video, 0, 0, w, h);
						rememberFrame(key, canvas.toDataURL('image/jpeg', 0.55));
					} catch {
						/* skip a cell if the decoder refuses the seek */
					}
				}
			})();
		}, frameCache.size === 0 ? 0 : 120);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			try {
				video.pause();
			} catch {
				/* ignore */
			}
		};
	});
</script>

<div class="timeline-section" data-testid="video-trim-timeline">
	<div class="timeline-toolbar">
		<div class="zoom-controls">
			<button
				type="button"
				class="zoom-btn"
				onclick={zoomOut}
				disabled={vp.zoom <= MIN_ZOOM}
				title="Zoom out"
				data-testid="video-trim-zoom-out"
			>
				-
			</button>
			<span class="zoom-level" data-testid="video-trim-zoom-level">{vp.zoom.toFixed(1)}x</span>
			<button
				type="button"
				class="zoom-btn"
				onclick={zoomIn}
				disabled={vp.zoom >= MAX_ZOOM}
				title="Zoom in"
				data-testid="video-trim-zoom-in"
			>
				+
			</button>
			<button type="button" class="zoom-btn" onclick={zoomFit} title="Fit to view" data-testid="video-trim-zoom-fit">
				Fit
			</button>
			<button
				type="button"
				class="zoom-btn"
				onclick={zoomSelection}
				title="Zoom to the kept range"
				data-testid="video-trim-zoom-selection"
			>
				Selection
			</button>
			<button
				type="button"
				class="zoom-btn"
				class:active={minimapOpen}
				onclick={() => (minimapOpen = !minimapOpen)}
				title={minimapOpen ? 'Hide minimap' : 'Show minimap'}
				aria-pressed={minimapOpen}
				data-testid="video-trim-zoom-minimap"
			>
				Map
			</button>
		</div>
		<span class="keep-length" data-testid="video-trim-keep-length">Keep {formatTimecode(keepSpan, true)}</span>
	</div>
	<div class="time-display">
		<span class="time-tag" data-testid="video-trim-in">{formatTimecode(trimStart, true)}</span>
		<span class="current-time" data-testid="video-trim-now">{formatTimecode(currentTime, true)}</span>
		<span class="time-tag" data-testid="video-trim-out">{formatTimecode(trimEnd, true)}</span>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="timeline-scroll"
		class:dragging={isDragging !== null}
		class:slipping={isDragging === 'slip'}
		bind:this={timelineScrollRef}
		use:bindPan
		style="height: {TICK_ROW_HEIGHT + BAR_HEIGHT}px"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
	>
		<div
			class="timeline-track"
			style="width: {Math.max(vp.contentPx, viewportPx)}px; transform: translateX({-vp.scrollX}px)"
		>
			<div class="tick-ruler" data-testid="video-trim-ticks" style="height: {TICK_ROW_HEIGHT}px">
				{#each ticks as tick (tick.ms)}
					<div class="tick major" data-tick="major" style="left: {tick.x}px"></div>
				{/each}
			</div>
			<div class="film-bar" data-testid="video-trim-filmstrip" style="height: {BAR_HEIGHT}px">
				{#each filmCells as cell (frameCacheKey(cell.t, thumbW, BAR_HEIGHT))}
					{@const url = frameUrls[frameCacheKey(cell.t, thumbW, BAR_HEIGHT)]}
					{#if url}
						<img
							class="film-cell"
							src={url}
							alt=""
							draggable="false"
							style="left: {cell.left * 100}%; width: {cell.width * 100}%"
						/>
					{/if}
				{/each}
				<div class="veil left" style="width: {keepLeftPx}px"></div>
				<div
					class="veil right"
					style="left: {keepRightPx}px; width: {Math.max(0, vp.contentPx - keepRightPx)}px"
				></div>
				<div
					class="keep"
					data-testid="video-trim-keep"
					data-trim-handle="slip"
					style="left: {keepLeftPx}px; width: {keepWidthPx}px"
					title="Drag to slide the kept range"
				></div>
			</div>
			<div
				class="handle start"
				data-testid="video-trim-handle-start"
				data-trim-handle="start"
				role="slider"
				aria-label="Trim start"
				aria-valuemin={0}
				aria-valuemax={trimEnd}
				aria-valuenow={trimStart}
				tabindex="0"
				style="left: {keepLeftPx}px"
			></div>
			<div
				class="handle end"
				data-testid="video-trim-handle-end"
				data-trim-handle="end"
				role="slider"
				aria-label="Trim end"
				aria-valuemin={trimStart}
				aria-valuemax={duration}
				aria-valuenow={trimEnd}
				tabindex="0"
				style="left: {keepRightPx}px"
			></div>
			{#if durationMs > 0}
				<div class="playhead" style="left: {playPx}px"></div>
			{/if}
		</div>
	</div>
	{#if minimapOpen && durationMs > 0 && viewportPx > 0}
		<div class="minimap-slot">
			<TimelineMinimap
				{durationMs}
				{viewportPx}
				zoom={vp.zoom}
				scrollX={vp.scrollX}
				playheadMs={currentTime * 1000}
				height={32}
				testid="video-trim-minimap"
				onScroll={(s) => (scrollX = s)}
			>
				{#snippet content({ toX })}
					<span
						class="mm-keep"
						style="left:{toX(trimStart * 1000)}px;width:{Math.max(
							2,
							toX(trimEnd * 1000) - toX(trimStart * 1000)
						)}px"
					></span>
				{/snippet}
			</TimelineMinimap>
		</div>
	{/if}
	<p class="timeline-hint">Drag the box to slide · handles to trim · click to seek · scroll to zoom</p>
	<video
		bind:this={stripVideo}
		class="strip-video"
		muted
		playsinline
		preload="metadata"
		aria-hidden="true"
	></video>
</div>

<style>
	.timeline-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.time-display {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
		font-family: monospace;
		color: var(--text-secondary);
	}

	.time-tag {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 2px 8px;
		font-size: 0.8rem;
		font-weight: 600;
	}

	.current-time {
		color: var(--accent-light);
	}

	.timeline-track {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-width: 100%;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		touch-action: none;
		will-change: transform;
	}

	.timeline-scroll {
		position: relative;
		border-radius: var(--radius-md);
		overflow: hidden;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		touch-action: none;
		background: var(--surface-2, rgb(0 0 0 / 0.35));
		border: 1px solid var(--line-hairline, var(--border));
	}

	.timeline-scroll.dragging {
		cursor: ew-resize;
	}

	.timeline-scroll.slipping {
		cursor: grabbing;
	}

	.timeline-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.zoom-controls {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
	}

	.keep-length {
		font-size: 0.75rem;
		font-family: monospace;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.zoom-btn {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 2px 8px;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-family: inherit;
		cursor: pointer;
		transition: all var(--transition-fast) var(--ease-default);
	}

	.zoom-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.1);
		border-color: var(--accent);
		color: var(--text-primary);
	}

	.zoom-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.zoom-btn.active {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	.zoom-level {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-family: monospace;
		min-width: 36px;
		text-align: center;
	}

	.tick-ruler {
		position: relative;
		flex: 0 0 auto;
		width: 100%;
		background: rgb(2 6 15 / 0.92);
		border-bottom: 1px solid var(--line-hairline, var(--border));
		overflow: hidden;
		z-index: 1;
	}

	.tick {
		position: absolute;
		top: 8px;
		bottom: 0;
		width: 1px;
		background: rgb(255 255 255 / 0.22);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.tick.major {
		top: 4px;
		background: rgb(255 255 255 / 0.55);
	}

	.film-bar {
		position: relative;
		flex: 1 1 auto;
		width: 100%;
		overflow: hidden;
		background: rgb(0 0 0 / 0.45);
	}

	.film-cell {
		position: absolute;
		top: 0;
		height: 100%;
		object-fit: cover;
		pointer-events: none;
		user-select: none;
	}

	.veil {
		position: absolute;
		top: 0;
		height: 100%;
		background: rgb(0 0 0 / 0.55);
		pointer-events: none;
		z-index: 1;
	}

	.veil.left {
		left: 0;
	}

	.keep {
		position: absolute;
		top: 0;
		height: 100%;
		box-sizing: border-box;
		border: 2px solid rgb(255 255 255 / 0.88);
		background: rgb(255 255 255 / 0.06);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.45);
		cursor: grab;
		z-index: 2;
		pointer-events: auto;
	}

	.keep:active {
		cursor: grabbing;
	}

	.handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 22px;
		cursor: ew-resize;
		z-index: 6;
		touch-action: none;
	}

	.handle.start {
		transform: none;
	}

	.handle.end {
		transform: translateX(-100%);
	}

	.handle::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 5px;
		background: rgb(255 255 255 / 0.96);
		border-radius: 1px;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.55);
	}

	.handle.start::before {
		left: 0;
	}

	.handle.end::before {
		right: 0;
	}

	.handle::after {
		content: '';
		position: absolute;
		top: 1px;
		width: 14px;
		height: 14px;
		background: rgb(255 255 255 / 0.96);
		border-radius: 2px;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.55);
	}

	.handle.start::after {
		left: 0;
	}

	.handle.end::after {
		right: 0;
	}

	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--accent-light);
		transform: translateX(-50%);
		pointer-events: none;
		z-index: 4;
		box-shadow: 0 0 6px var(--accent-glow);
	}

	.playhead::before {
		content: '';
		position: absolute;
		top: 0;
		left: 50%;
		transform: translateX(-50%);
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-top: 6px solid var(--accent-light);
	}

	.minimap-slot {
		border-radius: var(--radius-md);
		overflow: hidden;
		border: 1px solid var(--line-hairline, var(--border));
		--tl-minimap-bg: rgb(0 0 0 / 0.35);
		--tl-minimap-window-fill: var(--accent, #38bdf8);
		--tl-minimap-window-border: var(--accent, #38bdf8);
		--tl-playhead-color: var(--accent-light, #7dd3fc);
	}

	.mm-keep {
		position: absolute;
		top: 22%;
		height: 56%;
		border-radius: 1px;
		background: rgb(255 255 255 / 0.35);
	}

	.timeline-hint {
		text-align: center;
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	.strip-video {
		position: absolute;
		width: 2px;
		height: 2px;
		opacity: 0.01;
		pointer-events: none;
		overflow: hidden;
	}
</style>
