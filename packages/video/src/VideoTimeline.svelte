<script lang="ts">
	import { formatTimecode } from './time.js';
	import {
		BAR_HEIGHT,
		MAX_ZOOM,
		MIN_TRIM_SPAN,
		MIN_ZOOM,
		TICK_ROW_HEIGHT,
		clampTrimEnd,
		clampTrimStart,
		filmstripLayout,
		filmstripThumbWidth,
		frameCacheKey,
		pxPerSecond,
		slipRange,
		timelineTicks,
		zoomToRange
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
	let timelineTrackRef = $state<HTMLDivElement | null>(null);
	let stripVideo = $state<HTMLVideoElement | null>(null);
	let zoom = $state(MIN_ZOOM);
	let isPanning = $state(false);
	let panStartX = $state(0);
	let panStartScroll = $state(0);
	let clickStartX = $state(0);
	let clickStartY = $state(0);
	let hasMoved = $state(false);
	let slipOrigin = $state({ t: 0, start: 0, end: 0 });
	let viewWidth = $state(0);
	let trackWidthPx = $state(0);
	let scrollLeft = $state(0);
	let aspect = $state(16 / 9);
	let frameUrls = $state<Record<string, string>>({});

	const sourceSrc = $derived(sourceUrl || videoRef?.currentSrc || videoRef?.src || '');
	const keepSpan = $derived(Math.max(0, trimEnd - trimStart));
	const startPct = $derived(duration > 0 ? (trimStart / duration) * 100 : 0);
	const endPct = $derived(duration > 0 ? (trimEnd / duration) * 100 : 0);
	const keepPct = $derived(Math.max(0, endPct - startPct));
	const playPct = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);
	const thumbW = $derived(Math.round(filmstripThumbWidth(BAR_HEIGHT, aspect)));
	const ticks = $derived(timelineTicks(duration, pxPerSecond(duration, trackWidthPx)));
	const filmCells = $derived(
		filmstripLayout({
			duration,
			trackWidth: trackWidthPx,
			viewLeft: scrollLeft,
			viewWidth,
			thumbHeight: BAR_HEIGHT,
			aspect
		})
	);

	const frameCache = new Map<string, string>();
	const cacheOrder: string[] = [];
	let lastStripSrc = '';

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

	function getTimelineTimeFromEvent(e: PointerEvent | MouseEvent | TouchEvent): number {
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) return 0;
		const rect = timelineScrollRef.getBoundingClientRect();
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const x = clientX - rect.left;
		const sl = timelineScrollRef.scrollLeft;
		const trackWidth = timelineTrackRef.offsetWidth;
		return Math.max(0, Math.min(duration, ((sl + x) / trackWidth) * duration));
	}

	function applyZoom(newZoom: number, anchorX: number) {
		const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) {
			zoom = next;
			return;
		}
		if (next === zoom) return;
		const sl = timelineScrollRef.scrollLeft;
		const trackWidth = timelineTrackRef.offsetWidth;
		const timeUnderCursor = ((sl + anchorX) / trackWidth) * duration;
		zoom = next;
		requestAnimationFrame(() => {
			if (!timelineScrollRef || !timelineTrackRef) return;
			const newTrackWidth = timelineTrackRef.offsetWidth;
			trackWidthPx = newTrackWidth;
			timelineScrollRef.scrollLeft = Math.max(0, (timeUnderCursor / duration) * newTrackWidth - anchorX);
			scrollLeft = timelineScrollRef.scrollLeft;
		});
	}

	function zoomIn() {
		applyZoom(zoom + 1, viewWidth / 2);
	}

	function zoomOut() {
		applyZoom(zoom - 1, viewWidth / 2);
	}

	function zoomFit() {
		zoom = MIN_ZOOM;
		if (timelineScrollRef) timelineScrollRef.scrollLeft = 0;
		scrollLeft = 0;
	}

	function zoomSelection() {
		const next = zoomToRange({ duration, start: trimStart, end: trimEnd });
		zoom = next.zoom;
		requestAnimationFrame(() => {
			if (!timelineScrollRef || !timelineTrackRef) return;
			trackWidthPx = timelineTrackRef.offsetWidth;
			timelineScrollRef.scrollLeft = next.startFrac * timelineTrackRef.offsetWidth;
			scrollLeft = timelineScrollRef.scrollLeft;
		});
	}

	function handlePointerDown(e: PointerEvent) {
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) return;
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		const kind = (e.target as HTMLElement | null)
			?.closest?.('[data-trim-handle]')
			?.getAttribute('data-trim-handle') as 'start' | 'end' | 'slip' | null;
		const t = getTimelineTimeFromEvent(e);
		if (kind === 'start' || kind === 'end') {
			isDragging = kind;
			if (videoRef) videoRef.currentTime = kind === 'start' ? trimStart : trimEnd;
		} else if (kind === 'slip') {
			isDragging = 'slip';
			slipOrigin = { t, start: trimStart, end: trimEnd };
		} else {
			isPanning = true;
			panStartX = e.clientX;
			panStartScroll = timelineScrollRef.scrollLeft;
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
		if (isDragging && timelineScrollRef) {
			const t = getTimelineTimeFromEvent(e);
			if (isDragging === 'start') {
				trimStart = clampTrimStart(t, trimEnd, duration, MIN_TRIM_SPAN);
				if (videoRef) videoRef.currentTime = trimStart;
			} else if (isDragging === 'end') {
				trimEnd = clampTrimEnd(t, trimStart, duration, MIN_TRIM_SPAN);
				if (videoRef) videoRef.currentTime = trimEnd;
			} else {
				const next = slipRange(slipOrigin.start, slipOrigin.end, t - slipOrigin.t, duration);
				trimStart = next.start;
				trimEnd = next.end;
			}
		}
		if (isPanning && timelineScrollRef) {
			const dx = Math.abs(e.clientX - clickStartX);
			const dy = Math.abs(e.clientY - clickStartY);
			if (dx > 3 || dy > 3) hasMoved = true;
			if (hasMoved) {
				timelineScrollRef.scrollLeft = panStartScroll + (panStartX - e.clientX);
				scrollLeft = timelineScrollRef.scrollLeft;
			}
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (isPanning && !hasMoved && videoRef) {
			const t = getTimelineTimeFromEvent(e);
			videoRef.currentTime = Math.max(trimStart, Math.min(trimEnd, t));
		}
		isDragging = null;
		isPanning = false;
		hasMoved = false;
	}

	function handleWheel(e: WheelEvent) {
		if (!timelineScrollRef || !timelineTrackRef) return;
		e.preventDefault();
		const rect = timelineScrollRef.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const delta = e.deltaY > 0 ? -0.5 : 0.5;
		applyZoom(zoom + delta, x);
	}

	function onScroll() {
		if (timelineScrollRef) scrollLeft = timelineScrollRef.scrollLeft;
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
		const measure = () => {
			viewWidth = el.clientWidth;
			if (timelineTrackRef) trackWidthPx = timelineTrackRef.offsetWidth;
			scrollLeft = el.scrollLeft;
		};
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	});

	$effect(() => {
		zoom;
		requestAnimationFrame(() => {
			if (timelineTrackRef) trackWidthPx = timelineTrackRef.offsetWidth;
		});
	});

	$effect(() => {
		const src = sourceSrc;
		const video = stripVideo;
		const cells = filmCells;
		const w = thumbW;
		const h = BAR_HEIGHT;
		if (src !== lastStripSrc) {
			frameCache.clear();
			cacheOrder.length = 0;
			frameUrls = {};
			lastStripSrc = src;
		}
		if (!src || !video || !cells.length) return;
		let cancelled = false;
		const missing = cells.filter((c) => !frameCache.has(frameCacheKey(c.t, w, h)));
		if (!missing.length) return;
		void (async () => {
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
		return () => {
			cancelled = true;
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
				disabled={zoom <= MIN_ZOOM}
				title="Zoom out"
				data-testid="video-trim-zoom-out"
			>
				-
			</button>
			<span class="zoom-level" data-testid="video-trim-zoom-level">{zoom.toFixed(1)}x</span>
			<button
				type="button"
				class="zoom-btn"
				onclick={zoomIn}
				disabled={zoom >= MAX_ZOOM}
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
		style="height: {TICK_ROW_HEIGHT + BAR_HEIGHT}px"
		onwheel={handleWheel}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		onscroll={onScroll}
	>
		<div
			class="timeline-track"
			bind:this={timelineTrackRef}
			style="width: {Math.max(zoom, 1) * 100}%"
		>
			<div class="tick-ruler" data-testid="video-trim-ticks" style="height: {TICK_ROW_HEIGHT}px">
				{#each ticks as tick (tick.t)}
					<div
						class="tick"
						class:major={tick.major}
						class:align-start={tick.align === 'start'}
						class:align-end={tick.align === 'end'}
						data-tick={tick.major ? 'major' : 'minor'}
						style="left: {duration > 0 ? (tick.t / duration) * 100 : 0}%"
					>
						{#if tick.label}
							<span class="tick-label">{tick.label}</span>
						{/if}
					</div>
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
				<div class="veil left" style="width: {startPct}%"></div>
				<div class="veil right" style="left: {endPct}%; width: {Math.max(0, 100 - endPct)}%"></div>
				<div
					class="keep"
					data-testid="video-trim-keep"
					data-trim-handle="slip"
					style="left: {startPct}%; width: {keepPct}%"
					title="Drag to slide the kept range"
				>
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
					></div>
				</div>
			</div>
			{#if duration > 0}
				<div class="playhead" style="left: {playPct}%"></div>
			{/if}
		</div>
	</div>
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
	}

	.timeline-scroll {
		position: relative;
		border-radius: var(--radius-md);
		overflow-x: auto;
		overflow-y: hidden;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		touch-action: none;
		scrollbar-width: none;
		-ms-overflow-style: none;
		background: var(--surface-2, rgb(0 0 0 / 0.35));
		border: 1px solid var(--line-hairline, var(--border));
	}

	.timeline-scroll.dragging {
		cursor: ew-resize;
	}

	.timeline-scroll.slipping {
		cursor: grabbing;
	}

	.timeline-scroll::-webkit-scrollbar {
		display: none;
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
		top: 0;
		bottom: 0;
		width: 1px;
		background: rgb(255 255 255 / 0.18);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.tick.major {
		background: rgb(255 255 255 / 0.45);
	}

	.tick-label {
		position: absolute;
		top: 1px;
		left: 3px;
		font-size: 0.62rem;
		font-family: monospace;
		color: var(--text-muted);
		white-space: nowrap;
		line-height: 1;
	}

	.tick.align-start .tick-label {
		left: 3px;
	}

	.tick.align-end .tick-label {
		left: auto;
		right: 3px;
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
		border: 2px solid rgb(255 255 255 / 0.92);
		background: rgb(255 255 255 / 0.08);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.45);
		cursor: grab;
		z-index: 2;
	}

	.keep:active {
		cursor: grabbing;
	}

	.handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 14px;
		background: rgb(255 255 255 / 0.95);
		cursor: ew-resize;
		z-index: 3;
	}

	.handle::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		width: 2px;
		height: 16px;
		transform: translate(-70%, -50%);
		background: rgb(15 23 42 / 0.45);
		box-shadow: 4px 0 0 rgb(15 23 42 / 0.45);
	}

	.handle.start {
		left: 0;
	}

	.handle.end {
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
		z-index: 5;
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
