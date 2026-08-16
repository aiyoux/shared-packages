import { quadsClose } from './geometry.js';
import type { Quad, QuadLockStatus } from './types.js';

export type QuadLockOptions = {
	/** Consecutive close frames required. */
	needed?: number;
	/** Max corner motion as a fraction of min(frame w,h). */
	maxMoveRatio?: number;
	/** Missed frames allowed before the lock resets. */
	maxMisses?: number;
};

/**
 * Tracks a live quad until it sits still long enough to auto-capture.
 */
export class QuadLock {
	private needed: number;
	private maxMoveRatio: number;
	private maxMisses: number;
	private streak = 0;
	private misses = 0;
	private last: Quad | null = null;

	constructor(opts: QuadLockOptions = {}) {
		this.needed = opts.needed ?? 8;
		this.maxMoveRatio = opts.maxMoveRatio ?? 0.04;
		this.maxMisses = opts.maxMisses ?? 2;
	}

	observe(quad: Quad | null, frameW: number, frameH: number): QuadLockStatus {
		if (!quad) {
			this.misses += 1;
			if (this.misses > this.maxMisses || !this.last) {
				this.streak = 0;
				this.last = null;
				this.misses = 0;
				return { locked: false, progress: 0, quad: null };
			}
			return {
				locked: this.streak >= this.needed,
				progress: Math.min(1, this.streak / this.needed),
				quad: this.last
			};
		}
		this.misses = 0;
		const maxPx = Math.max(4, Math.min(frameW, frameH) * this.maxMoveRatio);
		if (this.last && quadsClose(this.last, quad, maxPx)) {
			this.streak += 1;
		} else {
			this.streak = 1;
		}
		this.last = quad;
		const progress = Math.min(1, this.streak / this.needed);
		return {
			locked: this.streak >= this.needed,
			progress,
			quad
		};
	}

	reset() {
		this.streak = 0;
		this.misses = 0;
		this.last = null;
	}
}
