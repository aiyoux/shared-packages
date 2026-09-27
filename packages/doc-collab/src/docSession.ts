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
	| (CollabDocFrame<Doc> & { op?: Op })
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
	sendTransient(payload: unknown): void;
	/** The sequencer wrote the file. Tabs in the same room adopt the generation. */
	announceSaved(generation: number, fingerprint?: string): void;
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
	/** Submitted before any runtime existed; sent once one does. */
	const held: CollabDocFrame<unknown>[] = [];
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
					replace(next) {
						doc = next;
						emit('snapshot');
					},
					apply(frame) {
						const op = (frame as CollabDocFrame<Doc> & { op?: Op }).op;
						if (frame.kind !== 'edit' || op === undefined) return true;
						try {
							doc = opts.reduce(doc, op);
						} catch {
							return false;
						}
						emit(frame.clientId === clientId ? 'local' : 'remote');
						return true;
					}
				}
			}),
		onRole: (role, meta) => opts.onRole?.(leaderRole(role), meta),
		onPersist: (owner) => opts.onPersist?.(owner),
		onRuntime: (runtime) => {
			if (!runtime) return;
			for (const frame of held.splice(0)) runtime.submit(frame);
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
			opts.onSaved?.({ seq: frame.seq, generation: frame.generation, local: false, fingerprint: frame.fingerprint });
		}
	});

	function submit(frame: CollabDocFrame<unknown>) {
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
		sendTransient(payload) {
			if (destroyed) return;
			engine.send({ kind: 'transient', payload, seq: 0, scope: 'doc', clientId, frameId: newId() });
		},
		announceSaved(generation, fingerprint) {
			if (destroyed || engine.role !== 'sequencer') return;
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
			offFrames();
			held.length = 0;
			engine.destroy();
		}
	};
}
