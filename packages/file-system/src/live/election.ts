/**
 * The one answer to "which tab does X" — the catalog worker, a document's
 * sequencer, a document's saver, a call's gateway. Every cross-tab role in the
 * apps is elected here, and nothing about it is decided by a clock.
 *
 * The model (from ~/Code/modular-app `module-sdk/src/sync/leader.svelte.ts`,
 * extended; the design note is scratch-pad `docs/design/tab-coordination.md`):
 *
 * - **The lock queue is the failover.** Every contender waits in the Web Lock
 *   queue with no deadline. The browser hands the lock on when the holder's
 *   context dies, so a grant *is* the proof the previous leader is gone. There
 *   is no heartbeat, no probe and no "silent for N ms" rule to misfire on a
 *   tab that was merely busy.
 *
 * - **The first answer is exact.** A tab first asks with `ifAvailable`: a lock
 *   that is free is granted by that very request, and one that is taken is
 *   answered `null` on the spot. So "not the leader" is known, never guessed
 *   after a grace period — and only then does the tab join the queue.
 *
 * - **Terms are globally ordered and fenced.** A leader's term is at least one
 *   past every term it has heard of. It holds a second lock named for its term
 *   for as long as it leads, and announces itself only once it has it.
 *   Followers queue on that term lock: its grant is an exact death notice,
 *   delivered to every follower, not only the one next in line. Anything that
 *   announces an older term than the one a tab knows is ignored.
 *
 * - **A person, not a timer, overrides a stuck holder.** `takeOver()` steals
 *   the lock. The browser rejects the old holder's request when that context
 *   next runs — a frozen tab at thaw — and it stands down and rejoins as a
 *   follower. Until then its announcements carry an older term and are
 *   ignored, so it cannot act as leader for anyone.
 *
 * - **Lifecycle, not silence, hands over.** `freeze` and a bfcache `pagehide`
 *   stand down synchronously (nothing after that line may run); an ordinary
 *   `pagehide` tears down cleanly first. `resume` rejoins the queue.
 */

export type ElectionState = 'deciding' | 'leader' | 'follower';

/** Who leads, as last announced. `term` orders leaders across tabs. */
export type LeaderRef = {
	/**
	 * This election instance. Not the tab: hub panes share one tab, so two
	 * elections for the same lock can live in it, and must tell each other
	 * apart.
	 */
	readonly id: string;
	readonly tabId: string;
	readonly term: number;
};

type LockOptions = { signal?: AbortSignal; ifAvailable?: boolean; steal?: boolean };

export type LockManagerLike = {
	request(
		name: string,
		options: LockOptions,
		callback: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
};

export type ElectionChannel = {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', fn: (event: { data?: unknown }) => void): void;
	removeEventListener(type: 'message', fn: (event: { data?: unknown }) => void): void;
	close(): void;
};

type EventTargetLike = {
	addEventListener(type: string, fn: (ev: Event) => void): void;
	removeEventListener(type: string, fn: (ev: Event) => void): void;
};

type DocumentLike = EventTargetLike & { readonly visibilityState?: string };

export type ElectionOpts = {
	/**
	 * Bring up whatever leading means (the catalog worker). `false` or a throw
	 * means this tab cannot lead: the lock goes back at once, the reason is
	 * announced so followers can report it, and this tab stays out of the
	 * queue until `resumeAcquire()`. Staying out is what stops two tabs that
	 * both cannot start from handing the lock back and forth forever.
	 */
	prepare?: (term: number) => Promise<boolean> | boolean;
	/** Clean teardown while JS still runs, awaited before the lock is released. */
	teardown?: () => Promise<void> | void;
	/** Synchronous teardown when no more JS may run: freeze, bfcache, stolen. */
	abandon?: () => void;
	/** Another tab took leadership from this one (`takeOver`). For reporting. */
	onStolen?: () => void;
	/**
	 * Stand down while hidden so a visible tab leads. For roles whose work
	 * rides the leader's timers (saving), not for ones a worker serves.
	 */
	yieldWhenHidden?: boolean;
	/**
	 * `false`: never ask for the lock, only follow who holds it. For contexts
	 * that must not lead — an extract worker cannot host the catalog worker —
	 * but still need to know the leader and when it goes.
	 */
	contend?: boolean;
	/** Test seams. */
	locks?: LockManagerLike | null;
	channel?: ElectionChannel | null;
	window?: EventTargetLike | null;
	document?: DocumentLike | null;
	tabId?: string;
	now?: () => number;
};

export type Election = {
	/** `deciding` only until the first lock answer, which is immediate. */
	readonly state: ElectionState;
	readonly isLeader: boolean;
	/** False only while `deciding`. */
	readonly decided: boolean;
	readonly tabId: string;
	/** The current leader, this tab included. Null while none is known. */
	readonly leader: LeaderRef | null;
	/** This tab's term while it leads, else 0. */
	readonly term: number;
	/** Increments on every acquisition by this tab. */
	readonly leaderSessionId: number;
	/** The last "cannot lead" reason heard, from this tab or another. */
	readonly failure: string | null;
	/**
	 * In the queue or holding the lock. False after `release()`, a failed
	 * `prepare`, a freeze, or with `contend: false` — so "no leader and not
	 * queued" means nobody is coming unless something changes.
	 */
	readonly queued: boolean;
	/** Fires on every change to any of the above. */
	onChange(fn: () => void): () => void;
	/**
	 * Take leadership from whoever holds it. Only for a person pressing a
	 * button: the holder may be mid-write, and loses that write.
	 */
	takeOver(): void;
	/** Leave the queue and stay out until `resumeAcquire()`. */
	release(): void;
	/** Rejoin after `release()`, a failed `prepare`, or a freeze. */
	resumeAcquire(): void;
	/** Hand over to a waiting tab and rejoin at the back of the queue. */
	yieldLeadership(): void;
	destroy(): void;
};

type Wire =
	| { t: 'leader'; id: string; tabId: string; term: number }
	| { t: 'gone'; id: string; tabId: string; term: number }
	| { t: 'cannot-lead'; id: string; reason: string }
	| { t: 'who' };

let instanceSeq = 0;

function isWire(v: unknown): v is Wire {
	if (!v || typeof v !== 'object') return false;
	const t = (v as { t?: unknown }).t;
	return t === 'leader' || t === 'gone' || t === 'cannot-lead' || t === 'who';
}

let sharedTabId: string | null = null;

/**
 * One id per live browsing context. Not sessionStorage: "Duplicate tab" clones
 * it, and two tabs sharing an id filter each other out as self (M6).
 */
export function getTabId(): string {
	if (sharedTabId) return sharedTabId;
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	sharedTabId =
		typeof c?.randomUUID === 'function' ? c.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;
	return sharedTabId;
}

function defaultLocks(): LockManagerLike | null {
	const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
	return typeof nav?.locks?.request === 'function' ? nav.locks : null;
}

function defaultChannel(name: string): ElectionChannel | null {
	if (typeof BroadcastChannel === 'undefined') return null;
	try {
		const ch = new BroadcastChannel(name);
		// Node keeps the event loop alive for an open channel.
		(ch as BroadcastChannel & { unref?: () => void }).unref?.();
		return ch as unknown as ElectionChannel;
	} catch {
		return null;
	}
}

async function quietly(fn?: () => Promise<void> | void): Promise<void> {
	try {
		await fn?.();
	} catch {
		/* best effort */
	}
}

function isAbort(err: unknown): boolean {
	return (err as { name?: string } | null)?.name === 'AbortError';
}

function termLockName(lockName: string, ref: LeaderRef): string {
	return `${lockName}:term:${ref.term}:${ref.id}`;
}

/** Inert shape for SSR, where there are no tabs to coordinate. */
function inertElection(): Election {
	return {
		state: 'follower',
		isLeader: false,
		decided: true,
		tabId: 'server',
		leader: null,
		term: 0,
		leaderSessionId: 0,
		failure: null,
		queued: false,
		onChange: () => () => {},
		takeOver: () => {},
		release: () => {},
		resumeAcquire: () => {},
		yieldLeadership: () => {},
		destroy: () => {}
	};
}

export function createElection(lockName: string, opts: ElectionOpts = {}): Election {
	const win =
		opts.window !== undefined
			? opts.window
			: typeof window !== 'undefined'
				? (window as unknown as EventTargetLike)
				: null;
	const workerScope = typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined';
	if (!win && !workerScope && opts.locks === undefined) return inertElection();

	const locks = opts.locks !== undefined ? opts.locks : defaultLocks();
	const doc =
		opts.document !== undefined
			? opts.document
			: typeof document !== 'undefined'
				? (document as unknown as DocumentLike)
				: null;
	const channel = opts.channel !== undefined ? opts.channel : defaultChannel(`${lockName}:election`);
	const tabId = opts.tabId ?? getTabId();
	const selfId = `${tabId}:${++instanceSeq}`;
	const now = opts.now ?? Date.now;

	let state: ElectionState = 'deciding';
	let leader: LeaderRef | null = null;
	let myTerm = 0;
	/** Highest term heard from anyone; a new term must exceed it. */
	let highestTerm = 0;
	let sessionId = 0;
	let failure: string | null = null;
	let destroyed = false;
	/** Out of the queue by choice (release, failed prepare, freeze). */
	let suspended = opts.contend === false;
	let handlers: Array<() => void> = [];

	/** The request currently queued or holding. Aborting it leaves the queue. */
	let queueCtl: AbortController | null = null;
	/** Resolving this releases the main lock we hold. */
	let releaseMain: (() => void) | null = null;
	/** Resolving this releases our term lock. */
	let releaseTerm: (() => void) | null = null;
	/** Our wait on the current leader's term lock. */
	let goneCtl: AbortController | null = null;
	/** The request a clean stand-down is tearing down; it may not become leader. */
	let leavingCtl: AbortController | null = null;

	function notify(): void {
		for (const h of [...handlers]) {
			try {
				h();
			} catch {
				/* one bad subscriber must not stop the others */
			}
		}
	}

	function post(msg: Wire): void {
		try {
			channel?.postMessage(msg);
		} catch {
			/* closed */
		}
	}

	function announce(): void {
		if (state === 'leader') post({ t: 'leader', id: selfId, tabId, term: myTerm });
	}

	// --- follower side ---------------------------------------------------

	function stopWatchingGone(): void {
		goneCtl?.abort();
		goneCtl = null;
	}

	/** Queue on the leader's term lock: its grant means that leader is gone. */
	function watchGone(ref: LeaderRef): void {
		stopWatchingGone();
		if (!locks) return;
		const ctl = new AbortController();
		goneCtl = ctl;
		void locks
			.request(termLockName(lockName, ref), { signal: ctl.signal }, () => {
				if (ctl.signal.aborted) return;
				leaderGone(ref);
			})
			.catch(() => {
				/* aborted: a newer leader replaced this watch */
			});
	}

	function leaderGone(ref: LeaderRef): void {
		if (destroyed || !leader || leader.term !== ref.term || leader.id !== ref.id) return;
		if (state === 'leader') return;
		leader = null;
		stopWatchingGone();
		notify();
		post({ t: 'who' });
	}

	function hearLeader(ref: LeaderRef): void {
		if (ref.id === selfId) return;
		if (ref.term < (leader?.term ?? 0)) return; // fenced: an older term
		highestTerm = Math.max(highestTerm, ref.term);
		if (state === 'leader') {
			if (ref.term <= myTerm) {
				// A stale leader that has not yet noticed it was superseded.
				// Our announcement tells it; it will stand down on hearing it.
				announce();
				return;
			}
			// Superseded — our lock was taken and the rejection that says so
			// has not reached us yet. Do not lead for a moment longer.
			standDownNow({ requeue: true });
			opts.onStolen?.();
		}
		const changed = leader?.term !== ref.term || leader?.id !== ref.id;
		leader = ref;
		if (state === 'deciding') state = 'follower';
		if (changed) watchGone(ref);
		notify();
	}

	function onMessage(event: { data?: unknown }): void {
		if (destroyed || !isWire(event.data)) return;
		const msg = event.data;
		if (msg.t === 'who') {
			announce();
			return;
		}
		if (msg.t === 'leader') {
			hearLeader({ id: msg.id, tabId: msg.tabId, term: msg.term });
			return;
		}
		if (msg.t === 'gone') {
			leaderGone({ id: msg.id, tabId: msg.tabId, term: msg.term });
			return;
		}
		if (msg.t === 'cannot-lead' && msg.id !== selfId) {
			failure = msg.reason;
			notify();
		}
	}

	// --- leader side -----------------------------------------------------

	function becomeFollowerDecided(): void {
		if (state === 'deciding') {
			state = 'follower';
			notify();
		}
	}

	function holdTermLock(term: number): Promise<boolean> {
		if (!locks) return Promise.resolve(true);
		const ref = { id: selfId, tabId, term };
		return new Promise<boolean>((granted) => {
			void locks
				.request(termLockName(lockName, ref), {}, () => {
					granted(true);
					return new Promise<void>((resolve) => {
						releaseTerm = resolve;
					});
				})
				.catch(() => granted(false));
		});
	}

	function dropTermLock(): void {
		const r = releaseTerm;
		releaseTerm = null;
		r?.();
	}

	/** Runs inside the main-lock callback. Resolving `hold` releases the lock. */
	async function onGranted(ctl: AbortController | null): Promise<void> {
		const current = () =>
			!destroyed && queueCtl === ctl && releaseMain !== null && leavingCtl !== ctl;
		const term = Math.max(now(), highestTerm + 1);
		highestTerm = term;
		if (opts.prepare) {
			let ok = false;
			try {
				ok = await opts.prepare(term);
				if (!ok) failure = failure ?? 'this tab could not start it';
			} catch (e) {
				failure = e instanceof Error ? e.message : String(e);
			}
			if (!current()) {
				// We lost the lock while starting (released, stolen, destroyed).
				// Whatever `prepare` brought up must not outlive that.
				if (ok) await quietly(opts.teardown);
				return;
			}
			if (!ok) {
				post({ t: 'cannot-lead', id: selfId, reason: failure ?? 'could not start' });
				suspended = true;
				queueCtl = null;
				const r = releaseMain;
				releaseMain = null;
				r?.();
				state = 'follower';
				notify();
				return;
			}
		}
		await holdTermLock(term);
		if (!current()) {
			dropTermLock();
			await quietly(opts.teardown);
			return;
		}
		myTerm = term;
		sessionId += 1;
		failure = null;
		leader = { id: selfId, tabId, term };
		stopWatchingGone();
		state = 'leader';
		announce();
		notify();
	}

	function lockCallback(ctl: AbortController | null) {
		return (lock: unknown): Promise<void> | void => {
			if (destroyed || queueCtl !== ctl || ctl?.signal.aborted) return;
			if (lock === null) return; // an `ifAvailable` probe that found it taken
			return new Promise<void>((resolve) => {
				releaseMain = resolve;
				void onGranted(ctl);
			});
		};
	}

	function settleRequest(ctl: AbortController | null) {
		return (err: unknown): void => {
			if (queueCtl !== ctl) return; // superseded by our own release/yield
			if (!isAbort(err)) {
				console.error(`${lockName}: lock request failed`, err);
				return;
			}
			if (ctl?.signal.aborted) return; // we left the queue ourselves
			// The platform's notice that our lock was stolen.
			if (state === 'leader' || releaseMain) {
				standDownNow({ requeue: true });
				opts.onStolen?.();
			}
		};
	}

	function enqueue(): void {
		if (destroyed || suspended || queueCtl) return;
		if (!locks) {
			// No Web Locks: we cannot coordinate. One tab keeps working; two
			// degrade to both writing, and the VFS generation check turns the
			// loser into the existing conflict prompt.
			const ctl = new AbortController();
			queueCtl = ctl;
			releaseMain = () => {};
			void onGranted(ctl);
			return;
		}
		const ctl = new AbortController();
		queueCtl = ctl;
		// First ask without waiting: a free lock is granted by this very
		// request, and a taken one is answered on the spot. That is the
		// exact first answer the old grace period was guessing at.
		void locks
			.request(lockName, { ifAvailable: true }, (lock) => {
				if (lock !== null) return lockCallback(ctl)(lock);
				if (destroyed || queueCtl !== ctl) return;
				becomeFollowerDecided();
				post({ t: 'who' });
				queueForFailover(ctl);
			})
			.catch(settleRequest(ctl));
	}

	/** Wait in the queue with no deadline. The grant is the failover. */
	function queueForFailover(ctl: AbortController): void {
		if (!locks) return;
		void locks
			.request(lockName, { signal: ctl.signal }, lockCallback(ctl))
			.catch(settleRequest(ctl));
	}

	/** Give the lock up now. Nothing after this may be awaited. */
	function standDownNow(opts2: { requeue: boolean }): void {
		const wasLeader = state === 'leader' || releaseMain !== null;
		const ctl = queueCtl;
		queueCtl = null;
		ctl?.abort();
		const r = releaseMain;
		releaseMain = null;
		dropTermLock();
		if (wasLeader) {
			try {
				opts.abandon?.();
			} catch {
				/* tearing down */
			}
		}
		const hadTerm = myTerm;
		myTerm = 0;
		if (state === 'leader') {
			leader = null;
			state = 'follower';
		}
		r?.();
		if (wasLeader && hadTerm) post({ t: 'gone', id: selfId, tabId, term: hadTerm });
		notify();
		if (opts2.requeue) {
			suspended = false;
			enqueue();
		}
	}

	/** Give the lock up after a clean teardown. */
	async function standDownCleanly(requeue: boolean): Promise<void> {
		const ctl = queueCtl;
		// Holding the lock counts, not only having announced: a `prepare` in
		// progress has already brought things up that must come down first.
		const leading = state === 'leader' || releaseMain !== null;
		leavingCtl = ctl;
		if (leading) await quietly(opts.teardown);
		if (leavingCtl === ctl) leavingCtl = null;
		if (queueCtl !== ctl) return; // something else already moved us on
		queueCtl = null;
		ctl?.abort();
		const r = releaseMain;
		releaseMain = null;
		dropTermLock();
		const hadTerm = myTerm;
		myTerm = 0;
		if (state === 'leader') {
			leader = null;
			state = 'follower';
		}
		r?.();
		if (leading && hadTerm) post({ t: 'gone', id: selfId, tabId, term: hadTerm });
		notify();
		if (requeue) enqueue();
	}

	// --- lifecycle -------------------------------------------------------

	const onFreeze = () => {
		if (destroyed || opts.contend === false) return;
		suspended = true;
		standDownNow({ requeue: false });
	};
	const onResume = () => {
		if (destroyed || !suspended || opts.contend === false) return;
		suspended = false;
		enqueue();
		post({ t: 'who' });
	};
	const onPageHide = (ev: Event) => {
		if (destroyed || opts.contend === false) return;
		suspended = true;
		// A bfcached page runs no more JS, exactly like a freeze (H2).
		if ((ev as { persisted?: boolean }).persisted) standDownNow({ requeue: false });
		else void standDownCleanly(false);
	};
	const onPageShow = (ev: Event) => {
		if ((ev as { persisted?: boolean }).persisted) onResume();
	};
	const onVisibility = () => {
		if (destroyed || !opts.yieldWhenHidden) return;
		if (doc?.visibilityState === 'hidden' && state === 'leader') void standDownCleanly(true);
	};

	win?.addEventListener('pagehide', onPageHide);
	win?.addEventListener('pageshow', onPageShow);
	doc?.addEventListener('freeze', onFreeze);
	doc?.addEventListener('resume', onResume);
	doc?.addEventListener('visibilitychange', onVisibility);
	channel?.addEventListener('message', onMessage);

	if (opts.contend === false) post({ t: 'who' });
	else enqueue();

	return {
		get state() {
			return state;
		},
		get isLeader() {
			return state === 'leader';
		},
		get decided() {
			return state !== 'deciding';
		},
		get tabId() {
			return tabId;
		},
		get leader() {
			return leader;
		},
		get term() {
			return myTerm;
		},
		get leaderSessionId() {
			return sessionId;
		},
		get failure() {
			return failure;
		},
		get queued() {
			return queueCtl !== null;
		},
		onChange(fn) {
			handlers.push(fn);
			return () => {
				handlers = handlers.filter((h) => h !== fn);
			};
		},
		takeOver() {
			if (destroyed || !locks || opts.contend === false) return;
			if (state === 'leader' || releaseMain) return; // already ours
			const old = queueCtl;
			queueCtl = null;
			old?.abort();
			suspended = false;
			// `steal` cannot carry a signal, so this request is left only by
			// resolving its hold. The ctl is still our identity for it.
			const ctl = new AbortController();
			queueCtl = ctl;
			void locks.request(lockName, { steal: true }, lockCallback(ctl)).catch(settleRequest(ctl));
		},
		release() {
			if (destroyed) return;
			suspended = true;
			void standDownCleanly(false);
		},
		resumeAcquire() {
			if (destroyed || !suspended || opts.contend === false) return;
			suspended = false;
			failure = null;
			enqueue();
		},
		yieldLeadership() {
			if (destroyed || state !== 'leader') return;
			void standDownCleanly(true);
		},
		destroy() {
			if (destroyed) return;
			suspended = true;
			standDownNow({ requeue: false });
			destroyed = true;
			stopWatchingGone();
			win?.removeEventListener('pagehide', onPageHide);
			win?.removeEventListener('pageshow', onPageShow);
			doc?.removeEventListener('freeze', onFreeze);
			doc?.removeEventListener('resume', onResume);
			doc?.removeEventListener('visibilitychange', onVisibility);
			channel?.removeEventListener('message', onMessage);
			if (opts.channel === undefined) {
				try {
					channel?.close();
				} catch {
					/* already closed */
				}
			}
			handlers = [];
		}
	};
}
