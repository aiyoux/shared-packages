/**
 * Test harness for the live-document layer: a real FIFO Web Locks stand-in
 * plus a minimal `window`.
 *
 * modular-app's leader test polyfills a grant-immediately single-holder lock
 * and leaves contention to e2e. Queue behaviour is the whole point of our
 * design (M1: the queue IS the failover), so this models it properly, which
 * makes promotion-on-death unit-testable instead of browser-only.
 */

type Waiter = {
	signal?: AbortSignal;
	cb: (lock: unknown) => Promise<void> | void;
	done: () => void;
};

export type LockHarness = { held: Map<string, boolean>; reset: () => void };

export function installLockPolyfill(): LockHarness {
	const queues = new Map<string, Waiter[]>();
	const held = new Map<string, boolean>();

	function pump(name: string): void {
		if (held.get(name)) return;
		const q = queues.get(name);
		if (!q || q.length === 0) return;
		const next = q.shift()!;
		if (next.signal?.aborted) {
			next.done();
			pump(name);
			return;
		}
		// Reserve synchronously so a re-entrant pump cannot double-grant, but
		// invoke the callback asynchronously — the real Web Locks API never
		// calls back inside `request()`, and granting synchronously would let a
		// caller miss its own first leadership notification (which silently
		// made the M3 regression test vacuous).
		held.set(name, true);
		queueMicrotask(() => {
			// The callback's promise resolving is what releases the lock.
			void Promise.resolve(next.cb(name)).then(() => {
				held.set(name, false);
				next.done();
				pump(name);
			});
		});
	}

	const locks = {
		request(
			name: string,
			options: { signal?: AbortSignal },
			cb: (lock: unknown) => Promise<void> | void
		) {
			return new Promise<void>((resolve) => {
				const waiter: Waiter = { signal: options?.signal, cb, done: () => resolve() };
				const q = queues.get(name) ?? [];
				q.push(waiter);
				queues.set(name, q);
				// Leaving the queue while still waiting must not strand later waiters.
				options?.signal?.addEventListener(
					'abort',
					() => {
						const cur = queues.get(name);
						if (cur) {
							const i = cur.indexOf(waiter);
							if (i >= 0) {
								cur.splice(i, 1);
								waiter.done();
							}
						}
						pump(name);
					},
					{ once: true }
				);
				pump(name);
			});
		}
	};

	const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator;
	if (nav) Object.defineProperty(nav, 'locks', { value: locks, configurable: true, writable: true });
	else (globalThis as unknown as { navigator: Record<string, unknown> }).navigator = { locks };

	return {
		held,
		reset: () => {
			queues.clear();
			held.clear();
		}
	};
}

const windowListeners = new Set<() => void>();

export function installWindow(): void {
	(globalThis as { window?: unknown }).window = {
		addEventListener: (_t: string, fn: () => void) => windowListeners.add(fn),
		removeEventListener: (_t: string, fn: () => void) => windowListeners.delete(fn)
	};
}

export function clearWindowListeners(): void {
	windowListeners.clear();
}

/** Yield past pending microtasks (lock grants resolve on those). */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `fn()` is true or the deadline passes. */
export async function until(fn: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn() && Date.now() < deadline) await wait(5);
}
