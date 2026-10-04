<script lang="ts">
	import '@shared-packages/design-system/button.css';
	import { onMount } from 'svelte';
	import { drawPeakBars, drawPlayheadHandle, formatClock } from '@shared-packages/ui/waveform';
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
	 * The preview's audio player: the file's waveform, the played part in the
	 * accent colour, and a playhead with its time (the same drawing as Voice,
	 * `@shared-packages/ui/waveform`). Click or drag the waveform to seek.
	 * Without peaks it draws an even line, so the controls never change shape.
	 */
	let {
		src,
		name,
		peaks = null,
		peaksLoading = false,
		timeline = RANGED,
		onRestart,
		onError,
		testid = 'fe-audio-player'
	}: {
		src: string;
		name: string;
		/** 0..1 per bar, any count; resampled to the width. */
		peaks?: number[] | null;
		peaksLoading?: boolean;
		timeline?: MediaTimeline;
		onRestart?: (at: number) => void;
		onError?: () => void;
		testid?: string;
	} = $props();

	let audio = $state<HTMLAudioElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let wave = $state<HTMLDivElement | null>(null);
	let playing = $state(false);
	let elementTime = $state(0);
	let elementDuration = $state(NaN);
	let muted = $state(false);
	let volume = $state(1);
	let rate = $state(1);
	let scrubTime = $state<number | null>(null);
	let size = $state({ w: 0, h: 0 });
	let resumeAfterRestart = false;
	let frame = 0;

	const duration = $derived(fileDuration(timeline, elementDuration));
	const now = $derived(scrubTime ?? fileTime(timeline, elementTime));
	const progress = $derived(duration ? Math.min(1, now / duration) : 0);

	function cssVar(name: string, fallback: string): string {
		if (!canvas) return fallback;
		return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
	}

	function draw() {
		const c = canvas;
		if (!c || size.w <= 0 || size.h <= 0) return;
		const dpr = window.devicePixelRatio || 1;
		if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
			c.width = Math.round(size.w * dpr);
			c.height = Math.round(size.h * dpr);
		}
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size.w, size.h);
		const accent = cssVar('--accent', '#38bdf8');
		const top = 22;
		ctx.save();
		ctx.translate(0, top);
		drawPeakBars(ctx, size.w, size.h - top, peaks && peaks.length ? peaks : [0.08], progress, {
			barWidth: 3,
			gap: 1,
			playedColor: accent,
			restColor: cssVar('--line-strong', 'rgba(148,197,232,0.32)'),
			scale: 0.9
		});
		ctx.restore();
		if (duration) {
			drawPlayheadHandle(ctx, progress * size.w - 1, size.w, size.h, formatClock(now), {
				color: accent,
				textColor: cssVar('--surface-ground', '#020617')
			});
		}
	}

	$effect(() => {
		void [peaks, progress, size.w, size.h, now];
		if (typeof requestAnimationFrame !== 'function') return;
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(draw);
	});

	onMount(() => {
		const el = wave;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(([e]) => {
			if (e) size = { w: e.contentRect.width, h: e.contentRect.height };
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	});

	function sync() {
		if (!audio) return;
		elementTime = audio.currentTime;
		elementDuration = audio.duration;
		playing = !audio.paused && !audio.ended;
	}

	async function toggle() {
		if (!audio) return;
		if (audio.paused || audio.ended) await audio.play().catch(() => {});
		else audio.pause();
	}

	function seekTo(target: number) {
		if (!audio) return;
		const plan = planSeek(timeline, target, bufferedRanges(audio), duration);
		if (plan.kind === 'native') {
			audio.currentTime = plan.elementTime;
			elementTime = plan.elementTime;
		} else {
			resumeAfterRestart = playing || resumeAfterRestart;
			onRestart?.(plan.at);
		}
	}

	function timeAt(clientX: number): number {
		if (!wave || !duration) return 0;
		const box = wave.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration;
	}

	function onDown(e: PointerEvent) {
		if (!duration) return;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		scrubTime = timeAt(e.clientX);
	}

	function onMove(e: PointerEvent) {
		if (scrubTime !== null) scrubTime = timeAt(e.clientX);
	}

	function onUp(e: PointerEvent) {
		if (scrubTime === null) return;
		scrubTime = null;
		seekTo(timeAt(e.clientX));
	}

	function onWaveKey(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') seekTo(now - 5);
		else if (e.key === 'ArrowRight') seekTo(now + 5);
		else if (e.key === ' ' || e.key === 'k') void toggle();
		else if (e.key === 'Home') seekTo(0);
		else return;
		e.preventDefault();
	}

	function toggleMute() {
		if (!audio) return;
		audio.muted = !audio.muted;
		if (!audio.muted && audio.volume === 0) audio.volume = 0.5;
	}

	$effect(() => {
		void src;
		elementTime = 0;
		if (!audio || !resumeAfterRestart) return;
		resumeAfterRestart = false;
		void audio.play().catch(() => {});
	});
</script>

<div class="fe-ap" data-testid={testid} role="group" aria-label={`Audio player: ${name}`}>
	<audio
		bind:this={audio}
		{src}
		preload="metadata"
		onplay={sync}
		onpause={sync}
		onended={sync}
		ontimeupdate={sync}
		ondurationchange={sync}
		onloadedmetadata={sync}
		onvolumechange={() => {
			muted = audio?.muted ?? false;
			volume = audio?.volume ?? 1;
		}}
		onratechange={() => (rate = audio?.playbackRate ?? 1)}
		onerror={() => onError?.()}
	></audio>
	<div
		class="fe-ap-wave"
		class:fe-ap-wave--loading={peaksLoading}
		bind:this={wave}
		role="slider"
		tabindex="0"
		aria-label="Seek"
		aria-valuemin={0}
		aria-valuemax={Math.floor(duration ?? 0)}
		aria-valuenow={Math.floor(now)}
		aria-valuetext={formatClock(now)}
		data-testid="fe-ap-wave"
		data-has-peaks={peaks && peaks.length ? 'true' : undefined}
		onpointerdown={onDown}
		onpointermove={onMove}
		onpointerup={onUp}
		onkeydown={onWaveKey}
	>
		<canvas bind:this={canvas} class="fe-ap-canvas"></canvas>
	</div>
	<div class="fe-ap-controls">
		<button type="button" class="ds-btn ds-btn--primary ds-btn--icon fe-ap-play" aria-label={playing ? 'Pause' : 'Play'} data-testid="fe-ap-play" onclick={toggle}>
			<FeIcon name={playing ? 'pause' : 'play'} size={16} />
		</button>
		<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-ap-btn" aria-label="Back 10 seconds" onclick={() => seekTo(now - 10)}>
			<FeIcon name="rotate-ccw" size={15} />
		</button>
		<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-ap-btn" aria-label="Forward 10 seconds" onclick={() => seekTo(now + 10)}>
			<FeIcon name="rotate-cw" size={15} />
		</button>
		<span class="fe-ap-time" data-testid="fe-ap-time">{formatClock(now)}{duration ? ` / ${formatClock(duration)}` : ''}</span>
		<span class="fe-ap-spacer"></span>
		<button type="button" class="ds-btn ds-btn--ghost ds-btn--icon fe-ap-btn" aria-label={muted ? 'Unmute' : 'Mute'} onclick={toggleMute}>
			<FeIcon name={muted || volume === 0 ? 'volume-x' : 'volume-2'} size={16} />
		</button>
		<input
			class="fe-ap-volume"
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={muted ? 0 : volume}
			aria-label="Volume"
			oninput={(e) => {
				if (!audio) return;
				audio.volume = Number((e.currentTarget as HTMLInputElement).value);
				audio.muted = audio.volume === 0;
			}}
		/>
		<button
			type="button"
			class="ds-btn ds-btn--ghost ds-btn--sm fe-ap-rate"
			aria-label="Playback speed"
			data-testid="fe-ap-rate"
			onclick={() => {
				if (audio) audio.playbackRate = nextRate(audio.playbackRate);
			}}
		>
			{rate}×
		</button>
	</div>
</div>

<style>
	.fe-ap {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-3);
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		box-sizing: border-box;
	}
	.fe-ap-wave {
		position: relative;
		height: 112px;
		cursor: pointer;
		touch-action: none;
		outline: none;
		border-radius: var(--radius-sm);
		background:
			linear-gradient(transparent calc(50% + 11px), var(--line-hairline) calc(50% + 11px), var(--line-hairline) calc(50% + 12px), transparent calc(50% + 12px));
	}
	.fe-ap-wave:focus-visible {
		box-shadow: 0 0 0 2px var(--surface-ground), 0 0 0 4px var(--accent);
	}
	.fe-ap-wave--loading {
		animation: fe-ap-pulse 1.2s var(--ease) infinite;
	}
	@keyframes fe-ap-pulse {
		50% {
			opacity: 0.55;
		}
	}
	.fe-ap-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
	.fe-ap-controls {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.fe-ap-play {
		width: var(--control-h);
		height: var(--control-h);
		border-radius: var(--radius-full);
		margin-right: var(--space-1);
	}
	.fe-ap-btn {
		width: var(--control-h-sm);
		height: var(--control-h-sm);
		color: var(--text-secondary);
	}
	.fe-ap-btn:hover {
		color: var(--text-primary);
	}
	.fe-ap-time {
		margin-left: var(--space-1);
		font-size: var(--text-sm);
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
		white-space: nowrap;
	}
	.fe-ap-spacer {
		flex: 1;
	}
	.fe-ap-volume {
		width: 72px;
		accent-color: var(--accent);
	}
	.fe-ap-rate {
		min-width: 3rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
	}
	@media (max-width: 420px) {
		.fe-ap-volume {
			display: none;
		}
	}
</style>
