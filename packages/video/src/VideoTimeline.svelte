<script lang="ts">
	let {
		duration,
		currentTime,
		trimStart = $bindable(0),
		trimEnd = $bindable(0),
		videoRef = null as HTMLVideoElement | null
	}: {
		duration: number;
		currentTime: number;
		trimStart?: number;
		trimEnd?: number;
		videoRef?: HTMLVideoElement | null;
	} = $props();

	let isDragging = $state<'start' | 'end' | null>(null);
	let timelineScrollRef = $state<HTMLDivElement | null>(null);
	let timelineTrackRef = $state<HTMLDivElement | null>(null);
	let zoom = $state(1);
	let isPanning = $state(false);
	let panStartX = $state(0);
	let panStartScroll = $state(0);
	let clickStartX = $state(0);
	let clickStartY = $state(0);
	let hasMoved = $state(false);

	function formatTime(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds % 1) * 100);
		return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
	}

	function getTimelineTimeFromEvent(e: MouseEvent | TouchEvent): number {
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) return 0;
		const rect = timelineScrollRef.getBoundingClientRect();
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const x = clientX - rect.left;
		const scrollLeft = timelineScrollRef.scrollLeft;
		const trackWidth = timelineTrackRef.offsetWidth;
		return Math.max(0, Math.min(duration, ((scrollLeft + x) / trackWidth) * duration));
	}

	function getPixelDistanceToMarker(e: MouseEvent | TouchEvent, markerTime: number): number {
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) return Infinity;
		const rect = timelineScrollRef.getBoundingClientRect();
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const x = clientX - rect.left;
		const markerPixel =
			(markerTime / duration) * timelineTrackRef.offsetWidth - timelineScrollRef.scrollLeft;
		return Math.abs(x - markerPixel);
	}

	function handleTimelineMouseDown(e: MouseEvent | TouchEvent) {
		if (!timelineScrollRef || !timelineTrackRef || duration <= 0) return;
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

		const distStartPx = getPixelDistanceToMarker(e, trimStart);
		const distEndPx = getPixelDistanceToMarker(e, trimEnd);
		const PIXEL_THRESHOLD = 20;

		if (distStartPx < PIXEL_THRESHOLD && distStartPx <= distEndPx) {
			isDragging = 'start';
		} else if (distEndPx < PIXEL_THRESHOLD && distEndPx < distStartPx) {
			isDragging = 'end';
		} else {
			isPanning = true;
			panStartX = clientX;
			panStartScroll = timelineScrollRef.scrollLeft;
			clickStartX = clientX;
			clickStartY = clientY;
			hasMoved = false;
		}
	}

	function handleTimelineMouseMove(e: MouseEvent | TouchEvent) {
		if (isDragging && timelineScrollRef) {
			const t = getTimelineTimeFromEvent(e);
			if (isDragging === 'start') {
				trimStart = Math.max(0, Math.min(trimEnd - 0.1, t));
				if (videoRef) videoRef.currentTime = trimStart;
			} else {
				trimEnd = Math.max(trimStart + 0.1, Math.min(duration, t));
				if (videoRef) videoRef.currentTime = trimEnd;
			}
		}
		if (isPanning && timelineScrollRef) {
			const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
			const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
			const dx = Math.abs(clientX - clickStartX);
			const dy = Math.abs(clientY - clickStartY);
			if (dx > 3 || dy > 3) hasMoved = true;
			if (hasMoved) {
				timelineScrollRef.scrollLeft = panStartScroll + (panStartX - clientX);
			}
		}
	}

	function handleTimelineMouseUp(e: MouseEvent | TouchEvent) {
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
		const oldZoom = zoom;
		const delta = e.deltaY > 0 ? -0.5 : 0.5;
		const newZoom = Math.max(1, Math.min(50, oldZoom + delta));
		if (newZoom === oldZoom) return;

		const scrollLeft = timelineScrollRef.scrollLeft;
		const trackWidth = timelineTrackRef.offsetWidth;
		const timeUnderCursor = ((scrollLeft + x) / trackWidth) * duration;

		zoom = newZoom;

		requestAnimationFrame(() => {
			if (!timelineScrollRef || !timelineTrackRef) return;
			const newTrackWidth = timelineTrackRef.offsetWidth;
			const newScrollLeft = (timeUnderCursor / duration) * newTrackWidth - x;
			timelineScrollRef.scrollLeft = Math.max(0, newScrollLeft);
		});
	}

	function zoomIn() {
		zoom = Math.min(50, zoom + 1);
	}

	function zoomOut() {
		zoom = Math.max(1, zoom - 1);
	}

	function zoomFit() {
		zoom = 1;
		if (timelineScrollRef) timelineScrollRef.scrollLeft = 0;
	}
</script>

<div class="timeline-section">
	<div class="timeline-toolbar">
		<div class="zoom-controls">
			<button class="zoom-btn" onclick={zoomOut} disabled={zoom <= 1} title="Zoom out">-</button>
			<span class="zoom-level">{zoom.toFixed(1)}x</span>
			<button class="zoom-btn" onclick={zoomIn} disabled={zoom >= 50} title="Zoom in">+</button>
			<button class="zoom-btn" onclick={zoomFit} title="Fit to view">fit</button>
		</div>
	</div>
	<div class="time-display">
		<span class="time-tag">{formatTime(trimStart)}</span>
		<span class="current-time">{formatTime(currentTime)}</span>
		<span class="time-tag">{formatTime(trimEnd)}</span>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
	<div
		class="timeline-scroll"
		bind:this={timelineScrollRef}
		onwheel={handleWheel}
		onmousedown={handleTimelineMouseDown}
		onmousemove={handleTimelineMouseMove}
		onmouseup={handleTimelineMouseUp}
		onmouseleave={handleTimelineMouseUp}
		ontouchstart={handleTimelineMouseDown}
		ontouchmove={handleTimelineMouseMove}
		ontouchend={handleTimelineMouseUp}
	>
		<div
			class="timeline-track"
			bind:this={timelineTrackRef}
			style="width: {Math.max(zoom, 1) * 100}%"
		>
			<div class="timeline-bg"></div>
			<div
				class="trim-region"
				style="left: {(trimStart / duration) * 100}%; width: {((trimEnd - trimStart) / duration) * 100}%"
			></div>
			<div class="marker start-marker" style="left: {(trimStart / duration) * 100}%"></div>
			<div class="marker-label start-label" style="left: {(trimStart / duration) * 100}%">
				{formatTime(trimStart)}
			</div>
			<div class="marker end-marker" style="left: {(trimEnd / duration) * 100}%"></div>
			<div class="marker-label end-label" style="left: {(trimEnd / duration) * 100}%">
				{formatTime(trimEnd)}
			</div>
			{#if duration > 0}
				<div class="playhead" style="left: {(currentTime / duration) * 100}%"></div>
				<div class="playhead-label" style="left: {(currentTime / duration) * 100}%">
					{formatTime(currentTime)}
				</div>
			{/if}
		</div>
	</div>
	<p class="timeline-hint">Drag markers to trim · Click to seek · Scroll to zoom</p>
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
		height: 100%;
		min-width: 100%;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		touch-action: none;
	}

	.timeline-scroll {
		position: relative;
		height: 52px;
		border-radius: var(--radius-md);
		overflow-x: auto;
		overflow-y: hidden;
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		touch-action: pan-x;
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.timeline-scroll::-webkit-scrollbar {
		display: none;
	}

	.timeline-toolbar {
		display: flex;
		justify-content: flex-end;
		align-items: center;
	}

	.zoom-controls {
		display: flex;
		align-items: center;
		gap: 4px;
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

	.timeline-bg {
		position: absolute;
		top: 22px;
		left: 0;
		right: 0;
		height: 8px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: var(--radius-full);
	}

	.trim-region {
		position: absolute;
		top: 22px;
		height: 8px;
		background: var(--accent);
		border-radius: var(--radius-full);
		opacity: 0.6;
		pointer-events: none;
	}

	.marker {
		position: absolute;
		top: 10px;
		width: 12px;
		height: 32px;
		background: var(--accent);
		border-radius: var(--radius-sm);
		transform: translateX(-50%);
		cursor: grab;
		z-index: 2;
		box-shadow: 0 2px 8px rgba(var(--accent-rgb), 0.4);
		transition: transform 0.1s ease;
	}

	.marker:active {
		cursor: grabbing;
		transform: translateX(-50%) scale(1.2);
	}

	.start-marker {
		background: #10b981;
	}

	.end-marker {
		background: #ef4444;
	}

	.playhead {
		position: absolute;
		top: 18px;
		width: 3px;
		height: 20px;
		background: var(--accent-light);
		transform: translateX(-50%);
		pointer-events: none;
		z-index: 1;
		box-shadow: 0 0 6px var(--accent-glow);
	}

	.marker-label {
		position: absolute;
		top: 2px;
		transform: translateX(-50%);
		font-size: 0.65rem;
		font-family: monospace;
		color: var(--text-secondary);
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 1px 4px;
		white-space: nowrap;
		pointer-events: none;
		z-index: 3;
	}

	.start-label {
		color: #10b981;
		border-color: rgba(16, 185, 129, 0.4);
	}

	.end-label {
		color: #ef4444;
		border-color: rgba(239, 68, 68, 0.4);
	}

	.playhead-label {
		position: absolute;
		top: 2px;
		transform: translateX(-50%);
		font-size: 0.65rem;
		font-family: monospace;
		color: var(--accent-light);
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 1px 4px;
		white-space: nowrap;
		pointer-events: none;
		z-index: 3;
	}

	.timeline-hint {
		text-align: center;
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}
</style>
