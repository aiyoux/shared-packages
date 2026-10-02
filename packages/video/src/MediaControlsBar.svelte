<script lang="ts">
	/**
	 * Play/pause, seek with times, and playback speed — the controls row the
	 * video transport, the crop preview and the audio transport share. The
	 * parent owns the media element and what play means (seek to the trim
	 * start first); this owns the row and its two looks:
	 *  - `overlay`: the glass bar a video stage fades in over the frame
	 *  - `flat`: the inline bar under an audio clip
	 */
	import Play from '@lucide/svelte/icons/play';
	import Pause from '@lucide/svelte/icons/pause';
	import { formatTimecode } from './time.js';

	let {
		duration,
		paused,
		currentTime = $bindable(0),
		playbackRate = $bindable(1),
		onToggle,
		variant = 'overlay',
		format = (seconds: number) => formatTimecode(seconds, true),
		testid
	}: {
		duration: number;
		paused: boolean;
		currentTime?: number;
		playbackRate?: number;
		onToggle: () => void;
		variant?: 'overlay' | 'flat';
		format?: (seconds: number) => string;
		/** Prefix for `-toggle` on the play button. */
		testid?: string;
	} = $props();
</script>

<div class="controls-bar {variant}">
	<button
		type="button"
		class="control-btn"
		onclick={onToggle}
		aria-label={paused ? 'Play' : 'Pause'}
		data-testid={testid ? `${testid}-toggle` : undefined}
	>
		{#if paused}
			<Play size={20} />
		{:else}
			<Pause size={20} />
		{/if}
	</button>

	<div class="progress-bar">
		<span class="time">{format(currentTime)}</span>
		<input type="range" min={0} max={duration || 0} step={0.1} bind:value={currentTime} class="seek-slider" aria-label="Seek" />
		<span class="time">{format(duration)}</span>
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

<style>
	.controls-bar {
		display: flex;
		align-items: center;
	}
	.control-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.progress-bar {
		flex: 1;
		display: flex;
		align-items: center;
	}
	.speed-control {
		display: flex;
		align-items: center;
	}

	/* overlay: glass bar over a video frame. In a narrow stage the speed
	 * control wraps onto its own line instead of overflowing the frame. */
	.overlay {
		flex-wrap: wrap;
		gap: 8px 16px;
		background: rgba(255, 255, 255, 0.1);
		backdrop-filter: blur(10px);
		padding: 10px 16px;
		border-radius: var(--radius-md);
		border: 1px solid rgba(255, 255, 255, 0.1);
	}
	.overlay .control-btn {
		background: none;
		border: none;
		color: white;
		font-size: 20px;
		width: 32px;
		transition: transform var(--transition-fast) var(--ease-default);
	}
	.overlay .control-btn:hover {
		color: var(--accent-light);
		transform: scale(1.1);
	}
	.overlay .progress-bar {
		flex: 1 1 200px;
		min-width: 0;
		gap: 12px;
	}
	.overlay .time,
	.overlay .speed-label {
		font-size: 0.85rem;
		font-family: monospace;
		color: rgba(255, 255, 255, 0.8);
		min-width: 35px;
	}
	.overlay .speed-label {
		text-align: right;
	}
	.overlay .speed-control {
		gap: 8px;
		min-width: 120px;
	}
	.overlay .seek-slider,
	.overlay .speed-slider {
		flex: 1;
		min-width: 0;
		height: 4px;
		border-radius: var(--radius-2xs);
		cursor: pointer;
		accent-color: var(--accent);
	}

	/* flat: inline bar under an audio clip */
	.flat {
		gap: 10px;
	}
	.flat .control-btn {
		width: 34px;
		height: 34px;
		border-radius: 999px;
		border: 1px solid var(--line-hairline, var(--border));
		background: transparent;
		color: var(--text-primary);
	}
	.flat .progress-bar {
		gap: 8px;
		min-width: 0;
	}
	.flat .time,
	.flat .speed-label {
		font-size: 0.72rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.flat .time {
		white-space: nowrap;
	}
	.flat .seek-slider {
		flex: 1;
		min-width: 0;
	}
	.flat .speed-control {
		gap: 6px;
	}
	.flat .speed-slider {
		width: 72px;
	}
</style>
