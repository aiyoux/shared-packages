import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderElection } from '../src/live/leader.ts';
import { liveDocNames } from '../src/live/names.ts';

/**
 * A real FIFO Web Locks stand-in.
 *
 * modular-app's leader test polyfills a grant-immediately single-holder lock
 * and leaves contention to e2e. Queue behaviour is the whole point of our
 * design (M1: the queue IS the failover), so this models it properly —
 * promotion-on-release is then unit-testable instead of only observable in a
 * browser.
 */
type Waiter = { signal?: AbortSignal; cb: (lock: unknown) => Promise<void> | void; done: () => void };

function installLockPolyfill(): { held: Map<string, boolean>; reset: () => void } {
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
		// calls back inside `request()`, and granting synchronously would let
		// a caller miss its own first leadership notification.
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
		request(name: string, options: { signal?: AbortSignal }, cb: (lock: unknown) => Promise<void> | void) {
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

	return { held, reset: () => { queues.clear(); held.clear(); } };
}

const listeners = new Set<() => void>();
function installWindow(): void {
	(globalThis as { window?: unknown }).window = {
		addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn)
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let lockEnv: ReturnType<typeof installLockPolyfill>;

beforeEach(() => {
	installWindow();
	lockEnv = installLockPolyfill();
});

afterEach(() => {
	lockEnv.reset();
	listeners.clear();
});

describe('liveDocNames', () => {
	it('derives lock and channel together from one id', () => {
		const a = liveDocNames('node-1');
		assert.match(a.lockName, /node-1/);
		assert.match(a.channelName, /node-1/);
		assert.notEqual(a.lockName, a.channelName);
		assert.deepEqual(liveDocNames('node-1'), a);
		assert.notEqual(liveDocNames('node-2').lockName, a.lockName);
	});

	it('throws on an empty id rather than pairing every caller together', () => {
		assert.throws(() => liveDocNames(''), /nodeId is required/);
		assert.throws(() => liveDocNames('   '), /nodeId is required/);
	});
});

describe('createLeaderElection', () => {
	it('the first contender becomes leader and bumps the session id', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		assert.equal(a.isLeader, true);
		assert.equal(a.leaderSessionId, 1);
		a.destroy();
	});

	it('a second contender waits, then is promoted when the leader dies (M1)', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		const b = createLeaderElection('doc-1');
		await tick();

		assert.equal(a.isLeader, true);
		assert.equal(b.isLeader, false, 'second contender must wait in the queue');

		// The holder's tab goes away. No heartbeat, no timeout — the queue
		// advances on its own.
		a.destroy();
		await tick();

		assert.equal(b.isLeader, true, 'follower must be promoted automatically');
		assert.equal(b.leaderSessionId, 1);
		b.destroy();
	});

	it('leaderSessionId increments per term, so stale terms are detectable (M2)', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		assert.equal(a.leaderSessionId, 1);

		a.release();
		await tick();
		assert.equal(a.isLeader, false);

		a.resumeAcquire();
		await tick();
		assert.equal(a.isLeader, true);
		assert.equal(a.leaderSessionId, 2, 'a regained term must be distinguishable from the first');
		a.destroy();
	});

	it('release() stays released until resumeAcquire() (M5)', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		a.release();
		await tick();
		await tick();
		assert.equal(a.isLeader, false, 'release must not silently re-acquire');
		a.resumeAcquire();
		await tick();
		assert.equal(a.isLeader, true);
		a.destroy();
	});

	it('yieldLeadership() hands over to a waiting tab and re-queues behind it (M4)', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		const b = createLeaderElection('doc-1');
		await tick();
		assert.equal(a.isLeader, true);
		assert.equal(b.isLeader, false);

		a.yieldLeadership();
		await tick();

		assert.equal(b.isLeader, true, 'the waiting tab takes over');
		assert.equal(a.isLeader, false, 'the yielding tab steps down');

		// ...and is still contending, so it regains the lock when b leaves.
		b.destroy();
		await tick();
		assert.equal(a.isLeader, true, 'yield is a defer, not a permanent give-up');
		a.destroy();
	});

	it('yieldLeadership() on a sole contender simply re-acquires', async () => {
		const a = createLeaderElection('doc-1');
		await tick();
		a.yieldLeadership();
		await tick();
		assert.equal(a.isLeader, true);
		assert.equal(a.leaderSessionId, 2);
		a.destroy();
	});

	it('a re-entrant release() from an onChange handler still frees the lock (M3)', async () => {
		const a = createLeaderElection('doc-1');
		// Abort synchronously from inside the leadership notification — if the
		// abort listener were armed after notify, this abort is missed and the
		// lock is never released.
		const off = a.onChange(() => {
			if (a.isLeader) a.release();
		});
		await tick();
		off();

		const { lockName } = liveDocNames('doc-1');
		assert.equal(lockEnv.held.get(lockName) ?? false, false, 'lock must not be stranded');

		// Proof the queue still works: a fresh contender gets in.
		const b = createLeaderElection('doc-1');
		await tick();
		assert.equal(b.isLeader, true);
		b.destroy();
		a.destroy();
	});

	it('separate documents do not contend with each other (M22)', async () => {
		const a = createLeaderElection('doc-1');
		const b = createLeaderElection('doc-2');
		await tick();
		assert.equal(a.isLeader, true);
		assert.equal(b.isLeader, true, 'per-document locks, not one lock per tab');
		a.destroy();
		b.destroy();
	});

	it('falls back to sole ownership when Web Locks are unavailable', async () => {
		const nav = (globalThis as unknown as { navigator?: Record<string, unknown> }).navigator!;
		const saved = nav.locks;
		try {
			Object.defineProperty(nav, 'locks', { value: undefined, configurable: true, writable: true });
			const a = createLeaderElection('doc-1');
			await tick();
			assert.equal(a.isLeader, true, 'degrade to today behaviour rather than never syncing');
			a.destroy();
		} finally {
			Object.defineProperty(nav, 'locks', { value: saved, configurable: true, writable: true });
		}
	});

	it('tab id is stable across elections and not read from sessionStorage (M6)', async () => {
		const a = createLeaderElection('doc-1');
		const b = createLeaderElection('doc-2');
		await tick();
		assert.equal(a.tabId, b.tabId, 'one id per browsing context');
		assert.notEqual(a.tabId, 'server');
		a.destroy();
		b.destroy();
	});
});
