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
 * including one holding the Web Lock. This channel is how those other tabs find
 * out.
 *
 * ⚠️ Both gateways announce, host and guest. The gateway is not necessarily the
 * tab holding this side's lock — whoever opened the drawing first holds that —
 * so a host gateway that stayed quiet would leave a sibling still believing the
 * lock made it the sequencer, and that is two sequencers for one document.
 *
 * ⚠️ It carries a TTL for the same reason presence does (gotcha 13): the
 * gateway tab can vanish without a word. A crashed gateway takes the peer
 * connection with it, so the guest side should go back to electing its own
 * sequencer — and without expiry it would instead sit subordinate to a call
 * that no longer exists, with no sequencer at all and nothing syncing.
 */

/** Re-announced this often, so silence is distinguishable from departure. */
export const SUBORDINATE_HEARTBEAT_MS = 4_000;
/** Three missed heartbeats, matching `PRESENCE_TTL_MS`. */
export const SUBORDINATE_TTL_MS = 3 * SUBORDINATE_HEARTBEAT_MS;

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

type Opts = {
	/** Test seam. Defaults to a real `BroadcastChannel` for the document. */
	channel?: ClaimChannel;
	heartbeatMs?: number;
	ttlMs?: number;
};

function openChannel(channelName: string, provided?: ClaimChannel): ClaimChannel | null {
	if (provided) return provided;
	if (typeof BroadcastChannel === 'undefined') return null;
	// A name of its own, not the document bus: this is control traffic and must
	// keep working regardless of what the runtime is doing with frames. The
	// caller derives the name — this package does not depend on
	// `@shared-packages/file-system` just to spell one.
	return new BroadcastChannel(channelName) as unknown as ClaimChannel;
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
	if (!channel) return () => {};
	const heartbeatMs = opts?.heartbeatMs ?? SUBORDINATE_HEARTBEAT_MS;
	let stopped = false;

	const claim = (): void => {
		if (!stopped) channel.postMessage({ t: 'claim', from: clientId });
	};

	// Answer a latecomer directly rather than making it wait out a heartbeat:
	// that wait is a window in which two tabs both believe they sequence.
	const onMessage = (event: { data?: unknown }): void => {
		if (stopped || !isClaim(event.data)) return;
		if (event.data.t === 'who' && event.data.from !== clientId) claim();
	};
	channel.addEventListener('message', onMessage);

	claim();
	const timer = setInterval(claim, heartbeatMs);

	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		channel.removeEventListener('message', onMessage);
		// Say so now rather than letting the TTL elapse — otherwise hanging up
		// leaves the other tabs leaderless for three heartbeats.
		try {
			channel.postMessage({ t: 'release', from: clientId });
		} catch {
			/* channel already closed */
		}
		if (!opts?.channel) channel.close();
	};
}

/**
 * Watch whether any tab on this side holds a peer session.
 *
 * Reports `false` immediately so a lone tab is never left waiting on a call
 * that does not exist, then `true` if a claim answers the `who`.
 */
export function watchSubordinate(
	channelName: string,
	clientId: string,
	onChange: (subordinate: boolean) => void,
	opts?: Opts
): () => void {
	const channel = openChannel(channelName, opts?.channel);
	if (!channel) {
		onChange(false);
		return () => {};
	}
	const ttlMs = opts?.ttlMs ?? SUBORDINATE_TTL_MS;
	const heartbeatMs = opts?.heartbeatMs ?? SUBORDINATE_HEARTBEAT_MS;
	let stopped = false;
	let last = false;
	/** Claimants and when each was last heard from. */
	const seen = new Map<string, number>();

	function publish(): void {
		const next = seen.size > 0;
		if (stopped || next === last) return;
		last = next;
		onChange(next);
	}

	function sweep(): void {
		if (stopped) return;
		const cutoff = Date.now() - ttlMs;
		for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
		publish();
	}

	const onMessage = (event: { data?: unknown }): void => {
		if (stopped || !isClaim(event.data)) return;
		const { t, from } = event.data;
		if (from === clientId) return;
		if (t === 'claim') seen.set(from, Date.now());
		else if (t === 'release') seen.delete(from);
		else return; // a 'who' from another watcher is not a claim
		publish();
	};
	channel.addEventListener('message', onMessage);

	onChange(false);
	channel.postMessage({ t: 'who', from: clientId });
	const timer = setInterval(sweep, heartbeatMs);

	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		channel.removeEventListener('message', onMessage);
		if (!opts?.channel) channel.close();
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
