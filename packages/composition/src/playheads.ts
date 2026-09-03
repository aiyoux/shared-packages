import { createCompositionClock, type CompositionClock } from './clock.js';

/**
 * A refcounted registry of independent playheads ("clocks") over one
 * document. Hosts attach windows/views to a clock by id — views sharing an
 * id are linked (same playhead), views with different ids scrub
 * independently. Clocks are created lazily on first `acquire` and disposed
 * when the last reference is released.
 *
 * Deliberately rune-free plain TS (like the rest of this package): hosts
 * mirror clock state into their own reactive stores via `subscribe`.
 */
export type PlayheadRegistry = {
	/** Get or create the clock for `clockId`, bumping its reference count. */
	acquire(clockId: string, durationMs: number): CompositionClock;
	/** Drop one reference; the clock is disposed and removed at zero. */
	release(clockId: string): void;
	get(clockId: string): CompositionClock | undefined;
	/** Clock ids in creation order — hosts derive stable numbering from this. */
	ids(): string[];
	/** Propagate a document duration change to every live clock. */
	setDurationAll(durationMs: number): void;
	disposeAll(): void;
};

export function createPlayheadRegistry(opts?: {
	createClock?: (durationMs: number) => CompositionClock;
}): PlayheadRegistry {
	const createClock = opts?.createClock ?? createCompositionClock;
	const clocks = new Map<string, { clock: CompositionClock; refs: number }>();

	return {
		acquire(clockId, durationMs) {
			const existing = clocks.get(clockId);
			if (existing) {
				existing.refs += 1;
				return existing.clock;
			}
			const clock = createClock(durationMs);
			clocks.set(clockId, { clock, refs: 1 });
			return clock;
		},
		release(clockId) {
			const entry = clocks.get(clockId);
			if (!entry) return;
			entry.refs -= 1;
			if (entry.refs <= 0) {
				entry.clock.dispose();
				clocks.delete(clockId);
			}
		},
		get(clockId) {
			return clocks.get(clockId)?.clock;
		},
		ids() {
			return Array.from(clocks.keys());
		},
		setDurationAll(durationMs) {
			for (const { clock } of clocks.values()) clock.setDuration(durationMs);
		},
		disposeAll() {
			for (const { clock } of clocks.values()) clock.dispose();
			clocks.clear();
		}
	};
}