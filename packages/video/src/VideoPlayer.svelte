<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Play from '@lucide/svelte/icons/play';
	import Pause from '@lucide/svelte/icons/pause';

	let {
		src,
		captionTrackUrl = undefined,
		captionLang = 'en',
		ariaLabel = 'Video',
		durationSec = undefined,
		speeds = [0.25, 0.5, 1],
		loopCooldownMs = 1500,
		autoplay = true
	}: {
		src: string;
		captionTrackUrl?: string;
		captionLang?: string;
		ariaLabel?: string;
		durationSec?: number;
		speeds?: number[];
		/** Pause between loops. 0 = play once and stop. */
		loopCooldownMs?: number;
		autoplay?: boolean;
	} = $props();

	let videoElement = $state<HTMLVideoElement>();
	let isPaused = $state(false);
	let playbackRate = $state(1);
	let currentTime = $state(0);
	let duration = $state(0);
	let isCooldown = $state(false);
	let cooldownProgress = $state(100);
	let dragging = $state(false);

	let cooldownTimeout: ReturnType<typeof setTimeout> | undefined;
	let cooldownInterval: ReturnType<typeof setInterval> | undefined;

	function togglePlay() {
		if (isCooldown) cancelCooldown();
		if (!videoElement) return;
		if (videoElement.paused) {
			void videoElement.play();
			isPaused = false;
		} else {
			videoElement.pause();
			isPaused = true;
		}
	}

	function changeSpeed(rate: number) {
		playbackRate = rate;
		if (videoElement) videoElement.playbackRate = rate;
	}

	function handleTimeUpdate() {
		if (videoElement && !dragging) currentTime = videoElement.currentTime;
	}

	function handleLoadedMetadata() {
		if (!videoElement) return;
		duration = videoElement.duration || durationSec || 0;
		videoElement.playbackRate = playbackRate;
	}

	function handleEnded() {
		if (!loopCooldownMs) {
			isPaused = true;
			return;
		}
		isCooldown = true;
		cooldownProgress = 100;
		const start = Date.now();
		cooldownInterval = setInterval(() => {
			const elapsed = Date.now() - start;
			cooldownProgress = Math.max(0, 100 - (elapsed / loopCooldownMs) * 100);
		}, 30);
		cooldownTimeout = setTimeout(() => {
			if (cooldownInterval) clearInterval(cooldownInterval);
			isCooldown = false;
			if (videoElement && !isPaused) {
				videoElement.currentTime = 0;
				void videoElement.play();
			}
		}, loopCooldownMs);
	}

	function cancelCooldown() {
		if (cooldownTimeout) clearTimeout(cooldownTimeout);
		if (cooldownInterval) clearInterval(cooldownInterval);
		isCooldown = false;
	}

	function seekTo(pct: number) {
		if (!videoElement) return;
		cancelCooldown();
		const time = pct * duration;
		videoElement.currentTime = time;
		currentTime = time;
	}

	onMount(() => {
		if (videoElement) videoElement.playbackRate = playbackRate;
	});

	onDestroy(() => cancelCooldown());
</script>

<div class="shared-video-player">
	<div class="video-wrapper">
		{#if captionTrackUrl}
			<video
				bind:this={videoElement}
				{src}
				ontimeupdate={handleTimeUpdate}
				onloadedmetadata={handleLoadedMetadata}
				onended={handleEnded}
				muted
				playsinline
				{autoplay}
				aria-label={ariaLabel}
			>
				<track
					kind="captions"
					src={captionTrackUrl}
					srclang={captionLang}
					label="Captions"
					default
				/>
			</video>
		{:else}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				bind:this={videoElement}
				{src}
				ontimeupdate={handleTimeUpdate}
				onloadedmetadata={handleLoadedMetadata}
				onended={handleEnded}
				muted
				playsinline
				{autoplay}
				aria-label={ariaLabel}
			></video>
		{/if}

		{#if isCooldown}
			<div class="cooldown-overlay">
				<div class="cooldown-badge">
					<span class="cooldown-text">Pause</span>
					<div class="cooldown-bar-outer">
						<div class="cooldown-bar-inner" style="width: {cooldownProgress}%"></div>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="controls-bar" onclick={(e) => e.stopPropagation()}>
		<button class="control-btn play-btn" onclick={togglePlay} aria-label={isPaused ? 'Play' : 'Pause'}>
			{#if isPaused}
				<Play size={16} fill="currentColor" />
			{:else}
				<Pause size={16} fill="currentColor" />
			{/if}
		</button>

		<div
			class="progress-track"
			tabindex="0"
			aria-label="Video progress"
			aria-valuetext={`${Math.round(currentTime)}s of ${Math.round(duration)}s`}
			onpointerdown={(e) => {
				e.preventDefault();
				e.stopPropagation();
				e.currentTarget.setPointerCapture(e.pointerId);
				dragging = true;
				const rect = e.currentTarget.getBoundingClientRect();
				const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
				seekTo(pct);
			}}
			onpointermove={(e) => {
				if (!dragging) return;
				e.stopPropagation();
				const rect = e.currentTarget.getBoundingClientRect();
				const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
				seekTo(pct);
			}}
			onpointerup={(e) => {
				e.stopPropagation();
				dragging = false;
			}}
			onkeydown={(e) => {
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					seekTo(Math.max(0, (currentTime - 5) / (duration || 1)));
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					seekTo(Math.min(1, (currentTime + 5) / (duration || 1)));
				}
			}}
			role="slider"
			aria-valuenow={currentTime}
			aria-valuemin={0}
			aria-valuemax={duration}
		>
			<div
				class="progress-fill"
				style="width: {duration > 0 ? (currentTime / duration) * 100 : 0}%"
			></div>
		</div>

		<div class="speed-selector">
			{#each speeds as rate}
				<button
					class="speed-btn"
					class:active={playbackRate === rate}
					onclick={(e) => {
						e.stopPropagation();
						changeSpeed(rate);
					}}
				>
					{rate === 1 ? '1x' : `${rate}x`}
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.shared-video-player {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		background: black;
		position: relative;
	}

	.video-wrapper {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		min-height: 0;
	}

	video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.cooldown-overlay {
		position: absolute;
		top: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		z-index: 5;
	}

	.cooldown-badge {
		background: rgba(10, 10, 15, 0.85);
		backdrop-filter: blur(8px);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-full, 999px);
		padding: 6px 14px;
		display: flex;
		align-items: center;
		gap: 10px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.cooldown-text {
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-secondary, #94a3b8);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.cooldown-bar-outer {
		width: 40px;
		height: 4px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 2px;
		overflow: hidden;
	}

	.cooldown-bar-inner {
		height: 100%;
		background: var(--accent, #0ea5e9);
		border-radius: 2px;
	}

	.controls-bar {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 10px 16px;
		background: rgba(10, 10, 15, 0.95);
		border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		height: 44px;
		flex-shrink: 0;
		z-index: 10;
	}

	.control-btn {
		background: none;
		border: none;
		color: var(--text-secondary, #94a3b8);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-sm, 8px);
		padding: 0;
	}

	.control-btn:hover {
		color: var(--text-primary, #f1f5f9);
		background: rgba(255, 255, 255, 0.05);
	}

	.progress-track {
		flex: 1;
		height: 6px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
		cursor: pointer;
		position: relative;
		touch-action: none;
	}

	.progress-fill {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		background: var(--accent, #0ea5e9);
		border-radius: 3px;
		pointer-events: none;
	}

	.speed-selector {
		display: flex;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-md, 12px);
		padding: 2px;
	}

	.speed-btn {
		background: none;
		border: none;
		color: var(--text-muted, #94a3b8);
		padding: 4px 8px;
		font-size: 0.75rem;
		font-weight: 700;
		border-radius: var(--radius-sm, 8px);
		cursor: pointer;
	}

	.speed-btn.active {
		color: var(--text-primary, #f1f5f9);
		background: rgba(var(--accent-rgb, 14, 165, 233), 0.2);
	}
</style>
