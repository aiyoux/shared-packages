/**
 * One collab engine per open document session.
 *
 * Whatever connects to a document — another tab of this browser, another
 * device through an invite, a device that joined from the Sessions menu — is a
 * member of the same session, and a second pane of the same tab shares the
 * engine itself. The app supplies how its document moves (a runtime built on a
 * transport); everything about who is connected and who is in charge is here:
 *
 *  - **The room.** A saved document's room is its file; an unsaved one's is its
 *    session, and it moves to the file on the first save (`setRoom`). An empty
 *    room means no other tab takes part (a session joined from another device,
 *    or a document a monitor already sequences).
 *  - **Who sequences.** A peer's role wins (the invite host sequences, a guest
 *    does not). Otherwise a tab on this side holding a peer makes every other
 *    tab a replica (the subordinate claim), and otherwise the room's Web Lock
 *    decides. Nothing is guessed: until the lock answers there is no role and
 *    no runtime.
 *  - **Who saves.** A second lock on the room (`persist`), reported as it is.
 *  - **One relay.** The tab bus and every peer are members of one relay, so a
 *    frame from any of them reaches the runtime and, where it must, the rest.
 *
 * The runtime is rebuilt whenever the role or the set of members changes; a
 * runtime fixes its role when it is built (see `createSeqLog`).
 */
import { announceSubordinate, resolveRole, watchSubordinate } from './claim.js';
import { watchLeadership, type Election, type Role } from './leadership.js';
import { createRelaySession, type RelayMember, type RelaySession } from './relay.js';
import { installCollabUnload } from './tabBind.js';

/** What a runtime is built on. */
export type EngineTransport<F> = {
	readonly role: Role;
	readonly clientId: string;
	send(frame: F): void;
	subscribe(handler: (frame: F) => void): () => void;
	close(): void;
};

/**
 * How this browser's tabs meet in a room. Injected: this package has no
 * BroadcastChannel or Web Lock of its own (`@shared-packages/file-system`
 * provides them).
 */
export type EngineTab<F> = {
	/** The room's tab bus, as a relay member. Closed when the room is left. */
	member(room: string, clientId: string): RelayMember<F>;
	/** Elects the tab that sequences the room. */
	election(room: string): Election;
	/** Elects the tab that saves the room. Absent: every tab may save. */
	persist?(room: string): Election;
	/** Channel name for the subordinate claim. */
	claimChannel(room: string): string;
	/** Test seam for the subordinate claim. Defaults to `announceSubordinate` / `watchSubordinate`. */
	claim?: {
		announce(channel: string, clientId: string): () => void;
		watch(channel: string, clientId: string, onChange: (subordinate: boolean) => void): () => void;
	};
};

export type EnginePeer<F> = {
	/** This side's role on that link: the invite host and a served join sequence. */
	role: Role;
	/** The link. The engine closes it when the peer is removed or replaced. */
	member: RelayMember<F>;
};

export type SessionEngine<F, R> = {
	readonly clientId: string;
	readonly room: string;
	/** Null until the room's lock answers (and no peer decides it). */
	readonly role: Role | null;
	readonly runtime: R | null;
	/** Whether this tab writes the document. True with no room. */
	readonly persistOwner: boolean;
	readonly peerIds: readonly string[];
	setRoom(room: string): void;
	setPeer(id: string, peer: EnginePeer<F> | null): void;
	/** Send a frame outside the runtime (previews, save notices) to every member. */
	send(frame: F): void;
	/** Every frame any member delivers, for side channels the runtime ignores. */
	onFrame(handler: (frame: F) => void): () => void;
	destroy(): void;
};

export type SessionEngineOpts<F, R extends { close(): void }> = {
	clientId: string;
	room: string;
	tab: EngineTab<F> | null;
	runtime: (transport: EngineTransport<F>) => R;
	/**
	 * Frames the sequencer numbers or answers. A replica gateway passes every
	 * frame on; a sequencer passes on only what it will never number (presence,
	 * previews, save notices) — it re-sends what it numbers itself.
	 */
	isOrdered?: (frame: F) => boolean;
	onRole?: (role: Role, meta: { promoted: boolean }) => void;
	onPersist?: (owner: boolean) => void;
	onRuntime?: (runtime: R | null) => void;
};

const ORDERED_KINDS = new Set(['snapshot', 'edit', 'hello', 'resync']);

function defaultOrdered(frame: unknown): boolean {
	const kind = (frame as { kind?: unknown } | null)?.kind;
	return typeof kind === 'string' && ORDERED_KINDS.has(kind);
}

/** A member whose close is the engine's business, not the relay's. */
function held<F>(member: RelayMember<F>): RelayMember<F> {
	return {
		id: member.id,
		send: (frame) => member.send(frame),
		subscribe: (handler) => member.subscribe(handler),
		close: () => {}
	};
}

type TabRoom<F> = {
	member: RelayMember<F>;
	stop: () => void;
	announce: (() => void) | null;
};

export function createSessionEngine<F, R extends { close(): void }>(
	opts: SessionEngineOpts<F, R>
): SessionEngine<F, R> {
	const { clientId, tab } = opts;
	const isOrdered = opts.isOrdered ?? defaultOrdered;
	let room = opts.room;
	let lockRole: Role | null = null;
	let subordinate = false;
	let persistOwner = true;
	const peers = new Map<string, EnginePeer<F>>();
	let tabRoom: TabRoom<F> | null = null;

	let role: Role | null = null;
	let runtime: R | null = null;
	let relay: RelaySession<F> | null = null;
	let offRelay: (() => void) | null = null;
	/** The member set the current runtime was built over. */
	let builtOver = '';
	let destroyed = false;
	/**
	 * Nothing is decided inside the constructor: a lock that answers at once,
	 * or a document with no room, would otherwise call back into a caller that
	 * has not got the engine yet.
	 */
	let started = false;
	const listeners = new Set<(frame: F) => void>();

	function peerRole(): Role | null {
		if (peers.size === 0) return null;
		// A guest on any link follows that link's sequencer.
		for (const peer of peers.values()) if (peer.role === 'replica') return 'replica';
		return 'sequencer';
	}

	function resolve(): Role | null {
		const fromPeer = peerRole();
		if (fromPeer) return fromPeer;
		if (!room || !tab) return 'sequencer';
		if (lockRole === null) return null;
		return resolveRole({ peerRole: null, lockRole, subordinate });
	}

	function memberKey(): string {
		const ids = [...peers.keys()].sort();
		return `${tabRoom ? `tab:${room}` : ''}|${ids.join(',')}`;
	}

	function teardownRuntime(): void {
		offRelay?.();
		offRelay = null;
		const was = runtime;
		runtime = null;
		relay = null;
		builtOver = '';
		// The runtime owns its transport; closing it closes the relay, whose
		// members are held and so stay open.
		was?.close();
		if (was) opts.onRuntime?.(null);
	}

	function build(next: Role): void {
		const members: RelayMember<F>[] = [];
		if (tabRoom) members.push(held(tabRoom.member));
		for (const [id, peer] of peers) members.push(held({ ...peer.member, id: `peer:${id}` }));
		const session = createRelaySession<F>({
			members,
			forward: (frame) => next === 'replica' || !isOrdered(frame)
		});
		relay = session;
		builtOver = memberKey();
		runtime = opts.runtime({
			role: next,
			clientId,
			send: (frame) => session.send(frame),
			subscribe: (handler) => session.subscribe(handler),
			close: () => session.close()
		});
		// After the runtime: the relay hands frames that beat every subscriber to
		// the first one, and that must be the runtime (a join snapshot).
		offRelay = session.subscribe((frame) => {
			for (const fn of [...listeners]) fn(frame);
		});
		opts.onRuntime?.(runtime);
	}

	function update(): void {
		if (destroyed || !started) return;
		const next = resolve();
		const changedRole = next !== role;
		const changedMembers = runtime !== null && memberKey() !== builtOver;
		if (!changedRole && !changedMembers) return;
		const previous = role;
		role = next;
		teardownRuntime();
		if (next) build(next);
		if (changedRole && next) opts.onRole?.(next, { promoted: previous === 'replica' && next === 'sequencer' });
	}

	function setPersist(owner: boolean): void {
		if (owner === persistOwner) return;
		persistOwner = owner;
		if (!started) return;
		opts.onPersist?.(owner);
	}

	function syncAnnounce(): void {
		if (!tabRoom || !tab) return;
		const gateway = peers.size > 0;
		if (gateway && !tabRoom.announce) {
			tabRoom.announce = (tab.claim?.announce ?? announceSubordinate)(tab.claimChannel(room), clientId);
		}
		if (!gateway && tabRoom.announce) {
			tabRoom.announce();
			tabRoom.announce = null;
		}
	}

	function leaveRoom(): void {
		if (!tabRoom) return;
		const left = tabRoom;
		tabRoom = null;
		left.announce?.();
		left.stop();
		left.member.close();
		lockRole = null;
		subordinate = false;
	}

	function enterRoom(): void {
		if (!room || !tab) {
			setPersist(true);
			return;
		}
		const joined = room;
		const member = tab.member(joined, clientId);
		const election = tab.election(joined);
		const stopLead = watchLeadership(election, (isLeader) => {
			if (destroyed || room !== joined) return;
			lockRole = isLeader ? 'sequencer' : 'replica';
			update();
		});
		const persist = tab.persist?.(joined) ?? null;
		const stopPersist = persist
			? watchLeadership(persist, (owner) => {
					if (!destroyed && room === joined) setPersist(owner);
				})
			: (setPersist(true), () => {});
		const watch = tab.claim?.watch ?? watchSubordinate;
		const stopClaim = watch(tab.claimChannel(joined), clientId, (next) => {
			if (destroyed || room !== joined || next === subordinate) return;
			subordinate = next;
			update();
		});
		tabRoom = {
			member,
			announce: null,
			stop: () => {
				stopLead();
				stopPersist();
				stopClaim();
				election.destroy();
				persist?.destroy();
			}
		};
		syncAnnounce();
	}

	enterRoom();
	queueMicrotask(() => {
		started = true;
		if (!persistOwner) opts.onPersist?.(false);
		update();
	});

	// A closing tab does not run teardown; this closes the runtime while the
	// channels can still flush a leave.
	const stopUnload = installCollabUnload(() => teardownRuntime());

	return {
		clientId,
		get room() {
			return room;
		},
		get role() {
			return role;
		},
		get runtime() {
			return runtime;
		},
		get persistOwner() {
			return persistOwner;
		},
		get peerIds() {
			return [...peers.keys()];
		},
		setRoom(next) {
			if (destroyed || next === room) return;
			leaveRoom();
			room = next;
			enterRoom();
			update();
		},
		setPeer(id, peer) {
			if (destroyed) {
				peer?.member.close();
				return;
			}
			const previous = peers.get(id);
			if (previous === peer) return;
			if (previous && peer && previous.member === peer.member && previous.role === peer.role) return;
			if (peer) peers.set(id, peer);
			else peers.delete(id);
			syncAnnounce();
			update();
			if (previous && previous.member !== peer?.member) previous.member.close();
		},
		send(frame) {
			relay?.send(frame);
		},
		onFrame(handler) {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
		destroy() {
			if (destroyed) return;
			teardownRuntime();
			destroyed = true;
			stopUnload();
			leaveRoom();
			for (const peer of peers.values()) peer.member.close();
			peers.clear();
		}
	};
}

/**
 * A peer link as a relay member, with the app's wire rules.
 *
 * `outbound` keeps what must not leave this device off the wire (image bytes,
 * window layout). `inbound` makes a frame from another device fit this one
 * (its file ids remapped to ours); it may be async, and frames are still
 * delivered in the order they arrived.
 */
export function peerMember<F>(
	id: string,
	link: { send(frame: F): void; subscribe(handler: (frame: F) => void): () => void; close(): void },
	codec?: { outbound?: (frame: F) => F; inbound?: (frame: F) => F | Promise<F> }
): RelayMember<F> {
	const outbound = codec?.outbound;
	const inbound = codec?.inbound;
	return {
		id,
		send: (frame) => link.send(outbound ? outbound(frame) : frame),
		subscribe(handler) {
			if (!inbound) return link.subscribe(handler);
			let chain: Promise<void> = Promise.resolve();
			/** Frames still being decoded; a later frame waits behind them. */
			let waiting = 0;
			let live = true;
			const off = link.subscribe((frame) => {
				let decoded: F | Promise<F>;
				try {
					decoded = inbound(frame);
				} catch {
					return;
				}
				if (!(decoded instanceof Promise) && waiting === 0) {
					handler(decoded);
					return;
				}
				waiting += 1;
				const pending = decoded;
				chain = chain
					.then(() => pending)
					.then((next) => {
						if (live) handler(next);
					})
					.catch(() => {})
					.finally(() => {
						waiting -= 1;
					});
			});
			return () => {
				live = false;
				off();
			};
		},
		close: () => link.close()
	};
}
