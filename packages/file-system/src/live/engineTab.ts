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
			return {
				id: 'tab',
				send(frame) {
					const wire = toWire(frame);
					if (isImmediate?.(wire)) bus.broadcastImmediate(wire);
					else bus.broadcast(wire);
				},
				subscribe: (handler) => bus.onMessage((frame) => handler(frame)),
				close: () => bus.destroy()
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
