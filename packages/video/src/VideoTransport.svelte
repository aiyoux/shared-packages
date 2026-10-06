<script lang="ts">
	import MediaControlsBar from './MediaControlsBar.svelte';

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

	function togglePlay() {
		if (!videoRef) return;
		if (paused) {
			videoRef.currentTime = trimStart;
		}
		paused = !paused;
	}

	function handleTimeUpdate() {
		if (!videoRef || paused) return;
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
		<MediaControlsBar {duration} {paused} bind:currentTime bind:playbackRate onToggle={togglePlay} media={videoRef} />
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
		transition: opacity var(--transition-normal);
		pointer-events: none;
	}

	.video-stage:hover .controls-overlay,
	.controls-overlay.visible {
		opacity: 1;
		pointer-events: auto;
	}
</style>
