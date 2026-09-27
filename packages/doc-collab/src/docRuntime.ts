import { createSeqLog, type LogFrame } from './seqLog.js';

/**
 * One collab runtime. The app supplies the document port. Transport, ordering,
 * and repair live here. A false `apply` asks for a snapshot resync.
 *
 * The role is fixed for the life of a runtime: the log numbers frames only if
 * it was built as the sequencer, so a role read live while the log keeps the
 * one it was built with makes the two disagree for good. A host whose role
 * changes closes this runtime and builds another.
 *
 * Two apply modes, because they converge under different conditions:
 *
 *  - `optimistic` (Creative's rule): every participant applies its own frame
 *    at once and drops the echo. Safe only when frames REPLACE what they name,
 *    so the last one wins everywhere whatever order it arrived in.
 *  - `sequenced`: a replica applies its own frame only when it comes back
 *    numbered, in the sequencer's order. Required for operations that do not
 *    commute — two set-ops applied in opposite orders leave two documents
 *    that nothing will ever reconcile.
 */

export type CollabRole = 'sequencer' | 'replica';

export type CollabTransport<F> = {
	readonly role: CollabRole;
	readonly clientId: string;
	send: (frame: F) => void;
	subscribe: (handler: (frame: F) => void) => () => void;
	close: () => void;
};

export type CollabDocFrame<Doc> = LogFrame & {
	/** The sequencer that numbered this frame. Absent until it is numbered. */
	sequencer?: string;
} & (
		| { kind: 'snapshot'; doc: Doc }
		| { kind: 'edit' }
		| { kind: 'hello'; role: CollabRole }
		| { kind: 'resync' }
	);

export type CollabPort<Doc> = {
	snapshot: () => Doc;
	replace: (doc: Doc) => void;
	/** False means this edit does not fit the document we hold. */
	apply: (frame: CollabDocFrame<Doc>) => boolean;
};

export type CollabRuntime = {
	readonly ready: boolean;
	submit: (frame: CollabDocFrame<unknown>) => void;
	close: () => void;
};

type AnyFrame = CollabDocFrame<unknown>;

const LOG_KINDS = new Set(['snapshot', 'edit']);
const CONTROL_KINDS = new Set(['hello', 'resync']);

export function createCollabRuntime<Doc>(opts: {
	transport: CollabTransport<AnyFrame>;
	port: CollabPort<Doc>;
	/** Default `optimistic`. See the module comment before choosing. */
	apply?: 'optimistic' | 'sequenced';
}): CollabRuntime {
	const { transport, port } = opts;
	const role = transport.role;
	const clientId = transport.clientId;
	const sequencedApply = opts.apply === 'sequenced';
	const log = createSeqLog<AnyFrame>({
		role,
		clientId,
		replaces: (frame) => frame.kind === 'snapshot'
	});
	let ready = role === 'sequencer';
	let closed = false;
	/** Replica, sequenced mode: our frames sent but not yet back in order. */
	const awaiting = new Set<string>();
	/** Replica: whose numbering we follow. A new sequencer restarts the count. */
	let following: string | null = null;

	function send(frame: AnyFrame) {
		if (closed) return;
		transport.send(frame);
	}

	function stamp(frame: AnyFrame): AnyFrame {
		return { ...log.stamp(frame), sequencer: clientId };
	}

	function control(kind: 'hello' | 'resync'): AnyFrame {
		return kind === 'hello'
			? { kind, role: 'replica', seq: 0, scope: 'doc', clientId, frameId: newId() }
			: { kind, seq: 0, scope: 'doc', clientId, frameId: newId() };
	}

	function resync() {
		if (role === 'sequencer') {
			send(
				stamp({
					kind: 'snapshot',
					doc: port.snapshot(),
					seq: 0,
					scope: 'doc',
					clientId,
					frameId: newId()
				})
			);
			return;
		}
		send(control('hello'));
	}

	/** Our own frame came back numbered; in sequenced mode this is when it applies. */
	function applyOwnEcho(frame: AnyFrame): boolean {
		if (frame.kind === 'snapshot') {
			port.replace(frame.doc as Doc);
			return true;
		}
		return port.apply(frame as CollabDocFrame<Doc>);
	}

	const off = transport.subscribe((frame) => {
		if (closed || !frame || typeof frame !== 'object') return;
		// Control frames never enter the log. A sequencer answers them; a replica
		// ignores another replica's, which would otherwise read as a gap and be
		// answered with a hello of its own — two replicas asking each other
		// forever.
		if (CONTROL_KINDS.has(frame.kind)) {
			if (role === 'sequencer' && frame.clientId !== clientId) resync();
			return;
		}
		// Anything else sharing the transport (previews, save notices) is not
		// ours. Taking it into the log numbers it or reads it as a gap.
		if (!LOG_KINDS.has(frame.kind)) return;

		if (role === 'replica') {
			// Unnumbered: another replica's frame on its way to the sequencer.
			if (frame.seq <= 0) return;
			if (frame.sequencer && frame.sequencer !== following) {
				if (frame.kind !== 'snapshot') {
					// Numbered by a sequencer we have not joined. Its count is not
					// ours to compare; ask for the document instead.
					send(control('hello'));
					return;
				}
				log.reset(0);
				following = frame.sequencer;
			}
		}

		const own = frame.clientId === clientId;
		const pendingEcho = own && awaiting.delete(frame.frameId);
		const decision = log.receive(
			frame,
			(next) => {
				if (next.kind === 'snapshot') {
					port.replace(next.doc as Doc);
					ready = true;
					return true;
				}
				return port.apply(next as CollabDocFrame<Doc>);
			},
			{ rebase: frame.kind === 'snapshot' }
		);
		if (pendingEcho && decision.action === 'dropped' && decision.reason === 'echo') {
			if (!applyOwnEcho(frame)) resync();
			return;
		}
		if (decision.action === 'repair') resync();
		if (decision.action === 'applied' && decision.broadcast) {
			send({ ...decision.broadcast, sequencer: clientId });
		}
	});

	if (role === 'replica') send(control('hello'));
	// A new sequencer announces itself with the document, so replicas that were
	// following another one restart their count on it instead of dropping every
	// frame it numbers as stale.
	else resync();

	return {
		get ready() {
			return ready;
		},
		submit(frame) {
			if (closed) return;
			if (role === 'sequencer') {
				const stamped = stamp({ ...frame, clientId });
				if (stamped.kind === 'snapshot') port.replace(stamped.doc as Doc);
				else if (!port.apply(stamped as CollabDocFrame<Doc>)) return;
				send(stamped);
				return;
			}
			const local = { ...frame, seq: 0, clientId };
			if (sequencedApply) {
				awaiting.add(local.frameId);
				send(local);
				return;
			}
			if (local.kind === 'snapshot') port.replace(local.doc as Doc);
			else if (local.kind === 'edit' && !port.apply(local as CollabDocFrame<Doc>)) return;
			send(local);
		},
		close() {
			if (closed) return;
			closed = true;
			off();
			transport.close();
		}
	};
}

function newId(): string {
	const c = globalThis.crypto;
	return typeof c?.randomUUID === 'function' ? c.randomUUID() : `f-${Math.random().toString(36).slice(2)}`;
}
