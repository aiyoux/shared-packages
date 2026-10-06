<script lang="ts">
	/**
	 * Play/pause, seek with times, and playback speed — the controls row the
	 * video transport, the crop preview and the audio transport share. The
	 * parent owns the media element and what play means (seek to the trim
	 * start first); this owns the row and its two looks:
	 *  - `overlay`: the glass bar a video stage fades in over the frame
	 *  - `flat`: the inline bar under an audio clip
	 *
	 * Seeking uses the preview player's smooth scrub: seek on pointer down
	 * and throughout the drag, coalescing moves on an animation frame and
	 * letting each in-flight seek decode before applying the latest target.
	 * Playback pauses during the drag and resumes at the exact release point.
	 */
	import Play from '@lucide/svelte/icons/play';
	import Pause from '@lucide/svelte/icons/pause';
	import { onDestroy, untrack } from 'svelte';
	import { formatTimecode } from './time.js';
	import { clampScrubTarget, scrubDisplayTime, shouldDeferScrubSeek } from './scrubSeek.js';

	let {
		duration,
		paused,
		currentTime = $bindable(0),
		playbackRate = $bindable(1),
		onToggle,
		variant = 'overlay',
		format = (seconds: number) => formatTimecode(seconds, true),
		testid,
		media = null
	}: {
		duration: number;
		paused: boolean;
		currentTime?: number;
		playbackRate?: number;
		onToggle: () => void;
		variant?: 'overlay' | 'flat';
		format?: (seconds: number) => string;
		/** Prefix for `-toggle` on the play button and `-seek` on the scrub track. */
		testid?: string;
		/** The element being scrubbed; seeks pause, coalesce and resume through it. */
		media?: HTMLMediaElement | null;
	} = $props();

	let track = $state<HTMLDivElement | null>(null);
	let scrubbing = $state(false);
	let hoverTime = $state<number | null>(null);
	let pendingSeek = $state<number | null>(null);
	let resumeAfterScrub = false;
	let scrubPointerId: number | null = null;
	let scrubFrame: number | null = null;

	const displayedTime = $derived(scrubDisplayTime(scrubbing, hoverTime, currentTime));
	const playedPct = $derived(duration > 0 ? (displayedTime / duration) * 100 : 0);
	const buffered = $derived.by(() => {
		// Re-read when the clock or the drag moves; fresh enough for a fill bar.
		void currentTime;
		void hoverTime;
		void scrubbing;
		const m = media;
		if (!m || !(duration > 0)) return [];
		const out: Array<{ left: number; width: number }> = [];
		try {
			const ranges = m.buffered;
			for (let i = 0; i < ranges.length; i++) {
				const from = Math.max(0, ranges.start(i));
				const to = Math.min(duration, ranges.end(i));
				if (to > from) out.push({ left: (from / duration) * 100, width: ((to - from) / duration) * 100 });
			}
		} catch {
			/* the element has no data yet */
		}
		return out;
	});

	function issueSeek(target: number) {
		const next = clampScrubTarget(target, duration);
		currentTime = next;
		if (media) {
			try {
				if (media.currentTime !== next) media.currentTime = next;
			} catch {
				/* seek failures resolve on the next tick */
			}
		}
	}

	function cancelScrubFrame() {
		if (scrubFrame !== null) cancelAnimationFrame(scrubFrame);
		scrubFrame = null;
	}

	function resumeScrubPlayback() {
		if (scrubbing || !resumeAfterScrub) return;
		resumeAfterScrub = false;
		void media?.play().catch(() => {});
	}

	function flushScrubSeek(final = false) {
		if (pendingSeek === null) return;
		const m = media;
		// Let an in-flight seek decode its frame before replacing it;
		// continually replacing an unfinished seek leaves the frame frozen.
		// A deferred release stays queued until the seek finishes (seeked) or
		// metadata arrives, which flushes it.
		if (m && shouldDeferScrubSeek({ seeking: m.seeking, readyState: m.readyState }, final)) return;
		const target = pendingSeek;
		pendingSeek = null;
		issueSeek(target);
		resumeScrubPlayback();
	}

	function scheduleScrubSeek() {
		if (scrubFrame !== null) return;
		scrubFrame = requestAnimationFrame(() => {
			scrubFrame = null;
			flushScrubSeek();
		});
	}

	function resetScrub() {
		cancelScrubFrame();
		pendingSeek = null;
		scrubPointerId = null;
		scrubbing = false;
		hoverTime = null;
		resumeAfterScrub = false;
	}

	function timeAt(clientX: number): number {
		if (!track || !(duration > 0)) return 0;
		const box = track.getBoundingClientRect();
		if (box.width <= 0) return 0;
		return clampScrubTarget(((clientX - box.left) / box.width) * duration, duration);
	}

	function onTrackDown(e: PointerEvent) {
		if (!(duration > 0) || e.button !== 0 || scrubbing) return;
		e.preventDefault();
		track?.focus({ preventScroll: true });
		scrubbing = true;
		scrubPointerId = e.pointerId;
		resumeAfterScrub = !!media && !media.paused && !media.ended;
		if (resumeAfterScrub) media?.pause();
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		hoverTime = timeAt(e.clientX);
		pendingSeek = hoverTime;
		flushScrubSeek();
	}

	function onTrackMove(e: PointerEvent) {
		if (scrubbing && e.pointerId !== scrubPointerId) return;
		if (!(duration > 0)) return;
		hoverTime = timeAt(e.clientX);
		if (scrubbing) {
			pendingSeek = hoverTime;
			scheduleScrubSeek();
		}
	}

	function onTrackUp(e: PointerEvent) {
		if (!scrubbing || e.pointerId !== scrubPointerId) return;
		scrubbing = false;
		scrubPointerId = null;
		hoverTime = timeAt(e.clientX);
		pendingSeek = hoverTime;
		cancelScrubFrame();
		flushScrubSeek(true);
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
	}

	function onTrackCancel(e: PointerEvent) {
		if (!scrubbing || e.pointerId !== scrubPointerId) return;
		scrubbing = false;
		scrubPointerId = null;
		cancelScrubFrame();
		if (pendingSeek !== null) flushScrubSeek(true);
		else resumeScrubPlayback();
		hoverTime = null;
	}

	function onTrackKey(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			pendingSeek = clampScrubTarget(displayedTime - 5, duration);
			flushScrubSeek(true);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			pendingSeek = clampScrubTarget(displayedTime + 5, duration);
			flushScrubSeek(true);
		} else if (e.key === 'Home') {
			e.preventDefault();
			pendingSeek = 0;
			flushScrubSeek(true);
		} else if (e.key === 'End' && duration > 0) {
			e.preventDefault();
			pendingSeek = duration;
			flushScrubSeek(true);
		}
	}

	// A new clip mid-drag starts a new scrub; stale targets must not land in it.
	$effect(() => {
		void duration;
		untrack(resetScrub);
	});

	// A finishing seek unblocks the drag's queued position.
	$effect(() => {
		const m = media;
		if (!m) return;
		const onReady = () => {
			if (pendingSeek !== null) scheduleScrubSeek();
		};
		m.addEventListener('seeked', onReady);
		m.addEventListener('loadedmetadata', onReady);
		return () => {
			m.removeEventListener('seeked', onReady);
			m.removeEventListener('loadedmetadata', onReady);
		};
	});

	onDestroy(resetScrub);
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
		<span class="time">{format(displayedTime)}</span>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="seek-track"
			bind:this={track}
			role="slider"
			tabindex="0"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={Math.floor(duration || 0)}
			aria-valuenow={Math.floor(displayedTime)}
			aria-valuetext={format(displayedTime)}
			data-testid={testid ? `${testid}-seek` : undefined}
			onpointerdown={onTrackDown}
			onpointermove={onTrackMove}
			onpointerup={onTrackUp}
			onpointercancel={onTrackCancel}
			onlostpointercapture={onTrackCancel}
			onpointerleave={() => {
				if (!scrubbing) hoverTime = null;
			}}
			onkeydown={onTrackKey}
		>
			<div class="seek-rail">
				{#each buffered as seg, i (i)}
					<div class="seek-buffered" style="left:{seg.left}%;width:{seg.width}%"></div>
				{/each}
				<div class="seek-played" style="width:{playedPct}%"></div>
			</div>
			{#if hoverTime !== null && duration > 0}
				<div class="seek-hover" style="left:{(hoverTime / duration) * 100}%">{format(hoverTime)}</div>
			{/if}
		</div>
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

	/* Scrub track: pointer-drag seeking with buffered and played fills. */
	.seek-track {
		position: relative;
		flex: 1;
		min-width: 0;
		height: 18px;
		display: flex;
		align-items: center;
		cursor: ew-resize;
		touch-action: none;
		outline: none;
	}
	.seek-track:focus-visible {
		box-shadow: 0 0 0 2px var(--accent, #38bdf8);
		border-radius: var(--radius-2xs);
	}
	.seek-rail {
		position: relative;
		width: 100%;
		height: 4px;
		border-radius: var(--radius-2xs);
		background: rgb(255 255 255 / 0.22);
		overflow: hidden;
	}
	.seek-buffered {
		position: absolute;
		top: 0;
		bottom: 0;
		background: rgb(255 255 255 / 0.28);
	}
	.seek-played {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		background: var(--accent, #38bdf8);
	}
	.seek-hover {
		position: absolute;
		top: -18px;
		transform: translateX(-50%);
		font-size: 0.68rem;
		font-family: monospace;
		white-space: nowrap;
		padding: 1px 5px;
		border-radius: var(--radius-2xs);
		background: rgb(0 0 0 / 0.75);
		color: #fff;
		pointer-events: none;
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
		transition: transform var(--transition-fast);
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
	.flat .seek-rail {
		background: rgba(var(--border-rgb, 128, 128, 128), 0.35);
	}
	.flat .speed-control {
		gap: 6px;
	}
	.flat .speed-slider {
		width: 72px;
	}
</style>
