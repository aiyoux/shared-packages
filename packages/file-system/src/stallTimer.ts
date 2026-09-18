/**
 * Stall-based abort for active transfers.
 *
 * A fixed total timeout kills a transfer that is making progress — a slow
 * link is not a dead one. A stall timer does the opposite of the naive
 * `setTimeout(() => ac.abort(), ms)`: the window restarts on every `bump()`
 * (a progress tick, a completed chunk) and aborts only when a transfer has
 * gone quiet for the whole window. Handshake/metadata calls keep plain fixed
 * timeouts; anything that streams bytes gets one of these.
 */

export type StallTimer = {
	/** Restart the stall window — call on every progress tick. */
	bump: () => void;
	/** Stop the timer without aborting the signal. */
	dispose: () => void;
	/** Fires when the transfer stalls, or when the outer signal aborts. */
	signal: AbortSignal;
};

export class StallError extends Error {
	constructor(label: string, stallMs: number) {
		super(`${label} stalled — no progress for ${Math.round(stallMs / 1000)}s`);
		this.name = 'StallError';
	}
}

export function createStallTimer(
	stallMs: number,
	outer?: AbortSignal,
	label = 'transfer'
): StallTimer {
	// stallMs <= 0 disables the stall window entirely: the signal still
	// mirrors the outer abort so callers can compose one way of cancelling.
	const ac = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const fire = () => {
		timer = null;
		ac.abort(new StallError(label, stallMs));
	};

	const restart = () => {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = stallMs > 0 ? setTimeout(fire, stallMs) : null;
	};

	const onOuterAbort = () => {
		disposed = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		ac.abort(outer?.reason);
	};

	if (outer) {
		if (outer.aborted) onOuterAbort();
		else outer.addEventListener('abort', onOuterAbort, { once: true });
	}
	restart();

	return {
		bump: restart,
		dispose() {
			disposed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
		signal: ac.signal
	};
}