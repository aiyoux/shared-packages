/**
 * Per-document leader election over the Web Locks API.
 *
 * One tab holds the lock for a given document and owns its state; every other
 * tab sits in the lock QUEUE. That queue is the entire failover mechanism: when
 * the holder's tab dies the browser hands the lock to the next waiter on its
 * own, so there is no heartbeat, no liveness timeout, and no re-election code
 * to get wrong.
 *
 * This is why acquisition uses `{ signal }` and holds the lock inside the
 * callback, rather than probing with `{ ifAvailable: true }`. A probe tells you
 * "no" once and leaves you to poll. (M1 in `docs/design/live-documents.md`.)
 *
 * Ported from ~/Code/modular-app `module-sdk/src/sync/leader.svelte.ts`, with
 * its hazard comments carried across — they are the value. Two deliberate
 * differences: leadership here is per-document rather than per-tab (M22,
 * documents open and close independently), and this is plain TS with an
 * `onChange` subscription rather than Svelte runes, so it is testable under
 * node:test without a compiler.
 */

import { liveDocNames } from './names.js';

export type LeaderElection = {
	/** True while this context holds the document's lock. */
	readonly isLeader: boolean;
	/** Stable per-tab id. Never persisted — see `getTabId`. */
	readonly tabId: string;
	/**
	 * Increments on every acquisition. A fencing token: messages and RPC
	 * replies stamped with an older session id belong to a previous leadership
	 * term and must be discarded, which `seq` alone cannot express (M2).
	 */
	readonly leaderSessionId: number;
	/** Suspend: drop out of the queue and stay out until `resumeAcquire()`. */
	release(): void;
	/** Re-enter the queue after `release()`. No-op unless suspended. */
	resumeAcquire(): void;
	/** Defer to a waiting tab without giving up permanently (M4). */
	yieldLeadership(): void;
	destroy(): void;
	onChange(handler: () => void): () => void;
};

type LockManagerLike = {
	request(
		name: string,
		options: { signal?: AbortSignal },
		callback: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
};

let tabId: string | null = null;

/**
 * One id per live browsing context.
 *
 * Deliberately NOT sessionStorage: Chrome's "Duplicate tab" clones
 * sessionStorage, so two tabs would share an id and filter each other's
 * broadcasts as self-sent — the sync silently half-works (M6).
 */
function getTabId(): string {
	if (tabId) return tabId;
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	tabId = typeof c?.randomUUID === 'function' ? c.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;
	return tabId;
}

function getLocks(): LockManagerLike | null {
	const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
	return typeof nav?.locks?.request === 'function' ? nav.locks : null;
}

/** Inert shape for SSR, where there are no tabs to coordinate. */
function inertElection(): LeaderElection {
	return {
		isLeader: false,
		tabId: 'server',
		leaderSessionId: 0,
		release: () => {},
		resumeAcquire: () => {},
		yieldLeadership: () => {},
		destroy: () => {},
		onChange: () => () => {}
	};
}

export function createLeaderElection(nodeId: string): LeaderElection {
	if (typeof window === 'undefined') return inertElection();

	const { lockName } = liveDocNames(nodeId);
	const myTabId = getTabId();
	let isLeader = false;
	let leaderSessionId = 0;
	let handlers: Array<() => void> = [];
	let destroyed = false;
	let abortController = new AbortController();

	function notify(): void {
		for (const h of [...handlers]) {
			try {
				h();
			} catch {
				/* one bad subscriber must not stop the others */
			}
		}
	}

	function becomeLeader(): void {
		isLeader = true;
		leaderSessionId += 1;
		notify();
	}

	function acquireLock(): void {
		if (destroyed) return;
		const locks = getLocks();

		if (!locks) {
			// No Web Locks (very old browser, or a non-browser embedder). We
			// cannot coordinate, so assume sole ownership: a single tab keeps
			// working, and two tabs degrade to exactly today's behaviour —
			// both write, and the VFS generation check rejects the loser with
			// the existing conflict prompt. Degraded-but-live beats inert.
			if (!isLeader) becomeLeader();
			return;
		}

		void locks
			.request(lockName, { signal: abortController.signal }, () => {
				if (destroyed || abortController.signal.aborted) return Promise.resolve();

				// Hold the lock until aborted. Resolving this promise is what
				// releases it, so the queue only advances when we let go.
				return new Promise<void>((resolve) => {
					const onAbort = () => {
						isLeader = false;
						notify();
						resolve();
					};

					// Arm the abort listener BEFORE notifying. A re-entrant
					// release()/yieldLeadership() from an onChange handler
					// aborts synchronously; notify first and that abort is
					// missed — the lock is then never released and every other
					// tab waits forever (M3).
					if (abortController.signal.aborted) {
						onAbort();
						return;
					}
					abortController.signal.addEventListener('abort', onAbort, { once: true });

					becomeLeader();
				});
			})
			.catch((err: unknown) => {
				const name = (err as { name?: string } | null)?.name;
				// AbortError is the expected exit when we leave the queue.
				if (name !== 'AbortError') console.error('live-doc lock request failed', err);
			});
	}

	function release(): void {
		if (!abortController.signal.aborted) abortController.abort();
	}

	/**
	 * Re-enter the queue after `release()`. Distinct from `yieldLeadership()`:
	 * release-and-stay-released is a suspend, this is the resume half of that
	 * pair. Conflating the two is a subtle lifecycle bug (M5).
	 */
	function resumeAcquire(): void {
		if (destroyed) return;
		if (!abortController.signal.aborted) return; // already queued or holding
		abortController = new AbortController();
		acquireLock();
	}

	/**
	 * Hand leadership to another waiting tab without giving it up for good:
	 * release the lock and immediately rejoin the queue at the BACK. Any tab
	 * already waiting is ahead of us and takes over; if we are the only
	 * contender we simply re-acquire.
	 *
	 * Used when a backgrounded leader is asked to defer to a visible tab, whose
	 * un-throttled timers can drive the document promptly (M4).
	 */
	function yieldLeadership(): void {
		if (destroyed || !isLeader) return;
		abortController.abort();
		abortController = new AbortController();
		acquireLock();
	}

	function onBeforeUnload(): void {
		release();
	}

	window.addEventListener('beforeunload', onBeforeUnload);

	function destroy(): void {
		destroyed = true;
		window.removeEventListener('beforeunload', onBeforeUnload);
		release();
		handlers = [];
	}

	acquireLock();

	return {
		get isLeader() {
			return isLeader;
		},
		get tabId() {
			return myTabId;
		},
		get leaderSessionId() {
			return leaderSessionId;
		},
		release,
		resumeAcquire,
		yieldLeadership,
		destroy,
		onChange(handler: () => void) {
			handlers.push(handler);
			return () => {
				handlers = handlers.filter((h) => h !== handler);
			};
		}
	};
}
