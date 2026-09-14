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
	fail: (e: unknown) => void;
	/** Set when the lock was stolen: this holder's later release means nothing. */
	broken?: boolean;
};

type RequestOptions = { signal?: AbortSignal; ifAvailable?: boolean; steal?: boolean };

function abortError(message: string): Error {
	return Object.assign(new Error(message), { name: 'AbortError' });
}

export type LockHarness = { held: Map<string, boolean>; reset: () => void };

export function installLockPolyfill(): LockHarness {
	const queues = new Map<string, Waiter[]>();
	const held = new Map<string, boolean>();
	const holders = new Map<string, Waiter>();

	/**
	 * `steal: true` releases the current holder and rejects the promise its
	 * `request()` returned with an AbortError. Modelling that is the point:
	 * the rejection is the only notice the victim gets, so code that ignores
	 * it must be able to fail a test.
	 */
	function breakHolder(name: string): void {
		const cur = holders.get(name);
		if (!cur) return;
		cur.broken = true;
		holders.delete(name);
		held.set(name, false);
		cur.fail(abortError('lock stolen'));
	}

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
		holders.set(name, next);
		queueMicrotask(() => {
			// The callback's promise resolving is what releases the lock.
			void Promise.resolve(next.cb(name)).then(() => {
				if (next.broken) return;
				holders.delete(name);
				held.set(name, false);
				next.done();
				pump(name);
			});
		});
	}

	const locks = {
		request(
			name: string,
			options: RequestOptions,
			cb: (lock: unknown) => Promise<void> | void
		) {
			return new Promise<void>((resolve, reject) => {
				// A probe never waits: held means "no", answered with a null lock.
				if (options?.ifAvailable && held.get(name)) {
					queueMicrotask(() => {
						void Promise.resolve(cb(null)).then(() => resolve());
					});
					return;
				}
				if (options?.steal) breakHolder(name);
				const waiter: Waiter = {
					signal: options?.signal,
					cb,
					done: () => resolve(),
					fail: reject
				};
				const q = queues.get(name) ?? [];
				// A steal preempts everything already queued for the lock.
				if (options?.steal) q.unshift(waiter);
				else q.push(waiter);
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
								// Real Web Locks rejects an abandoned request
								// with AbortError; a silent resolve would let a
								// caller that ignores the rejection pass.
								waiter.fail(abortError('lock request aborted'));
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
			holders.clear();
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

/**
 * Page lifecycle events (`freeze`, `pagehide`) as an injectable
 * target, so a stand-down can be driven deterministically instead of waiting
 * for a real browser to background a tab.
 */
export function createFakeLifecycle(): {
	target: {
		addEventListener(type: string, fn: (ev: Event) => void): void;
		removeEventListener(type: string, fn: (ev: Event) => void): void;
	};
	fire(type: string, ev?: Record<string, unknown>): void;
	count(type: string): number;
} {
	const byType = new Map<string, Array<(ev: Event) => void>>();
	return {
		target: {
			addEventListener(type, fn) {
				byType.set(type, [...(byType.get(type) ?? []), fn]);
			},
			removeEventListener(type, fn) {
				byType.set(type, (byType.get(type) ?? []).filter((f) => f !== fn));
			}
		},
		fire(type, ev) {
			for (const fn of [...(byType.get(type) ?? [])]) fn((ev ?? {}) as unknown as Event);
		},
		count: (type) => (byType.get(type) ?? []).length
	};
}
