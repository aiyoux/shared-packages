import type { ClockState, CompositionClock } from './types.js';

function clampTime(timeMs: number, durationMs: number): number {
	if (!Number.isFinite(timeMs)) return 0;
	if (timeMs < 0) return 0;
	if (timeMs > durationMs) return durationMs;
	return timeMs;
}

function normalizeDuration(durationMs: number): number {
	if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
	return durationMs;
}

/**
 * Media-independent playhead. Times are milliseconds.
 * `seek` while playing rebases the `performance.now` origin so the next rAF
 * continues from the new time instead of jumping back to the old trajectory.
 */
export function createCompositionClock(durationMs: number): CompositionClock {
	let duration = normalizeDuration(durationMs);
	let timeMs = 0;
	let playing = false;
	let rate = 1;
	let origin = 0;
	let rafId: number | null = null;
	const listeners = new Set<(s: ClockState) => void>();

	function snapshot(): ClockState {
		return { timeMs, durationMs: duration, playing, rate };
	}

	function emit(): void {
		const state = snapshot();
		for (const fn of [...listeners]) fn(state);
	}

	function cancelTick(): void {
		if (rafId == null) return;
		cancelAnimationFrame(rafId);
		rafId = null;
	}

	function rebaseOrigin(now = performance.now()): void {
		origin = now - timeMs / rate;
	}

	function tick(now: number): void {
		if (!playing) return;
		timeMs = clampTime((now - origin) * rate, duration);
		if (timeMs >= duration) {
			timeMs = duration;
			playing = false;
			rafId = null;
			emit();
			return;
		}
		emit();
		rafId = requestAnimationFrame(tick);
	}

	function play(): void {
		if (playing) return;
		if (timeMs >= duration) timeMs = 0;
		playing = true;
		rebaseOrigin();
		emit();
		rafId = requestAnimationFrame(tick);
	}

	function pause(): void {
		if (!playing) return;
		playing = false;
		cancelTick();
		emit();
	}

	function seek(nextMs: number): void {
		timeMs = clampTime(nextMs, duration);
		if (playing) rebaseOrigin();
		emit();
	}

	function setDuration(next: number): void {
		duration = normalizeDuration(next);
		timeMs = clampTime(timeMs, duration);
		if (playing) {
			if (timeMs >= duration) {
				timeMs = duration;
				playing = false;
				cancelTick();
			} else {
				rebaseOrigin();
			}
		}
		emit();
	}

	function setRate(next: number): void {
		if (!Number.isFinite(next) || next <= 0) return;
		rate = next;
		if (playing) rebaseOrigin();
		emit();
	}

	function dispose(): void {
		playing = false;
		cancelTick();
		listeners.clear();
	}

	return {
		get: snapshot,
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot());
			return () => {
				listeners.delete(fn);
			};
		},
		play,
		pause,
		seek,
		setDuration,
		setRate,
		dispose
	};
}
