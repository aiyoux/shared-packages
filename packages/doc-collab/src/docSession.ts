/**
 * A document made of ops, on the session engine.
 *
 * The app supplies the reducer. The sequencer applies an edit at once; a
 * replica applies edits in the order the sequencer numbered them, its own
 * included, because ops do not commute. A failed apply is repaired by
 * snapshot. Previews (`sendTransient`) and save notices ride beside the log to
 * every member: other tabs, and devices on an invite or a join.
 *
 * The role is not known until the room's lock answers (or a peer decides it),
 * and a guess is not harmless: a runtime keeps the role it was built with. So
 * edits made before the answer are held, and each role change builds a fresh
 * runtime.
 *
 * Where everyone is (`presence`) is `createPresenceSeats` on the same engine:
 * the app supplies a place type, a `sanitize` and a painter. A tab closing or
 * a link dropping reaches the seats as a leave the engine makes up, so no app
 * sweeps them.
 */
import { DocOpRejected, type DocCommitResult, type DocCommitOptions } from './commitResult.js';
import { createCollabRuntime, type CollabDocFrame, type CollabRuntime } from './docRuntime.js';
import type { Role } from './leadership.js';
import type { LogFrame } from './seqLog.js';
import {
	createPresenceSeats,
	isPresenceFrame,
	type PresenceSeats,
	type PresenceSeatsOpts
} from './presenceSeats.js';
import {
	createSessionEngine,
	type EnginePeer,
	type EngineTab,
	type SessionEngine
} from './sessionEngine.js';

export type DocSessionFrame<Doc, Op> =
	| (CollabDocFrame<Doc> & { op?: Op; confirmed?: boolean })
	| (LogFrame & { kind: 'transient'; payload: unknown })
	| (LogFrame & { kind: 'saved'; generation: number; room: string; fingerprint?: string });

export type DocSessionRole = 'leader' | 'follower';

export type DocSession<Doc, Op> = {
	readonly role: DocSessionRole;
	readonly doc: Doc;
	readonly room: string;
	readonly clientId: string;
	readonly persistOwner: boolean;
	readonly engine: SessionEngine<DocSessionFrame<Doc, Op>, CollabRuntime>;
	commit(op: Op): Promise<void>;
	/** Resolves only when this edit's numbered result is known. Abort cancels the wait, not an applied edit.
	 * requestId supports retries within the retained receipt window (4,096 edits). */
	commitConfirmed(op: Op, options?: DocCommitOptions): Promise<DocCommitResult>;
	sendTransient(payload: unknown): void;
	/** This tab wrote the file. Tabs in the same room adopt the generation. */
	announceSaved(generation: number, fingerprint?: string): void;
	/** The file generation this session last knew: the read that seeded it,
	 *  a save it made, a save another tab in the room announced, or the base
	 *  the sequencer's snapshot carried with its document. CAS anchor
	 *  for session saves — never a fresh read, which would absorb a foreign
	 *  write into the baseline and stamp over it. Null until first anchored. */
	readonly fileGeneration: number | null;
	/** Seed the anchor from a fresh file read. Local: no `saved` frame. */
	adoptFileGeneration(generation: number): void;
	replaceDoc(doc: Doc): void;
	setRoom(room: string): void;
	setPeer(id: string, peer: EnginePeer<DocSessionFrame<Doc, Op>> | null): void;
	/** Seats for everyone in this document. Closing them (or `destroy`) leaves. */
	presence<P>(opts: DocPresenceOpts<P>): PresenceSeats<P>;
	destroy(): void;
};

export type DocPresenceOpts<P> = Omit<PresenceSeatsOpts<P>, 'clientId' | 'send' | 'board'>;

export type DocSessionOpts<Doc, Op> = {
	clientId?: string;
	room: string;
	tab: EngineTab<DocSessionFrame<Doc, Op>> | null;
	initial: Doc;
	reduce: (doc: Doc, op: Op) => Doc;
	onDoc?: (doc: Doc, meta: { reason: 'local' | 'remote' | 'replace' | 'snapshot' }) => void;
	/**
	 * `promoted` is true only when this tab was a follower and now leads — a
	 * real failover. The first answer is not one: every session starts with no
	 * role, and treating that first grant as a takeover made each open re-read
	 * the file over whatever the window had just restored.
	 */
	onRole?: (role: DocSessionRole, meta: { promoted: boolean }) => void;
	onTransient?: (payload: unknown, sender: string) => void;
	onSaved?: (info: { seq: number; generation: number; local: boolean; fingerprint?: string }) => void;
	onPersist?: (owner: boolean) => void;
	/** The file generation the read that seeded `initial` knew, if it is a
	 *  file's content. Anchors `fileGeneration` for save CAS. */
	initialGeneration?: number;
	/** Every frame from any member (numbered ones prove the sequencer runs). */
	onFrame?: (frame: DocSessionFrame<Doc, Op>) => void;
};

function newId(): string {
	const c = globalThis.crypto;
	return typeof c?.randomUUID === 'function' ? c.randomUUID() : `d-${Math.random().toString(36).slice(2)}`;
}

function leaderRole(role: Role): DocSessionRole {
	return role === 'sequencer' ? 'leader' : 'follower';
}

export function createDocSession<Doc, Op>(opts: DocSessionOpts<Doc, Op>): DocSession<Doc, Op> {
	type Frame = DocSessionFrame<Doc, Op>;
	const clientId = opts.clientId ?? newId();
	let doc = opts.initial;
	let destroyed = false;
	/** The file generation this room's reads and saves last knew (see
	 *  `fileGeneration` above). Seeded at bind, moved by `announceSaved`, a
	 *  same-room 'saved' frame and a sequencer snapshot that carries one —
	 *  never by an edit. */
	let fileGeneration: number | null = opts.initialGeneration ?? null;
	/** Submitted while no runtime existed, in order; sent once one does. */
	const held: CollabDocFrame<unknown>[] = [];
	/**
	 * Our edits not yet applied in the sequencer's order, oldest first, by
	 * frame id. When the sequencer's tab dies (or froze and was taken over),
	 * these go to the new one under the same ids, so an edit sent to it is not
	 * lost: to the next runtime when this tab's role changes, and to the same
	 * runtime once it follows the new sequencer when it does not.
	 */
	const unconfirmed = new Map<string, CollabDocFrame<unknown>>();
	/**
	 * Recently applied edit ids. A resent edit the old sequencer did number (and
	 * that reached this document before it died) is not applied twice.
	 */
	const applied = new Set<string>();
	const APPLIED_LIMIT = 4096;
	const SNAPSHOT_APPLIED = 256;
	const results = new Map<string, DocCommitResult>();
	type Waiter = ((result: DocCommitResult) => void) & { fail(error: Error): void };
	const pending = new Map<string, Set<Waiter>>();
	function confirmed(id: string, result: DocCommitResult) {
		results.set(id, result);
		if (results.size > APPLIED_LIMIT) results.delete(results.keys().next().value!);
		unconfirmed.delete(id);
		for (const resolve of [...(pending.get(id) ?? [])]) resolve(result);
	}
	function waitFor(id: string, signal?: AbortSignal): Promise<DocCommitResult> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Edit wait cancelled'));
		const result = results.get(id); if (result) return Promise.resolve(result);
		return new Promise((resolve, reject) => {
			const waiters = pending.get(id) ?? new Set<Waiter>();
			function clean() { waiters.delete(done); if (!waiters.size) pending.delete(id); signal?.removeEventListener('abort', abort); }
			const done: Waiter = Object.assign((value: DocCommitResult) => { clean(); resolve(value); }, { fail(error: Error) { clean(); reject(error); } });
			function abort() { clean(); reject(signal?.reason ?? new Error('Edit wait cancelled')); }
			waiters.add(done); pending.set(id, waiters); signal?.addEventListener('abort', abort, { once: true });
		});
	}

	function noteApplied(frameId: string): void {
		applied.add(frameId);
		if (applied.size <= APPLIED_LIMIT) return;
		const oldest = applied.values().next().value;
		if (oldest !== undefined) applied.delete(oldest);
	}
	/** Every open set of seats; presence frames go to each. */
	const seats = new Set<PresenceSeats<unknown>>();

	function emit(reason: 'local' | 'remote' | 'replace' | 'snapshot') {
		opts.onDoc?.(doc, { reason });
	}

	const engine = createSessionEngine<Frame, CollabRuntime>({
		clientId,
		room: opts.room,
		tab: opts.tab,
		runtime: (transport) =>
			createCollabRuntime<Doc>({
				apply: 'sequenced',
				transport: {
					role: transport.role,
					clientId,
					send: (frame) => transport.send(frame as Frame),
					subscribe: (handler) => transport.subscribe((frame) => handler(frame as CollabDocFrame<unknown>)),
					close: () => transport.close()
				},
				port: {
					snapshot: () => doc,
					// Enough to cover edits in flight across a sequencer change, and
					// small enough to ride every snapshot.
					appliedIds: () => [...applied].slice(-SNAPSHOT_APPLIED),
					commitResults: () => Object.fromEntries(results),
					fileGeneration: () => fileGeneration,
					replace(next, ids, receipts, base) {
						doc = next;
						// The sequencer's document comes with the file read it is based
						// on. A tab that seeded its own anchor from a newer read and then
						// took this document must CAS against this one's base, or its
						// save would stamp over the write between the two reads.
						// A roomless session is another device's (joined over a link): the
						// base is of that device's file, never this one's.
						if (typeof base === 'number' && engine.room) fileGeneration = base;
						if (ids) {
							// The snapshot's document is what this one is now: what it holds
							// is applied, and our copies of those edits are confirmed.
							applied.clear();
							for (const id of ids) {
								noteApplied(id);
								unconfirmed.delete(id);
							}
						}
						if (receipts) results.clear();
						for (const [id, result] of Object.entries(receipts ?? {})) { noteApplied(id); confirmed(id, result); }
						emit('snapshot');
					},
					apply(frame) {
						const op = (frame as CollabDocFrame<Doc> & { op?: Op; confirmed?: boolean }).op;
						if (frame.kind !== 'edit' || op === undefined) return true;
						const known = results.get(frame.frameId);
						if (known) { confirmed(frame.frameId, known); return true; }
						if (applied.has(frame.frameId)) { unconfirmed.delete(frame.frameId); return true; }
						try {
							const next = opts.reduce(doc, op); const changed = next !== doc;
							doc = next; noteApplied(frame.frameId);
							if (changed) emit(frame.clientId === clientId ? 'local' : 'remote');
							if ((frame as Frame & { confirmed?: boolean }).confirmed) confirmed(frame.frameId, { accepted: true, changed });
							else unconfirmed.delete(frame.frameId);
						} catch (error) {
							if (!(error instanceof DocOpRejected)) return false;
							noteApplied(frame.frameId);
							if ((frame as Frame & { confirmed?: boolean }).confirmed) confirmed(frame.frameId, { accepted: false, message: error.message });
							else unconfirmed.delete(frame.frameId);
						}
						return true;
					},
					// The sequencer's tab died (or froze and was taken over) and this
					// replica's runtime outlived it: no rebuild resends for us here.
					sequencerChanged() {
						for (const frame of unconfirmed.values()) if (!applied.has(frame.frameId)) engine.runtime?.submit(frame);
					}
				}
			}),
		onRole: (role, meta) => opts.onRole?.(leaderRole(role), meta),
		onPersist: (owner) => opts.onPersist?.(owner),
		onRuntime: (runtime) => {
			if (!runtime) return;
			// Edits the last runtime sent and never saw applied go first: they were
			// made before anything held since. Then what waited for a runtime.
			const queued = held.splice(0);
			const waiting = new Set(queued.map((frame) => frame.frameId));
			for (const frame of unconfirmed.values()) if (!waiting.has(frame.frameId)) runtime.submit(frame);
			for (const frame of queued) runtime.submit(frame);
		}
	});

	const offFrames = engine.onFrame((frame) => {
		if (destroyed) return;
		opts.onFrame?.(frame);
		if (frame.clientId === clientId) return;
		if (isPresenceFrame(frame)) {
			for (const s of seats) s.receive(frame);
			return;
		}
		if (frame.kind === 'transient') {
			opts.onTransient?.(frame.payload, frame.clientId);
			return;
		}
		if (frame.kind === 'saved' && typeof frame.generation === 'number') {
			// Another device's save is of its own file, not ours.
			if (!engine.room || frame.room !== engine.room) return;
			fileGeneration = frame.generation;
			opts.onSaved?.({ seq: frame.seq, generation: frame.generation, local: false, fingerprint: frame.fingerprint });
		}
	});

	function submit(frame: CollabDocFrame<unknown>) {
		if (frame.kind === 'edit') unconfirmed.set(frame.frameId, frame);
		const runtime = engine.runtime;
		if (!runtime) {
			held.push(frame);
			return;
		}
		runtime.submit(frame);
	}

	return {
		get role() {
			return engine.role ? leaderRole(engine.role) : 'follower';
		},
		get doc() {
			return doc;
		},
		get room() {
			return engine.room;
		},
		clientId,
		get persistOwner() {
			return engine.persistOwner;
		},
		engine,
		commit(op) {
			if (destroyed) return Promise.reject(new Error('session destroyed'));
			submit({ kind: 'edit', op, seq: 0, scope: 'doc', clientId, frameId: newId() } as CollabDocFrame<Doc>);
			return Promise.resolve();
		},
		commitConfirmed(op, options = {}) {
			if (destroyed) return Promise.reject(new Error('session destroyed'));
			if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Edit wait cancelled'));
			const id = options.requestId ?? newId();
			const waiting = waitFor(id, options.signal);
			if (!results.has(id) && !unconfirmed.has(id)) submit({ kind: 'edit', op, confirmed: true, seq: 0, scope: 'doc', clientId, frameId: id } as CollabDocFrame<Doc>);
			return waiting;
		},
		sendTransient(payload) {
			if (destroyed) return;
			engine.send({ kind: 'transient', payload, seq: 0, scope: 'doc', clientId, frameId: newId() });
		},
		announceSaved(generation, fingerprint) {
			// Any tab may have written the file: a window's Save runs in its own
			// tab, follower or not, and every other tab adopts the generation.
			if (destroyed) return;
			fileGeneration = generation;
			engine.send({
				kind: 'saved',
				generation,
				room: engine.room,
				fingerprint,
				seq: 0,
				scope: 'doc',
				clientId,
				frameId: newId()
			});
			opts.onSaved?.({ seq: 0, generation, local: true, fingerprint });
		},
		get fileGeneration() {
			return fileGeneration;
		},
		adoptFileGeneration(generation) {
			if (destroyed) return;
			if (typeof generation !== 'number') return;
			fileGeneration = generation;
		},
		replaceDoc(next) {
			if (destroyed) return;
			submit({ kind: 'snapshot', doc: next, seq: 0, scope: 'doc', clientId, frameId: newId() });
		},
		setRoom(room) {
			engine.setRoom(room);
		},
		setPeer(id, peer) {
			engine.setPeer(id, peer);
		},
		presence<P>(p: DocPresenceOpts<P>): PresenceSeats<P> {
			const inner = createPresenceSeats<P>({
				...p,
				clientId,
				board: engine.room,
				send: (frame) => {
					if (!destroyed) engine.send(frame as unknown as Frame);
				}
			});
			const handle: PresenceSeats<P> = {
				...inner,
				close() {
					seats.delete(handle as PresenceSeats<unknown>);
					inner.close();
				}
			};
			seats.add(handle as PresenceSeats<unknown>);
			return handle;
		},
		destroy() {
			if (destroyed) return;
			for (const s of [...seats]) s.close();
			destroyed = true;
			for (const waiters of [...pending.values()]) for (const waiter of [...waiters]) waiter.fail(new Error('The session ended before this edit was confirmed.'));
			offFrames();
			held.length = 0;
			engine.destroy();
		}
	};
}
