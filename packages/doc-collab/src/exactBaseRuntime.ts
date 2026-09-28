import type { CollabRole, CollabTransport } from './docRuntime.js';

/** Wire vocabulary belongs to the codec; admission and recovery belong here. */
export type ExactBaseEvent<Doc, Op> =
	| { kind: 'hello'; clientId: string }
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
	| { kind: 'nack'; headSeq: number }
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
	onStatus?: (readOnly: boolean) => void;
	onFrame?: (frame: Frame) => void;
	onHello?: () => void;
};

export type ExactBaseRuntime<Doc, Op> = {
	readonly ready: boolean;
	readonly role: CollabRole;
	submit(ops: Op[]): void;
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
	let inFlight: string | null = null;
	const outbox: Op[][] = [];
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
			inFlight
		)
			return;
		const ops = outbox.shift();
		if (!ops) return;
		const id = newId();
		inFlight = id;
		send(codec.ops(documentId, ops, id, localSeq));
	}
	function ack(id: string, seq: number) {
		if (inFlight === id) inFlight = null;
		localSeq = Math.max(localSeq, seq);
		flush();
	}
	function replace(doc: Doc, seq: number) {
		port.replace(doc);
		localSeq = seq;
		nackHead = null;
		inFlight = null;
		outbox.length = 0;
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
					if (!joining && event.documentId !== documentId) break;
					if (joining) documentId = event.documentId;
					latestSnapshot = { seq: event.seq, doc: event.doc };
					if (joining) {
						joined = true;
						readOnly = false;
						replace(event.doc, event.seq);
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
					nackHead = event.headSeq;
					inFlight = null;
					outbox.length = 0;
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
				outbox.push(ops);
				flush();
			}
		},
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
			outbox.length = 0;
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
