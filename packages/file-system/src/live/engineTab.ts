/**
 * This browser's side of the collab session engine (`@shared-packages/doc-collab`
 * `createSessionEngine`): how tabs meet in a room. One bus per room, one Web
 * Lock election for who sequences it and another for who saves it, and the
 * channel the subordinate claim runs on. Every name comes from `liveDocNames`.
 *
 * Structural on purpose: this package does not depend on `doc-collab`.
 */
import { createLiveBus } from './bus.js';
import { createLeaderElection, createPersistElection, type LeaderElection } from './leader.js';
import { liveDocNames } from './names.js';

export type EngineTabMember<F> = {
	id: string;
	send(frame: F): void;
	subscribe(handler: (frame: F) => void): () => void;
	close(): void;
};

export type BrowserEngineTab<F> = {
	member(room: string, clientId: string): EngineTabMember<F>;
	election(room: string): LeaderElection;
	persist?(room: string): LeaderElection;
	claimChannel(room: string): string;
};

/**
 * A copy the bus can post. `postMessage` structured-clones, a reactive proxy
 * cannot be cloned, and the bus drops a batch it cannot post without a word —
 * a follower then never receives the snapshot that lets it join. Collab
 * frames are JSON-shaped, so a JSON copy is what the file holds anyway.
 */
function toWire<T>(frame: T): T {
	try {
		return structuredClone(frame);
	} catch {
		return JSON.parse(JSON.stringify(frame)) as T;
	}
}

type PresenceShape = { kind?: unknown; clientId?: unknown; state?: unknown; ping?: unknown };

/** A presence frame (`@shared-packages/doc-collab` `PresenceFrame`), by shape. */
function presenceClient(frame: unknown): { clientId: string; leaves: boolean } | null {
	const f = frame as PresenceShape | null;
	if (!f || typeof f !== 'object' || f.kind !== 'presence' || typeof f.clientId !== 'string') return null;
	return { clientId: f.clientId, leaves: f.state === null && !f.ping };
}

export function browserEngineTab<F>(opts: {
	/** Frames that go unordered (previews, presence). */
	isImmediate?: (frame: F) => boolean;
	/** False: no save election; the app decides who writes. */
	persist?: boolean;
	/** Awaited before this tab hands the save role on (see `createPersistElection`). */
	beforeHandover?: (room: string) => Promise<void> | void;
} = {}): BrowserEngineTab<F> {
	const isImmediate = opts.isImmediate;
	return {
		member(room, clientId) {
			const bus = createLiveBus<F>(liveDocNames(room).channelName, clientId, { isImmediate });
			/**
			 * Who each sending tab speaks for: itself, and — for a call's
			 * gateway — the peers it relays. When that tab is gone (its lock
			 * was released, exactly), they all leave. No silence timeout.
			 */
			const clientsBySender = new Map<string, Set<string>>();
			const handlers = new Set<(frame: F) => void>();
			const deliver = (frame: F) => {
				for (const handler of [...handlers]) handler(frame);
			};
			const offMessage = bus.onMessage((frame, sender) => {
				const presence = presenceClient(frame);
				if (presence) {
					let set = clientsBySender.get(sender);
					if (!set) clientsBySender.set(sender, (set = new Set()));
					if (presence.leaves) set.delete(presence.clientId);
					else set.add(presence.clientId);
				}
				deliver(frame);
			});
			const offGone = bus.onSenderGone((sender) => {
				const gone = clientsBySender.get(sender);
				clientsBySender.delete(sender);
				for (const id of gone ?? []) deliver({ kind: 'presence', clientId: id, state: null } as F);
			});
			return {
				id: 'tab',
				send(frame) {
					const wire = toWire(frame);
					if (isImmediate?.(wire)) bus.broadcastImmediate(wire);
					else bus.broadcast(wire);
				},
				subscribe(handler) {
					handlers.add(handler);
					return () => {
						handlers.delete(handler);
					};
				},
				close() {
					offMessage();
					offGone();
					handlers.clear();
					bus.destroy();
				}
			};
		},
		election: (room) => createLeaderElection(room),
		persist:
			opts.persist === false
				? undefined
				: (room) =>
						createPersistElection(room, {
							beforeHandover: opts.beforeHandover ? () => opts.beforeHandover?.(room) : undefined
						}),
		claimChannel: (room) => liveDocNames(room).claimChannelName
	};
}
