/**
 * Who owns a lease, and whether they are still alive — decided by the browser,
 * not by a clock.
 *
 * Lease rows record intent: "this context is writing that blob", "this context
 * is rewriting that pack". GC used to decide a lease was dead when a timer had
 * not renewed it in two minutes. A frozen tab cannot renew anything, so another
 * tab's GC deleted a write that was only paused — and a heartbeat-and-expiry
 * scheme can do nothing else, because it cannot tell "paused" from "gone".
 *
 * Here every context holds a Web Lock named for itself for its whole life, and
 * stamps its id into every lease owner. The browser releases that lock when the
 * context dies (tab closed, crashed, discarded) and not before — a frozen tab
 * still holds it. So "is the owner alive" is one `navigator.locks.query()`,
 * and it is exact in both directions.
 *
 * Without Web Locks (node tests, very old browsers) nothing can know, and the
 * row's `expiresAt` is the fallback — the old behaviour, and the only place a
 * clock still decides anything.
 */

import type { LeaseRow } from './db.js';

type LockInfo = { name?: string };
type LocksLike = {
	request(name: string, options: object, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>;
	query?(): Promise<{ held?: LockInfo[] }>;
};

const CONTEXT_LOCK = 'vfs-ctx:';

function webLocks(): LocksLike | null {
	const nav = (globalThis as { navigator?: { locks?: LocksLike } }).navigator;
	const locks = nav?.locks;
	return typeof locks?.request === 'function' && typeof locks.query === 'function' ? locks : null;
}

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	return typeof c?.randomUUID === 'function'
		? c.randomUUID()
		: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

let contextId: string | null = null;
let held: Promise<void> | null = null;

/**
 * Hold this context's lock. Resolves once it is held — a lease must never be
 * written before then, or another tab's GC could see an owner with no lock and
 * reclaim a write that has only just started.
 */
function holdContextLock(): Promise<void> {
	if (held) return held;
	contextId = randomId();
	const locks = webLocks();
	if (!locks) {
		held = Promise.resolve();
		return held;
	}
	held = new Promise<void>((granted) => {
		void locks
			.request(`${CONTEXT_LOCK}${contextId}`, {}, () => {
				granted();
				// Never resolves: the lock is released only when this context dies.
				return new Promise<void>(() => {});
			})
			.catch(() => granted());
	});
	return held;
}

/** A lease owner id stamped with this context. Awaits the context lock. */
export async function leaseOwner(kind: string): Promise<string> {
	await holdContextLock();
	return `${contextId}/${kind}-${randomId().slice(0, 8)}`;
}

function contextOf(owner: string): string | null {
	const i = owner.indexOf('/');
	return i > 0 ? owner.slice(0, i) : null;
}

/** True when leases are judged by the browser, so heartbeats are pointless. */
export function leasesAreExact(): boolean {
	return webLocks() !== null;
}

export type LeaseLiveness = (row: Pick<LeaseRow, 'owner' | 'expiresAt'>) => boolean;

/**
 * A snapshot test for "is this lease's owner alive". Take one per decision
 * (one GC pass, one unlink) — it reflects the moment it was taken.
 */
export async function leaseLiveness(now = Date.now()): Promise<LeaseLiveness> {
	const locks = webLocks();
	if (!locks?.query) return (row) => row.expiresAt > now;
	let names: Set<string>;
	try {
		const snap = await locks.query();
		names = new Set((snap.held ?? []).map((l) => l.name ?? ''));
	} catch {
		return (row) => row.expiresAt > now;
	}
	return (row) => {
		const ctx = contextOf(row.owner);
		// A row with no context stamp predates this scheme: only the clock
		// can speak for it.
		if (!ctx) return row.expiresAt > now;
		return names.has(`${CONTEXT_LOCK}${ctx}`);
	};
}

/**
 * Take `name` if no context holds it. Resolves to its release, or null when
 * another context holds it — an exact answer, from the lock itself. Null also
 * without Web Locks; callers keep their clock fallback for that case.
 */
export function tryHoldLock(name: string): Promise<(() => void) | null> {
	const locks = webLocks();
	if (!locks) return Promise.resolve(null);
	return new Promise((answer) => {
		void locks
			.request(name, { ifAvailable: true }, (lock) => {
				if (lock === null) {
					answer(null);
					return;
				}
				return new Promise<void>((release) => answer(() => release()));
			})
			.catch(() => answer(null));
	});
}

/** Resolve once no context holds `name`: queue for it and let go at once. */
export function whenLockFree(name: string): Promise<void> {
	const locks = webLocks();
	if (!locks) return Promise.resolve();
	return locks.request(name, {}, () => {}).then(
		() => {},
		() => {}
	);
}
