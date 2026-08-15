<script lang="ts">
	import { onMount } from 'svelte';
	import { formatTimecode } from './time.js';

	let {
		src,
		captionTrackUrl = undefined,
		captionLang = 'en',
		ariaLabel = 'Video',
		autoplay = true,
		hotkeys = true
	}: {
		src: string;
		captionTrackUrl?: string;
		captionLang?: string;
		ariaLabel?: string;
		autoplay?: boolean;
		/** Space toggles play/pause while mounted (modal / lightbox). */
		hotkeys?: boolean;
	} = $props();

	let videoElement = $state<HTMLVideoElement | undefined>();
	let paused = $state(true);
	let currentTime = $state(0);
	let duration = $state(0);
	let playbackRate = $state(1);
	let dragging = $state(false);

	const togglePlay = () => (paused = !paused);

	onMount(() => {
		if (!hotkeys) return;
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === ' ') {
				e.preventDefault();
				togglePlay();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	const handleTimeUpdate = (e: Event) => {
		if (dragging) return;
		currentTime = (e.currentTarget as HTMLVideoElement).currentTime;
	};

	const seekTo = (seconds: number) => {
		if (!videoElement) return;
		const clamped = Math.max(0, Math.min(duration || 0, seconds));
		videoElement.currentTime = clamped;
		currentTime = clamped;
	};
</script>

<div class="video-wrapper">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={videoElement}
		{src}
		bind:paused
		bind:duration
		bind:playbackRate
		ontimeupdate={handleTimeUpdate}
		onended={() => {
			paused = true;
		}}
		muted
		playsinline
		{autoplay}
		class="main-video"
		aria-label={ariaLabel}
	>
		{#if captionTrackUrl}
			<track
				kind="captions"
				src={captionTrackUrl}
				srclang={captionLang}
				label="Captions"
				default
			/>
		{/if}
	</video>

	<div class="controls-overlay" class:visible={paused}>
		<div class="controls-bar">
			<button class="control-btn" onclick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}>
				{paused ? '▶' : '⏸'}
			</button>

			<div class="progress-bar">
				<span class="time">{formatTimecode(currentTime)}</span>
				<div
					class="progress-track"
					onpointerdown={(e) => {
						e.preventDefault();
						e.currentTarget.setPointerCapture(e.pointerId);
						dragging = true;
						const rect = e.currentTarget.getBoundingClientRect();
						const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
						seekTo(pct * (duration || 0));
					}}
					onpointermove={(e) => {
						if (!dragging) return;
						const rect = e.currentTarget.getBoundingClientRect();
						const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
						seekTo(pct * (duration || 0));
					}}
					onpointerup={() => {
						dragging = false;
					}}
					onkeydown={(e) => {
						const step = (duration || 0) / 20;
						if (e.key === 'ArrowLeft') {
							e.preventDefault();
							seekTo(currentTime - step);
						}
						if (e.key === 'ArrowRight') {
							e.preventDefault();
							seekTo(currentTime + step);
						}
					}}
					role="slider"
					aria-valuenow={currentTime}
					aria-valuemin={0}
					aria-valuemax={duration || 0}
					tabindex="0"
				>
					<div
						class="progress-fill"
						style="width: {(duration > 0 ? (currentTime / duration) * 100 : 0).toFixed(2)}%"
					></div>
					<div
						class="progress-thumb"
						style="left: {(duration > 0 ? (currentTime / duration) * 100 : 0).toFixed(2)}%"
					></div>
				</div>
				<span class="time">{formatTimecode(duration)}</span>
			</div>

			<div class="speed-control">
				<span class="speed-label">{playbackRate.toFixed(1)}x</span>
				<input
					type="range"
					min="0.25"
					max="2"
					step="0.25"
					bind:value={playbackRate}
					class="speed-slider"
					aria-label="Playback speed"
				/>
			</div>
		</div>
	</div>
</div>

<style>
	.video-wrapper {
		position: relative;
		width: 100%;
		background: black;
		display: flex;
		flex-direction: column;
	}

	.main-video {
		width: 100%;
		max-height: 80vh;
	}

	.controls-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
		padding: 20px;
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.video-wrapper:hover .controls-overlay,
	.controls-overlay.visible {
		opacity: 1;
	}

	.controls-bar {
		display: flex;
		align-items: center;
		gap: 16px;
		background: rgba(255, 255, 255, 0.1);
		backdrop-filter: blur(10px);
		padding: 10px 16px;
		border-radius: var(--radius-md, 12px);
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
	}

	.progress-bar {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.time {
		font-size: 0.85rem;
		font-family: monospace;
		color: rgba(255, 255, 255, 0.8);
		min-width: 35px;
	}

	.progress-track {
		flex: 1;
		height: 6px;
		background: rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		cursor: pointer;
		position: relative;
		overflow: visible;
		touch-action: none;
	}

	.progress-fill {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		background: var(--accent, #0ea5e9);
		border-radius: 4px;
		pointer-events: none;
	}

	.progress-thumb {
		position: absolute;
		top: 50%;
		width: 14px;
		height: 14px;
		background: var(--accent, #0ea5e9);
		border: 2px solid white;
		border-radius: 50%;
		transform: translate(-50%, -50%);
		pointer-events: none;
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
		cursor: pointer;
		accent-color: var(--accent, #0ea5e9);
	}

	@media (max-width: 600px) {
		.main-video {
			max-height: calc(100vh - 56px);
			object-fit: contain;
		}
	}
</style>
