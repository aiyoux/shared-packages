import type { Role } from './leadership.js';

/**
 * "This side of the call does not elect its own sequencer."
 *
 * With a peer invite up there are two buses — one per browser — and each would
 * otherwise elect its own sequencer from its own Web Lock. Two sequencers for
 * one document is the hazard gotcha 14 names, and the relay makes it reachable
 * rather than theoretical.
 *
 * The resolution: the GATEWAY — the tab holding an end of the call — takes the
 * role the invite gave it, and every other tab on its side is a replica,
 * including one holding the Web Lock. Both gateways announce, host and guest:
 * the gateway is not necessarily the tab holding this side's lock, so a quiet
 * host gateway would leave a sibling believing the lock made it sequencer.
 *
 * How siblings know, with no clock involved:
 *
 * - The gateway holds a Web Lock named for itself (`gatewayLockName`) for as
 *   long as it holds its end of the call.
 * - A watcher finds every gateway from `navigator.locks.query()` — exact, and
 *   it sees a gateway whose tab is frozen and cannot answer a message — and
 *   hears new ones from a `claim` broadcast.
 * - It queues on each gateway's lock. The grant means that gateway hung up or
 *   its tab died: the browser released the lock for it. No heartbeat, no TTL.
 *
 * This used to be a heartbeat and a 90-second TTL, tuned around clamped
 * background timers, during which a crashed gateway left its side with no
 * sequencer at all.
 */

type ClaimMessage =
	| { t: 'claim'; from: string }
	| { t: 'release'; from: string }
	/** A tab that opened mid-call asking whether anyone is already subordinate. */
	| { t: 'who'; from: string };

export type ClaimChannel = {
	postMessage(message: ClaimMessage): void;
	addEventListener(type: 'message', fn: (event: { data?: unknown }) => void): void;
	removeEventListener(type: 'message', fn: (event: { data?: unknown }) => void): void;
	close(): void;
};

type LockInfo = { name?: string };
export type ClaimLocks = {
	request(
		name: string,
		options: { signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
	query?(): Promise<{ held?: LockInfo[] }>;
};

type Opts = {
	/** Test seam. Defaults to a real `BroadcastChannel` for the document. */
	channel?: ClaimChannel;
	/** Test seam. Defaults to `navigator.locks`. */
	locks?: ClaimLocks | null;
};

/** The lock a gateway holds while its end of the call is up. */
export function gatewayLockName(channelName: string, clientId: string): string {
	return `${channelName}:gateway:${clientId}`;
}

function openChannel(channelName: string, provided?: ClaimChannel): ClaimChannel | null {
	if (provided) return provided;
	if (typeof BroadcastChannel === 'undefined') return null;
	// A name of its own, not the document bus: this is control traffic and must
	// keep working regardless of what the runtime is doing with frames.
	return new BroadcastChannel(channelName) as unknown as ClaimChannel;
}

function defaultLocks(): ClaimLocks | null {
	const nav = (globalThis as { navigator?: { locks?: ClaimLocks } }).navigator;
	return typeof nav?.locks?.request === 'function' ? nav.locks : null;
}

function isClaim(value: unknown): value is ClaimMessage {
	if (typeof value !== 'object' || value === null) return false;
	const m = value as Partial<ClaimMessage>;
	return (m.t === 'claim' || m.t === 'release' || m.t === 'who') && typeof m.from === 'string';
}

/**
 * Announce, for as long as this tab holds an end of a call, that the rest of
 * this side must not elect a sequencer.
 */
export function announceSubordinate(
	channelName: string,
	clientId: string,
	opts?: Opts
): () => void {
	const channel = openChannel(channelName, opts?.channel);
	const locks = opts?.locks !== undefined ? opts.locks : defaultLocks();
	let stopped = false;
	let releaseLock: (() => void) | null = null;

	const claim = (): void => {
		if (!stopped) channel?.postMessage({ t: 'claim', from: clientId });
	};

	// Answer a latecomer directly: its `query` already found our lock, this is
	// for a browser without `query`.
	const onMessage = (event: { data?: unknown }): void => {
		if (stopped || !isClaim(event.data)) return;
		if (event.data.t === 'who' && event.data.from !== clientId) claim();
	};
	channel?.addEventListener('message', onMessage);

	if (locks) {
		void locks
			.request(gatewayLockName(channelName, clientId), {}, () => {
				if (stopped) return;
				// Announce only once the lock is held, so no watcher can queue
				// on it before it is ours and read that as "gone".
				claim();
				return new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
			})
			.catch(() => {});
	} else {
		claim();
	}

	return () => {
		if (stopped) return;
		stopped = true;
		channel?.removeEventListener('message', onMessage);
		// Say so now; the lock going is the same news for anyone watching it.
		try {
			channel?.postMessage({ t: 'release', from: clientId });
		} catch {
			/* channel already closed */
		}
		releaseLock?.();
		if (!opts?.channel) channel?.close();
	};
}

/**
 * Watch whether any tab on this side holds a peer session.
 *
 * Reports `false` immediately so a lone tab is never left waiting on a call
 * that does not exist, then `true` once a gateway is found.
 */
export function watchSubordinate(
	channelName: string,
	clientId: string,
	onChange: (subordinate: boolean) => void,
	opts?: Opts
): () => void {
	const channel = openChannel(channelName, opts?.channel);
	const locks = opts?.locks !== undefined ? opts.locks : defaultLocks();
	const prefix = gatewayLockName(channelName, '');
	let stopped = false;
	let last = false;
	/** Gateways believed up, each with the abort for our wait on its lock. */
	const gateways = new Map<string, AbortController | null>();

	function publish(): void {
		const next = gateways.size > 0;
		if (stopped || next === last) return;
		last = next;
		onChange(next);
	}

	function forget(from: string): void {
		const ctl = gateways.get(from);
		if (!gateways.has(from)) return;
		gateways.delete(from);
		ctl?.abort();
		publish();
	}

	function track(from: string): void {
		if (stopped || from === clientId || gateways.has(from)) return;
		if (!locks) {
			gateways.set(from, null);
			publish();
			return;
		}
		const ctl = new AbortController();
		gateways.set(from, ctl);
		publish();
		// The grant is the news: that gateway's lock came free.
		void locks
			.request(gatewayLockName(channelName, from), { signal: ctl.signal }, () => {
				if (gateways.get(from) === ctl) forget(from);
			})
			.catch(() => {});
	}

	const onMessage = (event: { data?: unknown }): void => {
		if (stopped || !isClaim(event.data)) return;
		const { t, from } = event.data;
		if (from === clientId) return;
		if (t === 'claim') track(from);
		else if (t === 'release') forget(from);
	};
	channel?.addEventListener('message', onMessage);

	onChange(false);
	// Exact discovery, frozen gateways included.
	void locks
		?.query?.()
		.then((snap) => {
			for (const l of snap.held ?? []) {
				const name = l.name ?? '';
				if (name.startsWith(prefix)) track(name.slice(prefix.length));
			}
		})
		.catch(() => {});
	channel?.postMessage({ t: 'who', from: clientId });

	return () => {
		if (stopped) return;
		stopped = true;
		for (const ctl of gateways.values()) ctl?.abort();
		gateways.clear();
		channel?.removeEventListener('message', onMessage);
		if (!opts?.channel) channel?.close();
	};
}

/**
 * The document's one role answer, from the two authorities that used to decide
 * it independently — the invite (host/guest) and the Web Lock.
 *
 * Exported and pure so the precedence is pinned by a test: getting this wrong
 * means two sequencers or none, and neither fails loudly.
 */
export function resolveRole(input: {
	/** This tab's role in a peer session, when it holds one. */
	peerRole: Role | null;
	/** What this tab's Web Lock says, used only when nothing outranks it. */
	lockRole: Role;
	/** Another tab on this side holds the guest end of a call. */
	subordinate: boolean;
}): Role {
	// The gateway's own role comes from the invite: host sequences for everyone,
	// guest sequences for no one.
	if (input.peerRole) return input.peerRole;
	// A sibling holds the guest end, so this whole side follows the remote host.
	if (input.subordinate) return 'replica';
	return input.lockRole;
}
