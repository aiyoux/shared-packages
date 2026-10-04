import {
	createExactBaseRuntime,
	type ExactBaseRuntime,
	type ExactBaseRuntimeOpts
} from './exactBaseRuntime.js';
import type { DocCommitResult } from './commitResult.js';
import type { LogFrame } from './seqLog.js';
import {
	createFrameRuntime,
	type OrderedFrameRuntime,
	type OrderedFrameRuntimeOpts
} from './frameRuntime.js';

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
		| {
				kind: 'snapshot';
				doc: Doc;
				/**
				 * Ids of the latest edits the document already holds (`appliedIds`):
				 * a replica drops its own resent copies of them.
				 */
				applied?: string[];
				results?: Record<string, DocCommitResult>;
				/**
				 * The file generation the document's content is based on, when it is
				 * a file's (`CollabPort.fileGeneration`). A replica that takes this
				 * document takes its base with it.
				 */
				fileGeneration?: number;
		  }
		| { kind: 'edit' }
		| { kind: 'hello'; role: CollabRole }
		| { kind: 'resync' }
	);

export type CollabPort<Doc> = {
	snapshot: () => Doc;
	/** `applied`: the ids of the latest edits `doc` holds, when the snapshot says. */
	replace: (
		doc: Doc,
		applied?: readonly string[],
		results?: Record<string, DocCommitResult>,
		fileGeneration?: number
	) => void;
	/** The file generation `snapshot()` is based on, sent with a snapshot. */
	fileGeneration?: () => number | null;
	commitResults?: () => Record<string, DocCommitResult>;
	/** The ids of the latest edits the document holds, sent with a snapshot. */
	appliedIds?: () => string[];
	/** False means this edit does not fit the document we hold. */
	apply: (frame: CollabDocFrame<Doc>) => boolean;
	/**
	 * A replica follows a new sequencer, whose snapshot it now holds. Edits
	 * the old one never numbered are the port's to submit again.
	 */
	sequencerChanged?: () => void;
};

export type CollabRuntime = {
	readonly ready: boolean;
	submit: (frame: CollabDocFrame<unknown>) => void;
	close: () => void;
};

type AnyFrame = CollabDocFrame<unknown>;

function fileGenerationOf<D>(port: CollabPort<D>): { fileGeneration?: number } {
	const generation = port.fileGeneration?.();
	return typeof generation === 'number' ? { fileGeneration: generation } : {};
}

const LOG_KINDS = new Set(['snapshot', 'edit']);
const CONTROL_KINDS = new Set(['hello', 'resync']);

export type CollabRuntimeOpts<Doc> = {
	transport: CollabTransport<AnyFrame>;
	port: CollabPort<Doc>;
	/** Default `optimistic`. See the module comment before choosing. */
	apply?: 'optimistic' | 'sequenced';
};

export function createCollabRuntime<
	F extends LogFrame & { sequencer?: string }
>(opts: OrderedFrameRuntimeOpts<F>): OrderedFrameRuntime<F>;
export function createCollabRuntime<Doc, Op, Frame>(
	opts: ExactBaseRuntimeOpts<Doc, Op, Frame>
): ExactBaseRuntime<Doc, Op>;
export function createCollabRuntime<Doc>(
	opts: CollabRuntimeOpts<Doc>
): CollabRuntime;
export function createCollabRuntime<
	Doc,
	Op,
	Frame,
	F extends LogFrame & { sequencer?: string }
>(
	opts:
		| CollabRuntimeOpts<Doc>
		| ExactBaseRuntimeOpts<Doc, Op, Frame>
		| OrderedFrameRuntimeOpts<F>
): CollabRuntime | ExactBaseRuntime<Doc, Op> | OrderedFrameRuntime<F> {
	if ('policy' in opts && opts.policy === 'exact-base')
		return createExactBaseRuntime(opts);
	if ('policy' in opts && opts.policy === 'ordered-frames')
		return createFrameRuntime(opts);
	return createOrderedRuntime(opts);
}

function createOrderedRuntime<Doc>(
	opts: CollabRuntimeOpts<Doc>
): CollabRuntime {
	const { transport, port } = opts;
	const { role, clientId } = transport;
	let closed = false;
	function send(frame: AnyFrame) {
		if (!closed) transport.send(frame);
	}
	function control(kind: 'hello' | 'resync'): AnyFrame {
		return kind === 'hello'
			? {
					kind,
					role: 'replica',
					seq: 0,
					scope: 'doc',
					clientId,
					frameId: newId()
				}
			: { kind, seq: 0, scope: 'doc', clientId, frameId: newId() };
	}
	function resync() {
		if (role === 'replica') {
			send(control('hello'));
			return;
		}
		frames.announce({
			kind: 'snapshot',
			doc: port.snapshot(),
			...(port.appliedIds ? { applied: port.appliedIds() } : {}),
			...(port.commitResults ? { results: port.commitResults() } : {}),
			...fileGenerationOf(port),
			seq: 0,
			scope: 'doc',
			clientId,
			frameId: newId()
		});
	}
	const frames = createFrameRuntime<AnyFrame>({
		policy: 'ordered-frames',
		role,
		clientId,
		send,
		apply: opts.apply,
		replaces: (frame) => frame.kind === 'snapshot',
		isSnapshot: (frame) => frame.kind === 'snapshot',
		applyFrame(frame) {
			if (frame.kind === 'snapshot') {
				port.replace(frame.doc as Doc, frame.applied, frame.results, frame.fileGeneration);
				return true;
			}
			return port.apply(frame as CollabDocFrame<Doc>);
		},
		onRepair: resync,
		onSequencerChange: () => port.sequencerChanged?.()
	});
	const off = transport.subscribe((frame) => {
		if (closed || !frame || typeof frame !== 'object') return;
		if (CONTROL_KINDS.has(frame.kind)) {
			if (role === 'sequencer' && frame.clientId !== clientId) resync();
		} else if (LOG_KINDS.has(frame.kind)) frames.receive(frame);
	});
	resync();
	return {
		get ready() {
			return frames.ready;
		},
		submit: (frame) => frames.submit(frame),
		close() {
			if (closed) return;
			closed = true;
			off();
			frames.close();
			transport.close();
		}
	};
}

function newId(): string {
	const c = globalThis.crypto;
	return typeof c?.randomUUID === 'function'
		? c.randomUUID()
		: `f-${Math.random().toString(36).slice(2)}`;
}
