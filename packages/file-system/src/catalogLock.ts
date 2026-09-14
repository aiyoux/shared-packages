/**
 * Acquisition of `vfs-catalog-sah`, the single lock that decides which tab
 * owns the catalog worker.
 *
 * Split out of `catalogEngine` because every hazard here is about *when* the
 * lock is dropped, and that is only testable if the lock manager and the page
 * lifecycle events can be faked (the same reason `live/leader.ts` is its own
 * module).
 *
 * One invariant holds the whole thing together:
 *
 *   **Never hold the lock while unable to answer a `who` ping.**
 *
 * A follower that cannot reach a leader is stuck, because the lock is the only
 * thing standing between it and leadership. Every hazard below is a way that
 * invariant used to break — on Android especially, where Chrome freezes
 * backgrounded tabs and a frozen holder starves every other tab on the origin.
 */

type LockOptions = { ifAvailable?: boolean; signal?: AbortSignal; steal?: boolean };

type LockManagerLike = {
	request(
		name: string,
		options: LockOptions,
		callback: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
};

export type LifecycleTarget = {
	addEventListener(type: string, fn: (ev: Event) => void): void;
	removeEventListener(type: string, fn: (ev: Event) => void): void;
};

/**
 * How hard to try for the lock.
 *
 * - default: probe with `ifAvailable` — answers "is it free right now?" and
 *   leaves the caller free to become a follower instead.
 * - `waitMs`: join the QUEUE for that long. The browser hands the lock over
 *   the instant the holder lets go, so a leader that closes or freezes is
 *   succeeded with no polling at all.
 * - `steal`: take it from whoever holds it. Last resort only — see H4.
 */
export type LockAttempt = { waitMs?: number; steal?: boolean };

export type CatalogLockDeps = {
	name: string;
	locks: LockManagerLike | null;
	lifecycle: LifecycleTarget | null;
	/** Bring the leader worker up. False means we cannot serve, so we let go. */
	start: () => Promise<boolean>;
	/** Clean teardown (pauseVfs, then terminate). Only awaited while JS still runs. */
	stop: () => Promise<void>;
	/** Synchronous teardown, for a context that will run no more JS. */
	abandon: () => void;
	/** Another tab stole the lock from us. Optional; for reporting only. */
	onStolen?: () => void;
};

export type CatalogLock = {
	/** True while this context holds the lock. */
	readonly held: boolean;
	/** Try to take leadership. Resolves true only if the worker also came up. */
	acquire(attempt?: LockAttempt): Promise<boolean>;
	/** Give leadership up. Teardown is the caller's business (H6). */
	release(): void;
};

export function createCatalogLock(deps: CatalogLockDeps): CatalogLock {
	let held = false;
	let releaseHold: (() => void) | null = null;
	let detachLifecycle: (() => void) | null = null;

	/** Drop the lock. Resolving the callback's promise is what releases it. */
	function letGo(): void {
		detachLifecycle?.();
		detachLifecycle = null;
		held = false;
		const release = releaseHold;
		releaseHold = null;
		release?.();
	}

	/**
	 * Stand down where there is no time to negotiate: the lock goes first and
	 * synchronously, because anything after that line may never run.
	 */
	function standDownNow(): void {
		letGo();
		deps.abandon();
	}

	/**
	 * H3 — the page is still running JS, so spend it: `stop()` lets the worker
	 * `pauseVfs` and release the SAH pool before the next leader tries to
	 * install one. Releasing first would hand the lock to a tab that then
	 * cannot open the files, which reads to the user as a broken catalog
	 * rather than a handover.
	 */
	function leaveCleanly(): void {
		void deps.stop().finally(letGo);
	}

	function attachLifecycle(): void {
		const target = deps.lifecycle;
		if (!target) return;

		/**
		 * H2 — a bfcached page (`persisted`) runs no more JS, exactly like a
		 * freeze. The teardown it starts would never finish, so it must not be
		 * what the release waits on.
		 */
		const onPageHide = (ev: Event) => {
			if ((ev as { persisted?: boolean }).persisted) standDownNow();
			else leaveCleanly();
		};
		/**
		 * H1 — the one that starved the file manager on Android. `freeze` runs
		 * only its synchronous part; an async teardown (postMessage to a worker
		 * that is also frozen, behind an 800ms timer that is also frozen) never
		 * resolves, so the lock was held for the entire freeze while the tab
		 * could not answer a `who` ping. Three seconds of asking, three times,
		 * and every other tab gave up.
		 */
		const onFreeze = () => standDownNow();

		target.addEventListener('pagehide', onPageHide);
		target.addEventListener('freeze', onFreeze);
		detachLifecycle = () => {
			target.removeEventListener('pagehide', onPageHide);
			target.removeEventListener('freeze', onFreeze);
		};
	}

	async function acquire(attempt: LockAttempt = {}): Promise<boolean> {
		if (held) return await deps.start();

		// No Web Locks (very old browser, or a non-browser embedder). Assume
		// sole ownership: one tab keeps working, and a second one is refused by
		// the SAH pool itself rather than corrupting anything.
		const locks = deps.locks;
		if (!locks?.request) return await deps.start();

		const { waitMs = 0, steal = false } = attempt;
		const queued = !steal && waitMs > 0;
		const ctl = new AbortController();
		const options: LockOptions = steal
			? { steal: true }
			: queued
				? { signal: ctl.signal }
				: { ifAvailable: true };

		// H5 — a queued request must be abandonable. Without this a tab that
		// never wins the lock waits for it forever instead of falling back to
		// talking to the leader over BroadcastChannel.
		const giveUpQueue = queued ? setTimeout(() => ctl.abort(), waitMs) : null;
		const stopWaiting = () => {
			if (giveUpQueue) clearTimeout(giveUpQueue);
		};

		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const decide = (v: boolean) => {
				if (settled) return;
				settled = true;
				stopWaiting();
				resolve(v);
			};
			try {
				void locks
					.request(deps.name, options, async (lock) => {
						// `ifAvailable` calls back with null when someone holds it.
						if (!lock) {
							decide(false);
							return;
						}
						held = true;
						stopWaiting();
						if (!(await deps.start())) {
							// Cannot serve, so do not hold: returning from the
							// callback releases the lock for a tab that can.
							held = false;
							decide(false);
							return;
						}
						attachLifecycle();
						decide(true);
						// Hold until something calls letGo(). Resolving this is
						// the only thing that releases the lock.
						await new Promise<void>((release) => {
							releaseHold = release;
						});
					})
					.then(
						// A request that ends without ever holding the lock (a
						// probe that found it taken) is simply a "no".
						() => decide(false),
						() => {
							/**
							 * H4 — a rejection while we hold it means we were
							 * stolen from. That rejection IS the platform's
							 * notification, and acting on it is what makes
							 * stealing survivable: we drop the worker, so its
							 * SAH pool is released and the thief is the only
							 * leader. Ignore it and two workers race for the
							 * same files.
							 *
							 * It arrives only when this context next runs JS,
							 * which for a frozen tab is at thaw — so a steal
							 * buys the thief nothing until then. It is a
							 * backstop for a holder wedged some other way, not
							 * the fix for H1.
							 */
							if (held) {
								standDownNow();
								deps.onStolen?.();
							}
							decide(false);
						}
					);
			} catch {
				decide(false);
			}
		});
	}

	return {
		get held() {
			return held;
		},
		acquire,
		release: letGo
	};
}
