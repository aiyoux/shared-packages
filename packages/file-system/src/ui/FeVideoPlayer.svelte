<script lang="ts">
	import '@shared-packages/design-system/button.css';
	import { onDestroy } from 'svelte';
	import { formatClock } from '@shared-packages/ui/waveform';
	import FeIcon from './FeIcon.svelte';
	import {
		RANGED,
		bufferedRanges,
		fileDuration,
		fileTime,
		nextRate,
		planSeek,
		type MediaTimeline
	} from './mediaClock.js';

	/**
	 * The preview's video player: one control bar in the app's style for every
	 * video, played by ranges or converted on the host. Time is always the
	 * file's time; a seek past what a converted stream holds restarts it there
	 * (`onRestart`), which the bar treats like any other seek.
	 */
	let {
		src,
		name,
		timeline = RANGED,
		onRestart,
		onError,
		testid = 'fe-video-player'
	}: {
		src: string;
		name: string;
		timeline?: MediaTimeline;
		/** Ask for the converted stream again from file second `at`. */
		onRestart?: (at: number) => void;
		onError?: () => void;
		testid?: string;
	} = $props();

	let root = $state<HTMLDivElement | null>(null);
	let video = $state<HTMLVideoElement | null>(null);
	let track = $state<HTMLDivElement | null>(null);
	let playing = $state(false);
	let elementTime = $state(0);
	let elementDuration = $state(NaN);
	let buffered = $state<Array<[number, number]>>([]);
	let muted = $state(false);
	let volume = $state(1);
	let rate = $state(1);
	let fullscreen = $state(false);
	let scrubbing = $state(false);
	let hoverTime = $state<number | null>(null);
	let waiting = $state(false);
	/** Resume after a converted stream restarts at a new point. */
	let resumeAfterRestart = false;

	const duration = $derived(fileDuration(timeline, elementDuration));
	const now = $derived(fileTime(timeline, elementTime));
	const progress = $derived(duration ? Math.min(1, now / duration) : 0);
	const canPip = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

	function sync() {
		if (!video) return;
		elementTime = video.currentTime;
		elementDuration = video.duration;
		buffered = bufferedRanges(video);
		playing = !video.paused && !video.ended;
	}

	async function toggle() {
		if (!video) return;
		if (video.paused || video.ended) await video.play().catch(() => {});
		else video.pause();
	}

	function seekTo(target: number) {
		if (!video) return;
		const plan = planSeek(timeline, target, bufferedRanges(video), duration);
		if (plan.kind === 'native') {
			video.currentTime = plan.elementTime;
			elementTime = plan.elementTime;
		} else {
			resumeAfterRestart = playing || resumeAfterRestart;
			onRestart?.(plan.at);
		}
	}

	function timeAt(clientX: number): number {
		if (!track || !duration) return 0;
		const box = track.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration;
	}

	function onTrackDown(e: PointerEvent) {
		if (!duration) return;
		scrubbing = true;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		hoverTime = timeAt(e.clientX);
	}

	function onTrackMove(e: PointerEvent) {
		hoverTime = timeAt(e.clientX);
	}

	function onTrackUp(e: PointerEvent) {
		if (!scrubbing) return;
		scrubbing = false;
		seekTo(timeAt(e.clientX));
	}

	function onTrackKey(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') seekTo(now - 5);
		else if (e.key === 'ArrowRight') seekTo(now + 5);
		else if (e.key === 'Home') seekTo(0);
		else if (e.key === 'End' && duration) seekTo(duration);
		else return;
		e.preventDefault();
	}

	function onKey(e: KeyboardEvent) {
		if ((e.target as HTMLElement | null)?.closest('input, button, [role="slider"]')) return;
		if (e.key === ' ' || e.key === 'k') toggle();
		else if (e.key === 'ArrowLeft') seekTo(now - 5);
		else if (e.key === 'ArrowRight') seekTo(now + 5);
		else if (e.key === 'm') toggleMute();
		else if (e.key === 'f') void toggleFullscreen();
		else return;
		e.preventDefault();
		e.stopPropagation();
	}

	function toggleMute() {
		if (!video) return;
		video.muted = !video.muted;
		if (!video.muted && video.volume === 0) video.volume = 0.5;
	}

	function setVolume(v: number) {
		if (!video) return;
		video.volume = v;
		video.muted = v === 0;
	}

	function cycleRate() {
		if (!video) return;
		video.playbackRate = nextRate(video.playbackRate);
	}

	async function toggleFullscreen() {
		if (!root) return;
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
		else await root.requestFullscreen?.().catch(() => {});
	}

	async function togglePip() {
		if (!video) return;
		if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});
		else await video.requestPictureInPicture?.().catch(() => {});
	}

	function onFullscreenChange() {
		fullscreen = document.fullscreenElement === root;
	}

	// A restarted converted stream is a new `src`: keep playing if it was.
	$effect(() => {
		void src;
		elementTime = 0;
		if (!video || !resumeAfterRestart) return;
		resumeAfterRestart = false;
		void video.play().catch(() => {});
	});

	onDestroy(() => {
		if (typeof document !== 'undefined' && document.pictureInPictureElement === video) {
			void document.exitPictureInPicture().catch(() => {});
		}
	});
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- The player takes keys while focused; every action also has a button. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	class="fe-vp"
	class:fe-vp--fullscreen={fullscreen}
	class:fe-vp--paused={!playing}
	bind:this={root}
	data-testid={testid}
	tabindex="0"
	role="group"
	aria-label={`Video player: ${name}`}
	onkeydown={onKey}
>
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={video}
		class="fe-vp-video"
		{src}
		playsinline
		preload="metadata"
		onclick={toggle}
		ondblclick={toggleFullscreen}
		onplay={sync}
		onpause={sync}
		onended={sync}
		ontimeupdate={sync}
		ondurationchange={sync}
		onloadedmetadata={sync}
		onprogress={sync}
		onwaiting={() => (waiting = true)}
		onplaying={() => (waiting = false)}
		oncanplay={() => (waiting = false)}
		onvolumechange={() => {
			muted = video?.muted ?? false;
			volume = video?.volume ?? 1;
		}}
		onratechange={() => (rate = video?.playbackRate ?? 1)}
		onerror={() => onError?.()}
	></video>
	{#if waiting}
		<div class="fe-vp-wait" aria-hidden="true"></div>
	{/if}
	{#if !playing}
		<button type="button" class="fe-vp-bigplay" aria-label="Play" onclick={toggle} tabindex="-1">
			<FeIcon name="play" size={28} />
		</button>
	{/if}
	<div class="fe-vp-bar">
		<div
			class="fe-vp-track"
			bind:this={track}
			role="slider"
			tabindex="0"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={Math.floor(duration ?? 0)}
			aria-valuenow={Math.floor(now)}
			aria-valuetext={formatClock(now)}
			data-testid="fe-vp-track"
			onpointerdown={onTrackDown}
			onpointermove={onTrackMove}
			onpointerup={onTrackUp}
			onpointerleave={() => {
				if (!scrubbing) hoverTime = null;
			}}
			onkeydown={onTrackKey}
		>
			<div class="fe-vp-rail">
				{#if duration}
					{#each buffered as [from, to], i (i)}
						<div
							class="fe-vp-buffered"
							style="left:{((timeline.start + from) / duration) * 100}%;width:{((to - from) / duration) * 100}%"
						></div>
					{/each}
				{/if}
				<div class="fe-vp-played" style="width:{(scrubbing && hoverTime !== null && duration ? hoverTime / duration : progress) * 100}%"></div>
			</div>
			{#if hoverTime !== null && duration}
				<div class="fe-vp-hover" style="left:{(hoverTime / duration) * 100}%">{formatClock(hoverTime)}</div>
			{/if}
		</div>
		<div class="fe-vp-controls">
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label={playing ? 'Pause' : 'Play'} data-testid="fe-vp-play" onclick={toggle}>
				<FeIcon name={playing ? 'pause' : 'play'} size={16} />
			</button>
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label="Back 10 seconds" onclick={() => seekTo(now - 10)}>
				<FeIcon name="rotate-ccw" size={15} />
			</button>
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label="Forward 10 seconds" onclick={() => seekTo(now + 10)}>
				<FeIcon name="rotate-cw" size={15} />
			</button>
			<span class="fe-vp-time" data-testid="fe-vp-time">{formatClock(now)}{duration ? ` / ${formatClock(duration)}` : ''}</span>
			<span class="fe-vp-spacer"></span>
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label={muted ? 'Unmute' : 'Mute'} onclick={toggleMute}>
				<FeIcon name={muted || volume === 0 ? 'volume-x' : 'volume-2'} size={16} />
			</button>
			<input
				class="fe-vp-volume"
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={muted ? 0 : volume}
				aria-label="Volume"
				oninput={(e) => setVolume(Number((e.currentTarget as HTMLInputElement).value))}
			/>
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--sm fe-vp-rate" aria-label="Playback speed" data-testid="fe-vp-rate" onclick={cycleRate}>
				{rate}×
			</button>
			{#if canPip}
				<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label="Picture in picture" onclick={togglePip}>
					<FeIcon name="picture-in-picture-2" size={16} />
				</button>
			{/if}
			<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-vp-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onclick={toggleFullscreen}>
				<FeIcon name={fullscreen ? 'minimize-2' : 'maximize-2'} size={16} />
			</button>
		</div>
	</div>
</div>

<style>
	.fe-vp {
		position: relative;
		display: flex;
		flex-direction: column;
		max-width: 100%;
		max-height: 100%;
		min-height: 0;
		background: var(--surface-ground);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		overflow: hidden;
		outline: none;
	}
	.fe-vp:focus-visible {
		box-shadow: 0 0 0 2px var(--surface-ground), 0 0 0 4px var(--accent);
	}
	.fe-vp--fullscreen {
		border: 0;
		border-radius: 0;
		width: 100%;
		height: 100%;
	}
	.fe-vp-video {
		display: block;
		flex: 1 1 auto;
		min-height: 0;
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		background: #000;
		cursor: pointer;
	}
	.fe-vp-bigplay {
		position: absolute;
		left: 50%;
		top: calc(50% - 24px);
		transform: translate(-50%, -50%);
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-full);
		background: rgb(var(--scrim-rgb) / 0.55);
		color: var(--text-primary);
		cursor: pointer;
		transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
	}
	.fe-vp-bigplay:hover {
		background: rgb(var(--accent-rgb) / 0.25);
		border-color: var(--accent);
	}
	.fe-vp-wait {
		position: absolute;
		left: 50%;
		top: calc(50% - 24px);
		width: 28px;
		height: 28px;
		margin: -14px 0 0 -14px;
		border: 2px solid var(--line-strong);
		border-top-color: var(--accent);
		border-radius: var(--radius-full);
		animation: fe-vp-spin 800ms linear infinite;
		pointer-events: none;
	}
	@keyframes fe-vp-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.fe-vp-bar {
		flex: none;
		background: var(--surface-2);
		border-top: 1px solid var(--line-hairline);
		padding: var(--space-1) var(--space-2) var(--space-1);
	}
	.fe-vp-track {
		position: relative;
		height: 16px;
		display: flex;
		align-items: center;
		cursor: pointer;
		touch-action: none;
		outline: none;
	}
	.fe-vp-track:focus-visible .fe-vp-rail {
		box-shadow: 0 0 0 2px var(--accent-glow);
	}
	.fe-vp-rail {
		position: relative;
		width: 100%;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--line-hairline);
		overflow: hidden;
		transition: height var(--dur-fast) var(--ease);
	}
	.fe-vp-track:hover .fe-vp-rail {
		height: 6px;
	}
	.fe-vp-buffered {
		position: absolute;
		top: 0;
		bottom: 0;
		background: var(--line-strong);
	}
	.fe-vp-played {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: var(--accent);
	}
	.fe-vp-hover {
		position: absolute;
		bottom: 100%;
		transform: translateX(-50%);
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		background: var(--surface-3);
		border: 1px solid var(--line-strong);
		color: var(--text-primary);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
	}
	.fe-vp-controls {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.fe-vp-btn {
		width: var(--control-h-sm);
		height: var(--control-h-sm);
		color: var(--text-secondary);
	}
	.fe-vp-btn:hover {
		color: var(--text-primary);
	}
	.fe-vp-time {
		margin-left: var(--space-1);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
		white-space: nowrap;
	}
	.fe-vp-spacer {
		flex: 1;
	}
	.fe-vp-volume {
		width: 72px;
		accent-color: var(--accent);
	}
	.fe-vp-rate {
		min-width: 3rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
	}
	@media (max-width: 420px) {
		.fe-vp-volume {
			display: none;
		}
	}
</style>
