<script lang="ts">
	import Play from '@lucide/svelte/icons/play';
import Pause from '@lucide/svelte/icons/pause';

	let {
		sourceUrl,
		duration,
		trimStart,
		trimEnd,
		videoRef = $bindable(null as HTMLVideoElement | null),
		paused = $bindable(true),
		currentTime = $bindable(0),
		playbackRate = $bindable(1)
	}: {
		sourceUrl: string | null;
		duration: number;
		trimStart: number;
		trimEnd: number;
		videoRef?: HTMLVideoElement | null;
		paused?: boolean;
		currentTime?: number;
		playbackRate?: number;
	} = $props();

	function formatTime(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds % 1) * 100);
		return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
	}

	function togglePlay() {
		if (!videoRef) return;
		if (paused) {
			videoRef.currentTime = trimStart;
		}
		paused = !paused;
	}

	function handleTimeUpdate() {
		if (!videoRef) return;
		if (videoRef.currentTime >= trimEnd) {
			paused = true;
			videoRef.currentTime = trimStart;
		}
	}
</script>

<div class="video-stage">
	<video
		bind:this={videoRef}
		src={sourceUrl}
		preload="metadata"
		muted
		playsinline
		bind:paused
		bind:currentTime
		bind:playbackRate
		ontimeupdate={handleTimeUpdate}
		onclick={togglePlay}
		class="editor-video"
	></video>

	<div class="controls-overlay" class:visible={paused}>
		<div class="controls-bar">
			<button class="control-btn" onclick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}>
				{#if paused}
					<Play size={20} />
				{:else}
					<Pause size={20} />
				{/if}
			</button>

			<div class="progress-bar">
				<span class="time">{formatTime(currentTime)}</span>
				<input
					type="range"
					min={0}
					max={duration || 0}
					step={0.1}
					bind:value={currentTime}
					class="seek-slider"
				/>
				<span class="time">{formatTime(duration)}</span>
			</div>

			<div class="speed-control">
				<span class="speed-label">{playbackRate.toFixed(1)}x</span>
				<input
					type="range"
					min={0.25}
					max={2}
					step={0.25}
					bind:value={playbackRate}
					class="speed-slider"
					aria-label="Playback speed"
				/>
			</div>
		</div>
	</div>
</div>

<style>
	.video-stage {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		background: rgba(0, 0, 0, 0.3);
		border-radius: var(--radius-lg);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.editor-video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		cursor: pointer;
	}

	.controls-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
		padding: 20px;
		opacity: 0;
		transition: opacity var(--transition-normal) var(--ease-default);
		pointer-events: none;
	}

	.video-stage:hover .controls-overlay,
	.controls-overlay.visible {
		opacity: 1;
		pointer-events: auto;
	}

	.controls-bar {
		display: flex;
		align-items: center;
		gap: 16px;
		background: rgba(255, 255, 255, 0.1);
		backdrop-filter: blur(10px);
		padding: 10px 16px;
		border-radius: var(--radius-md);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}

	.control-btn {
		background: none;
		border: none;
		color: white;
		font-size: 20px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		transition: transform var(--transition-fast) var(--ease-default);
	}

	.control-btn:hover {
		color: var(--accent-light);
		transform: scale(1.1);
	}

	.controls-bar .progress-bar {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.controls-bar .time {
		font-size: 0.85rem;
		font-family: monospace;
		color: rgba(255, 255, 255, 0.8);
		min-width: 35px;
	}

	.seek-slider {
		flex: 1;
		height: 4px;
		border-radius: var(--radius-2xs);
		cursor: pointer;
		accent-color: var(--accent);
	}

	.speed-control {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 120px;
	}

	.speed-label {
		font-size: 0.85rem;
		font-family: monospace;
		color: rgba(255, 255, 255, 0.8);
		min-width: 35px;
		text-align: right;
	}

	.speed-slider {
		flex: 1;
		height: 4px;
		border-radius: var(--radius-2xs);
		cursor: pointer;
		accent-color: var(--accent);
	}
</style>
