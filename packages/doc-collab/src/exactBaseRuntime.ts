import type { CollabRole, CollabTransport } from './docRuntime.js';

/** Wire vocabulary belongs to the codec; admission and recovery belong here. */
export type ExactBaseEvent<Doc, Op> =
	/** `sequencer`: an authority announcing itself; its numbering starts again. */
	| { kind: 'hello'; clientId: string; sequencer?: boolean }
	| {
			kind: 'ops';
			documentId: string;
			clientId: string;
			submissionId: string;
			seq: number;
			ops: Op[];
	  }
	| { kind: 'snapshot'; documentId: string; seq: number; doc: Doc }
	| { kind: 'ack'; submissionId: string; seq: number }
	/** `submissionId`, when the wire names it: a nack of any other is stale. */
	| { kind: 'nack'; headSeq: number; submissionId?: string }
	| { kind: 'read-only' }
	| { kind: 'resync'; documentId: string; replace: boolean };

export type ExactBaseRuntimeOpts<Doc, Op, Frame> = {
	policy: 'exact-base';
	transport: CollabTransport<Frame>;
	documentId: string;
	port: { snapshot(): Doc; replace(doc: Doc): void; apply(ops: Op[]): void };
	codec: {
		read(frame: Frame): ExactBaseEvent<Doc, Op> | null;
		hello(): Frame;
		recover(documentId: string): Frame;
		ops(
			documentId: string,
			ops: Op[],
			submissionId: string,
			baseSeq: number
		): Frame;
		replaced(documentId: string): Frame;
	};
	/** The authority adapter supplies the document's admission/reduction and wire encoding. */
	authority: {
		readonly head: number;
		snapshot(): Frame;
		handle(frame: Frame): { to: 'all' | 'sender'; frame: Frame }[];
		replace(doc: Doc): Frame;
	} | null;
	canSubmit?: () => boolean;
	/**
	 * The document after `ops`, as the authority reduces it, and document
	 * equality. Together they let a replica keep what it shows across a new
	 * authority (`adopt`); without them that authority's snapshot replaces it.
	 */
	reduce?: (doc: Doc, ops: Op[]) => Doc;
	sameDoc?: (a: Doc, b: Doc) => boolean;
	/** Submissions an earlier runtime of this session never had confirmed. */
	carried?: Op[][];
	onStatus?: (readOnly: boolean) => void;
	onFrame?: (frame: Frame) => void;
	onHello?: () => void;
};

export type ExactBaseRuntime<Doc, Op> = {
	readonly ready: boolean;
	readonly role: CollabRole;
	submit(ops: Op[]): void;
	/** This replica's submissions not yet confirmed, oldest first. Answers after `close`. */
	pending(): Op[][];
	replaceDocument(doc: Doc): void;
	close(): void;
};

/** Exact-base admission is a runtime policy, independent of the app or transport. */
export function createExactBaseRuntime<Doc, Op, Frame>(
	opts: ExactBaseRuntimeOpts<Doc, Op, Frame>
): ExactBaseRuntime<Doc, Op> {
	const { transport, port, codec, authority } = opts;
	let closed = false;
	let readOnly = transport.role === 'replica';
	let joined = !readOnly;
	let documentId = opts.documentId;
	let localSeq = 0;
	let nackHead: number | null = null;
	let latestSnapshot: { seq: number; doc: Doc } | null = null;
	/** The id `queue[0]` went out under, until it is answered. */
	let inFlight: string | null = null;
	/**
	 * This replica's submissions the authority has not confirmed, oldest first.
	 * An authority applies its own at once, so it holds none.
	 */
	const queue: Op[][] = authority ? [] : [...(opts.carried ?? [])];
	/**
	 * Another authority said hello: the one this replica followed is gone (its
	 * tab died, froze and was taken over, or rebuilt for a new member) and the
	 * new one numbers from its own head. Nothing is sent until its snapshot is
	 * reconciled with this page (`adopt`).
	 */
	let rejoining = false;
	const held: { seq: number; ops: Op[] }[] = [];
	const send = (frame: Frame) => {
		if (!closed) transport.send(frame);
	};
	const status = () => opts.onStatus?.(readOnly);
	function emit(
		out: { to: 'all' | 'sender'; frame: Frame }[],
		skipSender = false
	) {
		for (const item of out)
			if (!skipSender || item.to !== 'sender') send(item.frame);
	}
	function flush() {
		if (
			transport.role !== 'replica' ||
			closed ||
			readOnly ||
			!joined ||
			rejoining ||
			inFlight
		)
			return;
		const ops = queue[0];
		if (!ops) return;
		const id = newId();
		inFlight = id;
		send(codec.ops(documentId, ops, id, localSeq));
	}
	function ack(id: string, seq: number) {
		if (inFlight === id) {
			inFlight = null;
			queue.shift();
		}
		localSeq = Math.max(localSeq, seq);
		flush();
	}
	function replace(doc: Doc, seq: number) {
		port.replace(doc);
		localSeq = seq;
		nackHead = null;
		inFlight = null;
		queue.length = 0;
		const later = held
			.splice(0)
			.filter((item) => item.seq > seq)
			.sort((a, b) => a.seq - b.seq);
		status();
		for (const item of later) {
			port.apply(item.ops);
			localSeq = item.seq;
		}
	}
	/**
	 * A new authority's first snapshot, or the join snapshot of a runtime that
	 * carried submissions. Its numbering is not this replica's, so `localSeq`
	 * becomes the snapshot's. The page is kept only when that is sound:
	 *
	 *  - the snapshot is this page: it already holds every queued edit (or
	 *    there were none). Nothing is replaced or re-sent.
	 *  - the snapshot with the queue reduced onto it, in order, is this page:
	 *    the queue was written against exactly that document, so it is sent
	 *    again on the snapshot's head.
	 *  - otherwise the snapshot replaces the page, as a nack's does. An op
	 *    indexes the document it was written against; on any other it lands in
	 *    the wrong place, so it is not replayed.
	 */
	function adopt(doc: Doc, seq: number) {
		const same = opts.sameDoc;
		const mine = port.snapshot();
		if (same && same(doc, mine)) queue.length = 0;
		else if (!same || queue.length === 0 || !foldsTo(doc, mine, same)) {
			replace(doc, seq);
			return;
		}
		localSeq = seq;
		nackHead = null;
		inFlight = null;
		held.length = 0;
	}
	function foldsTo(doc: Doc, mine: Doc, same: (a: Doc, b: Doc) => boolean) {
		const reduce = opts.reduce;
		if (!reduce) return false;
		try {
			return same(
				queue.reduce((acc, ops) => reduce(acc, ops), doc),
				mine
			);
		} catch {
			return false;
		}
	}
	function recover() {
		if (nackHead == null || !latestSnapshot) return;
		if (localSeq >= nackHead && latestSnapshot.seq >= nackHead)
			replace(latestSnapshot.doc, latestSnapshot.seq);
	}
	const off = transport.subscribe((frame) => {
		if (closed) return;
		const event = codec.read(frame);
		if (event)
			switch (event.kind) {
				case 'hello':
					if (event.clientId !== transport.clientId) {
						if (authority) emit(authority.handle(frame));
						else if (event.sequencer && joined) rejoining = true;
						opts.onHello?.();
					}
					break;
				case 'ops':
					if (event.documentId !== documentId) break;
					if (authority && event.clientId !== transport.clientId) {
						const before = authority.head;
						const out = authority.handle(frame);
						if (authority.head > before) {
							const echoed = out
								.map((item) => codec.read(item.frame))
								.find((item) => item?.kind === 'ops');
							port.apply(echoed?.kind === 'ops' ? echoed.ops : event.ops);
							localSeq = authority.head;
						}
						emit(out);
					} else if (event.clientId === transport.clientId) {
						ack(event.submissionId, event.seq);
						recover();
					} else if (nackHead != null) {
						if (event.seq <= nackHead) localSeq = Math.max(localSeq, event.seq);
						else held.push({ seq: event.seq, ops: event.ops });
						recover();
					} else {
						port.apply(event.ops);
						localSeq = event.seq;
					}
					break;
				case 'snapshot': {
					const joining = transport.role === 'replica' && !joined;
					const rejoin = rejoining;
					if (!joining && !rejoin && event.documentId !== documentId) break;
					if (joining || rejoin) documentId = event.documentId;
					latestSnapshot = { seq: event.seq, doc: event.doc };
					if (joining || rejoin) {
						joined = true;
						rejoining = false;
						readOnly = false;
						if (rejoin || queue.length > 0) adopt(event.doc, event.seq);
						else replace(event.doc, event.seq);
						status();
						flush();
					} else {
						if (nackHead != null && event.seq >= nackHead)
							localSeq = Math.max(localSeq, nackHead);
						recover();
					}
					break;
				}
				case 'ack':
					ack(event.submissionId, event.seq);
					recover();
					break;
				case 'nack':
					// Another submission is in flight than the one it names: that one went
					// to an earlier authority, and `adopt` has sent it again since.
					if (inFlight && event.submissionId !== undefined && event.submissionId !== inFlight) break;
					nackHead = event.headSeq;
					inFlight = null;
					queue.length = 0;
					recover();
					break;
				case 'read-only':
					readOnly = true;
					status();
					break;
				case 'resync':
					if (authority) emit(authority.handle(frame));
					else if (event.replace && event.documentId === documentId) {
						nackHead = localSeq;
						send(codec.recover(documentId));
					}
					break;
			}
		opts.onFrame?.(frame);
	});
	send(codec.hello());
	if (authority) send(authority.snapshot());
	status();
	return {
		role: transport.role,
		get ready() {
			return joined && !readOnly;
		},
		submit(ops) {
			if (
				closed ||
				readOnly ||
				opts.canSubmit?.() === false ||
				ops.length === 0
			)
				return;
			if (authority) {
				emit(
					authority.handle(codec.ops(documentId, ops, newId(), authority.head)),
					true
				);
				localSeq = authority.head;
			} else if (joined) {
				queue.push(ops);
				flush();
			}
		},
		pending: () => queue.map((ops) => [...ops]),
		replaceDocument(doc) {
			if (!authority || closed) return;
			const frame = authority.replace(doc);
			localSeq = authority.head;
			send(frame);
			send(codec.replaced(documentId));
		},
		close() {
			if (closed) return;
			closed = true;
			off();
			held.length = 0;
			transport.close();
		}
	};
}

function newId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`op-${Math.random().toString(36).slice(2)}`
	);
}
