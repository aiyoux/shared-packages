import { quadsClose } from './geometry.js';
import type { Quad, QuadLockStatus } from './types.js';

export type QuadLockOptions = {
	/** Consecutive close frames required. */
	needed?: number;
	/** Max corner motion as a fraction of min(frame w,h). */
	maxMoveRatio?: number;
	/** Missed frames allowed before the lock resets. */
	maxMisses?: number;
	/** Close frames of a *new* quad before the overlay is allowed to jump. */
	switchNeeded?: number;
};

function lerpQuad(a: Quad, b: Quad, t: number): Quad {
	const mix = (i: number) => ({
		x: a[i]!.x + (b[i]!.x - a[i]!.x) * t,
		y: a[i]!.y + (b[i]!.y - a[i]!.y) * t
	});
	return [mix(0), mix(1), mix(2), mix(3)];
}

/**
 * Tracks a live quad until it sits still long enough to auto-capture.
 * The overlay holds the last stable quad when detection jumps — noisy
 * frames must agree with each other before the handles are allowed to move.
 */
export class QuadLock {
	private needed: number;
	private maxMoveRatio: number;
	private maxMisses: number;
	private switchNeeded: number;
	private streak = 0;
	private misses = 0;
	private last: Quad | null = null;
	private candidate: Quad | null = null;
	private candStreak = 0;

	constructor(opts: QuadLockOptions = {}) {
		this.needed = opts.needed ?? 8;
		this.maxMoveRatio = opts.maxMoveRatio ?? 0.04;
		this.maxMisses = opts.maxMisses ?? 2;
		this.switchNeeded = opts.switchNeeded ?? 3;
	}

	observe(quad: Quad | null, frameW: number, frameH: number): QuadLockStatus {
		if (!quad) {
			this.misses += 1;
			if (this.misses > this.maxMisses || !this.last) {
				this.streak = 0;
				this.last = null;
				this.candidate = null;
				this.candStreak = 0;
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
		if (!this.last) {
			this.last = quad;
			this.streak = 1;
			this.candidate = null;
			this.candStreak = 0;
			return { locked: false, progress: Math.min(1, this.streak / this.needed), quad };
		}
		if (quadsClose(this.last, quad, maxPx)) {
			this.streak += 1;
			this.last = lerpQuad(this.last, quad, 0.4);
			this.candidate = null;
			this.candStreak = 0;
			const progress = Math.min(1, this.streak / this.needed);
			return { locked: this.streak >= this.needed, progress, quad: this.last };
		}
		if (this.candidate && quadsClose(this.candidate, quad, maxPx)) {
			this.candStreak += 1;
			this.candidate = lerpQuad(this.candidate, quad, 0.5);
		} else {
			this.candidate = quad;
			this.candStreak = 1;
		}
		if (this.candStreak >= this.switchNeeded) {
			this.last = this.candidate;
			this.streak = this.candStreak;
			this.candidate = null;
			this.candStreak = 0;
			const progress = Math.min(1, this.streak / this.needed);
			return { locked: this.streak >= this.needed, progress, quad: this.last };
		}
		this.streak = 0;
		return { locked: false, progress: 0, quad: this.last };
	}

	reset() {
		this.streak = 0;
		this.misses = 0;
		this.last = null;
		this.candidate = null;
		this.candStreak = 0;
	}
}
