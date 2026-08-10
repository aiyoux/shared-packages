/**
 * Burst coalescing with a ceiling.
 *
 * A plain trailing debounce restarts on every call, so under continuous input —
 * a build, an `npm install`, an rsync — it never fires at all and whatever it
 * drives stays stale for as long as the churn lasts. The ceiling bounds that:
 * the callback is delayed at most `maxDebounceMs` past the oldest un-delivered
 * call, however long the burst runs.
 */

export type Coalescer = {
	/** Register a change; runs the callback once the burst settles or the ceiling hits. */
	fire(): void;
	/** Drop anything pending without running the callback. */
	cancel(): void;
	/** True while a call is pending. */
	pending(): boolean;
};

export type CoalesceOptions = {
	/** Quiet period that ends a burst (default 150ms). */
	debounceMs?: number;
	/** Longest the callback may be delayed past the oldest pending call (default 1s). */
	maxDebounceMs?: number;
};

export function createCoalescer(fn: () => void, opts: CoalesceOptions = {}): Coalescer {
	const debounceMs = opts.debounceMs ?? 150;
	// Never below debounceMs: a ceiling under the quiet period would fire mid-burst
	// on every call, which is the opposite of coalescing.
	const maxDebounceMs = Math.max(debounceMs, opts.maxDebounceMs ?? 1_000);

	let timer: ReturnType<typeof setTimeout> | null = null;
	/** When the oldest un-delivered call arrived; 0 when nothing is pending. */
	let pendingSince = 0;

	return {
		fire() {
			const now = Date.now();
			if (pendingSince === 0) pendingSince = now;
			const delay = Math.min(debounceMs, Math.max(0, maxDebounceMs - (now - pendingSince)));
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				pendingSince = 0;
				fn();
			}, delay);
		},
		cancel() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			pendingSince = 0;
		},
		pending() {
			return timer !== null;
		}
	};
}
