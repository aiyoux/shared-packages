<script lang="ts">
	import { onMount } from 'svelte';
	import MediaControlsBar from './MediaControlsBar.svelte';
	import { formatTimecode } from './time.js';

	let {
		src,
		captionTrackUrl = undefined,
		captionLang = 'en',
		ariaLabel = 'Video',
		autoplay = true,
		hotkeys = true,
		muted = true,
		maxHeight = '80vh',
		testid = undefined
	}: {
		src: string;
		captionTrackUrl?: string;
		captionLang?: string;
		ariaLabel?: string;
		autoplay?: boolean;
		/** Space toggles play/pause while mounted (modal / lightbox). */
		hotkeys?: boolean;
		/** Muted preview (default); set false for clips whose sound matters. */
		muted?: boolean;
		/** Cap the frame for cards and feeds. */
		maxHeight?: string;
		/** `data-testid` on the video element (e2e hooks). */
		testid?: string;
	} = $props();

	let videoElement = $state<HTMLVideoElement | undefined>();
	let paused = $state(true);
	let currentTime = $state(0);
	let duration = $state(0);
	let playbackRate = $state(1);

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
</script>

<div class="video-wrapper">
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={videoElement}
		{src}
		bind:paused
		bind:currentTime
		bind:duration
		bind:playbackRate
		onended={() => {
			paused = true;
		}}
		{muted}
		playsinline
		{autoplay}
		class="main-video"
		style="max-height:{maxHeight}"
		aria-label={ariaLabel}
		data-testid={testid}
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
		<MediaControlsBar
			{duration}
			{paused}
			bind:currentTime
			bind:playbackRate
			onToggle={togglePlay}
			variant="overlay"
			format={(seconds) => formatTimecode(seconds)}
			testid="video-lightbox"
			media={videoElement ?? null}
		/>
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

	@media (max-width: 600px) {
		.main-video {
			max-height: calc(100vh - 56px);
			object-fit: contain;
		}
	}
</style>
