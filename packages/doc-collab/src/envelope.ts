/**
 * Mux a collab session on the shared `'kb-collab'` CM envelope.
 *
 * `app` is the tenant; absent on the wire means Documents (`kb`). `doc` is
 * optional. When set it is stamped on send and inbound must carry the same
 * `doc` — that is how N documents share one link. A session with no `doc`
 * is the legacy one-document link and still accepts any inbound doc (or none).
 *
 * ⚠️ A NAMED session drops an untagged inbound frame, and that is a deliberate
 * break with peers built before `doc` existed. It cannot be otherwise: once two
 * documents of one app share a link, an untagged frame is ambiguous and there
 * is no correct session to give it to. The plan's earlier rule — "absent `doc`
 * must keep meaning the one document this link was opened for" — is retired,
 * because it is incompatible with the muxing it was written alongside.
 *
 * What is NOT acceptable is dropping it silently, which is how "paired and
 * moving no data" happens. `onUnaddressed` fires once per session so the caller
 * can surface "this peer is too old to share a link".
 * Chunking is injected — Documents does not chunk; Creative does.
 *
 * Envelope `v` is 1 and stays 1. A missing or non-string `frame.kind` is a
 * no-op, never a throw; an unknown string kind is passed through.
 */

/** Which tool a received envelope belongs to. Absent `app` is Documents. */
export const DEFAULT_COLLAB_APP = 'kb';

export type CmEnvelope = {
	type: 'kb-collab';
	v: 1;
	app?: string;
	doc?: string;
	frame: unknown;
};

export type CmEnvelopeChunker<F> = {
	split: (frame: F) => unknown[];
	push: (part: unknown) => F | null;
	reset: () => void;
};

export type CmEnvelopeSession<F> = {
	send: (frame: F) => void;
	subscribe: (handler: (frame: F) => void) => () => void;
	close: () => void;
};

export type CmEnvelopeSessionOpts<F> = {
	sendKb: (msg: CmEnvelope) => void;
	onKb: (handler: (msg: CmEnvelope) => void) => void;
	app: string;
	doc?: string;
	chunk?: CmEnvelopeChunker<F>;
	/** Fires for every accepted complete frame, including those queued before subscribe. */
	onAccept?: (frame: F) => void;
	/**
	 * Fires ONCE when a named session drops an inbound frame carrying no `doc`.
	 *
	 * That means the far side predates doc addressing, so nothing it sends will
	 * ever be accepted here. Silence would look exactly like a quiet link.
	 */
	onUnaddressed?: () => void;
};

function isFrame(value: unknown): value is { kind: string } {
	return !!value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string';
}

export function createCmEnvelopeSession<F>(opts: CmEnvelopeSessionOpts<F>): CmEnvelopeSession<F> {
	const { sendKb, onKb, app, doc, chunk, onAccept, onUnaddressed } = opts;
	const handlers = new Set<(frame: F) => void>();
	const queued: F[] = [];
	let closed = false;
	let warnedUnaddressed = false;

	function emit(frame: F) {
		if (handlers.size === 0) {
			// The runtime subscribes synchronously on construction, but a frame
			// that beats it must not be dropped on the floor.
			queued.push(frame);
		} else {
			for (const handler of handlers) handler(frame);
		}
		// After deliver (or queue), matching createCmCollabSession: snapshot
		// applied first, then ready settles. Firing this first would resolve
		// `ready` before the replica had the page.
		onAccept?.(frame);
	}

	function stamp(frame: unknown): CmEnvelope {
		const msg: CmEnvelope = { type: 'kb-collab', v: 1, frame };
		if (app !== DEFAULT_COLLAB_APP) msg.app = app;
		if (doc !== undefined) msg.doc = doc;
		return msg;
	}

	onKb((msg) => {
		if (closed) return;
		if (!msg || typeof msg !== 'object') return;
		if ((msg.app ?? DEFAULT_COLLAB_APP) !== app) return;
		if (doc !== undefined && (msg.doc ?? null) !== doc) {
			// Untagged from a peer that predates doc addressing: report once, so
			// "nothing arrives" is diagnosable rather than mysterious.
			if (msg.doc === undefined && !warnedUnaddressed) {
				warnedUnaddressed = true;
				onUnaddressed?.();
			}
			return;
		}
		if (!isFrame(msg.frame)) return;
		if (chunk) {
			const complete = chunk.push(msg.frame);
			if (complete) emit(complete);
			return;
		}
		emit(msg.frame as F);
	});

	return {
		send(frame) {
			if (closed) return;
			const parts = chunk ? chunk.split(frame) : [frame];
			for (const part of parts) sendKb(stamp(part));
		},
		subscribe(handler) {
			handlers.add(handler);
			if (queued.length) {
				const pending = queued.splice(0);
				for (const frame of pending) handler(frame);
			}
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			closed = true;
			handlers.clear();
			queued.length = 0;
			chunk?.reset();
		}
	};
}
