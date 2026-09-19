/**
 * One session over several transports.
 *
 * The problem it solves: a peer invite used to REPLACE cross-tab sync, because
 * the attach layer picked one session and bound one runtime to it. Opening an
 * invite therefore went deaf to your own other tabs, silently, in both products.
 *
 * Here the tab holding the peer connection becomes a gateway instead: frames
 * from the bus go out to the peer, frames from the peer go out onto the bus, and
 * the local runtime sees all of them. The topology is a star centred on the
 * gateway.
 *
 * ⚠️ Crossing a seam costs the transport's ordering guarantee. Each transport
 * orders its own traffic; bus → gateway → peer is not one transport. Pair this
 * with `createSeqLog` — a relay without sequence numbers applies older-wins and
 * nothing notices.
 */

export type RelayMember<F> = {
	/** Stable, and only ever compared to other members' — never on the wire. */
	readonly id: string;
	send(frame: F): void;
	subscribe(handler: (frame: F) => void): () => void;
	close(): void;
};

export type RelaySession<F> = {
	readonly members: readonly string[];
	send(frame: F): void;
	subscribe(handler: (frame: F) => void): () => void;
	close(): void;
};

export function createRelaySession<F>(opts: {
	members: RelayMember<F>[];
	/**
	 * Whether an inbound frame should be passed straight on to the other
	 * transports.
	 *
	 * Per FRAME, not per role, and the difference is not academic. A replica
	 * gateway is a pipe and forwards everything. A sequencer must not forward
	 * anything it is going to NUMBER — an inbound document frame is unordered
	 * until it applies it, and it re-sends the stamped version through `send`,
	 * which reaches every member anyway. But traffic it will never number —
	 * presence, cursors, anything out of band — has no other way across, and a
	 * blanket "a sequencer does not forward" silently strands it: the guest's
	 * cursor and peer dot simply never reach the sibling tab.
	 */
	forward: (frame: F) => boolean;
}): RelaySession<F> {
	const { members, forward } = opts;
	const handlers = new Set<(frame: F) => void>();
	const unsubscribes: Array<() => void> = [];
	/**
	 * Frames that arrived before anyone subscribed to the relay.
	 *
	 * ⚠️ Not a nicety. The relay subscribes to its members inside this
	 * constructor, and the runtime subscribes to the RELAY only after it
	 * returns — so there is a window with a live member and no listener. Both
	 * the WebRTC and the BroadcastChannel adapters replay their own queued
	 * frames to their first subscriber, which lands them in that window, and
	 * for a joining replica the frame in flight is the join snapshot. Dropping
	 * it leaves a peer connected to an empty document with no error anywhere.
	 */
	const queued: F[] = [];
	let closed = false;

	for (const member of members) {
		unsubscribes.push(
			member.subscribe((frame) => {
				if (closed) return;
				if (handlers.size === 0) queued.push(frame);
				else for (const handler of [...handlers]) handler(frame);
				if (!forward(frame)) return;
				// Never back onto the transport it arrived on. Two gateways with
				// two different guests form a tree, not a cycle, so this rule is
				// sufficient and not merely necessary.
				for (const other of members) {
					if (other.id === member.id) continue;
					other.send(frame);
				}
			})
		);
	}

	return {
		get members() {
			return members.map((m) => m.id);
		},
		send(frame) {
			if (closed) return;
			for (const member of members) member.send(frame);
		},
		subscribe(handler) {
			handlers.add(handler);
			if (queued.length) {
				for (const frame of queued.splice(0)) handler(frame);
			}
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			if (closed) return;
			closed = true;
			for (const off of unsubscribes) off();
			handlers.clear();
			queued.length = 0;
			for (const member of members) member.close();
		}
	};
}
