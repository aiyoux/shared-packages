<script lang="ts">
	import { MAX_ZOOM } from '@shared-packages/composition';
	import TimelineMinimap from '@shared-packages/ui/timeline/TimelineMinimap.svelte';
	import { formatTimecode } from './time.js';
	import { BAR_HEIGHT, TICK_ROW_HEIGHT, filmstripLayout, filmstripThumbWidth, frameCacheKey } from './timelineScale.js';
	import { createTrimTimeline } from './trimTimeline.svelte.js';

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

	let timelineScrollRef = $state<HTMLDivElement | null>(null);
	/**
	 * The scroller inset by half a trim handle on each side: time 0 and the
	 * clip's end sit that far inside the clip edge, so at fit zoom both handles
	 * (centred on the keep edges) are whole. Measuring, pointer math and the
	 * wheel-zoom anchor all use this box, so nothing else carries the offset.
	 */
	let timelineViewRef = $state<HTMLDivElement | null>(null);
	let stripVideo = $state<HTMLVideoElement | null>(null);
	let minimapOpen = $state(true);
	let aspect = $state(16 / 9);
	let frameUrls = $state<Record<string, string>>({});

	// Drag/zoom/scrub engine shared with the hub's audio timeline; this
	// component keeps the filmstrip, markup and test ids.
	const tl = createTrimTimeline({
		duration: () => duration,
		currentTime: () => currentTime,
		trimStart: () => trimStart,
		trimEnd: () => trimEnd,
		setTrim: (start, end) => {
			trimStart = start;
			trimEnd = end;
		},
		media: () => videoRef,
		view: () => timelineViewRef,
		capture: () => timelineScrollRef
	});
	const { bindPan, zoomIn, zoomOut, zoomFit, zoomSelection, setPlayheadAsStart, setPlayheadAsEnd, nudgeTrim, handlePointerDown, handlePointerMove, handlePointerUp } = tl;

	const durationMs = $derived(Math.max(0, duration * 1000));
	const vp = $derived(tl.vp);
	const ticks = $derived(tl.ticks);
	const viewportPx = $derived(tl.viewportPx);
	const isDragging = $derived(tl.isDragging);
	const isPanning = $derived(tl.isPanning);
	const keepSpan = $derived(tl.keepSpan);
	const displayTime = $derived(tl.displayTime);
	const playheadOffHandles = $derived(tl.playheadOffHandles);
	const atClipStart = $derived(tl.atClipStart);
	const atClipEnd = $derived(tl.atClipEnd);
	const keepLeftPx = $derived(tl.keepLeftPx);
	const keepRightPx = $derived(tl.keepRightPx);
	const keepWidthPx = $derived(tl.keepWidthPx);
	const playPx = $derived(tl.playPx);
	const sourceSrc = $derived(sourceUrl || videoRef?.currentSrc || videoRef?.src || '');
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
				disabled={vp.zoom <= vp.minZoom}
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
		<div class="time-mid">
			<span class="current-time" data-testid="video-trim-now">{formatTimecode(displayTime, true)}</span>
			{#if playheadOffHandles}
				<div class="set-trim" data-testid="video-trim-set-from-playhead">
					<button
						type="button"
						class="zoom-btn"
						onclick={setPlayheadAsStart}
						disabled={atClipStart || atClipEnd}
						title="Set trim start to the playhead"
						data-testid="video-trim-set-start"
					>
						Set as start
					</button>
					<button
						type="button"
						class="zoom-btn"
						onclick={setPlayheadAsEnd}
						disabled={atClipStart || atClipEnd}
						title="Set trim end to the playhead"
						data-testid="video-trim-set-end"
					>
						Set as end
					</button>
				</div>
			{/if}
		</div>
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
		<div class="timeline-view" bind:this={timelineViewRef}>
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
					{#each filmCells as cell (cell.left)}
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
					title="Arrow keys nudge (Shift: 1s)"
					style="left: {keepLeftPx}px"
					onkeydown={(e) => nudgeTrim('start', e)}
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
					title="Arrow keys nudge (Shift: 1s)"
					style="left: {keepRightPx}px"
					onkeydown={(e) => nudgeTrim('end', e)}
				></div>
				{#if durationMs > 0}
					<div
						class="playhead"
						data-testid="video-trim-playhead"
						data-trim-handle="playhead"
						style="left: {playPx}px"
						title="Drag to seek"
					></div>
				{/if}
			</div>
		</div>
	</div>
	{#if minimapOpen && durationMs > 0 && viewportPx > 0}
		<div class="minimap-slot">
			<TimelineMinimap
				{durationMs}
				{viewportPx}
				zoom={vp.zoom}
				minZoom={vp.minZoom}
				scrollX={vp.scrollX}
				playheadMs={displayTime * 1000}
				height={32}
				testid="video-trim-minimap"
				onScroll={(s) => (tl.scrollX = s)}
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
	<p class="timeline-hint">Drag on the bar to seek · handles to trim · Alt-drag to pan · scroll to zoom</p>
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

	.time-mid {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.set-trim {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 4px;
	}

	.timeline-view {
		position: absolute;
		/* Half the 22px trim handle. */
		inset: 0 11px;
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
		transition: all var(--transition-fast);
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
		border: 1px solid rgb(255 255 255 / 0.72);
		background: rgb(255 255 255 / 0.05);
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
		transform: translateX(-50%);
		cursor: ew-resize;
		z-index: 6;
		touch-action: none;
	}

	.handle::before {
		content: '';
		position: absolute;
		top: 8px;
		bottom: 0;
		left: 50%;
		width: 2px;
		transform: translateX(-50%);
		background: rgb(255 255 255 / 0.92);
	}

	.handle::after {
		content: '';
		position: absolute;
		top: 1px;
		left: 50%;
		width: 10px;
		height: 10px;
		transform: translateX(-50%);
		background: rgb(255 255 255 / 0.92);
		border-radius: 1px;
	}

	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 16px;
		transform: translateX(-50%);
		cursor: ew-resize;
		/* Above the trim handles: parked on one (after an end drag), it stays
		   visible and draggable; the handle keeps its outer edges and keys. */
		z-index: 7;
		touch-action: none;
		will-change: left;
	}

	.playhead::after {
		content: '';
		position: absolute;
		top: 6px;
		bottom: 0;
		left: 50%;
		width: 2px;
		transform: translateX(-50%);
		background: var(--accent-light);
		box-shadow: 0 0 6px var(--accent-glow);
		pointer-events: none;
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
		pointer-events: none;
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
