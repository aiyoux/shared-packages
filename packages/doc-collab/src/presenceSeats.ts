/**
 * Where everyone is in one open document: the one presence every app runs.
 *
 * Carets (Documents), cursors and live ink (Creative) and whatever a hub app
 * paints are all the same thing: each client in the session has one `place`,
 * and the app draws it. This module owns everything else, once:
 *
 *  - **One frame.** `{ kind: 'presence', clientId, state }`. A null state is a
 *    leave. `ping` asks the others to answer with where they are; it carries a
 *    null state and is not a leave.
 *  - **Checked, not trusted.** A peer's place reaches the DOM (an SVG `fill`, a
 *    caret label), so the app's `sanitize` decides what is kept. A state it
 *    rejects removes the seat.
 *  - **Latest wins.** Sends are rate-limited keeping the newest state, never
 *    the first: the frame most likely to be dropped otherwise is the last one.
 *  - **No clock.** A seat goes when its client says so, or when the transport
 *    says that client is gone: a tab's bus turns "that tab's lock was
 *    released" into a leave (`browserEngineTab`), and the session engine does
 *    the same for a peer link it drops. Nothing is swept on a timer.
 *
 * Seats sit on the process-wide `presenceBoard` under `<room>:<clientId>` —
 * the room's seats as this client sees them — so tree dots, carets and
 * cursors read one table, and two sessions of one room in a tab (two editor
 * instances) never clear each other's.
 */
import { presenceBoard } from './presenceBoard.js';

export type PresenceFrame<P> = {
	kind: 'presence';
	clientId: string;
	state: P | null;
	/** Ask the others to answer with where they are. Not a leave. */
	ping?: true;
};

export function isPresenceFrame(frame: unknown): frame is PresenceFrame<unknown> {
	const f = frame as { kind?: unknown; clientId?: unknown } | null;
	return !!f && typeof f === 'object' && f.kind === 'presence' && typeof f.clientId === 'string';
}

/** The frame that says `clientId` has gone. Made up by a transport that knows it. */
export function presenceLeave(clientId: string): PresenceFrame<never> {
	return { kind: 'presence', clientId, state: null };
}

type Timer = ReturnType<typeof setTimeout>;

export type PresenceSeatsOpts<P> = {
	clientId: string;
	send(frame: PresenceFrame<P>): void;
	/** Keep what may reach the DOM; null drops the seat. */
	sanitize(clientId: string, raw: unknown): P | null;
	/** Every seat but ours, whenever one changes. */
	onChange(seats: ReadonlyMap<string, P>): void;
	/** The session's room, for the `presenceBoard` key. */
	board?: string;
	/** Floor between two sends. Default 0: every change goes at once. */
	throttleMs?: number;
	/**
	 * Whether this client may speak yet. A replica before its join snapshot
	 * must not: its place describes a document that is about to be replaced.
	 */
	canSpeak?: () => boolean;
	/** Where this client is, to answer a ping. Default: the last state sent (none yet: say nothing). */
	current?: () => P | null;
	schedule?: (fn: () => void, ms: number) => Timer;
	cancel?: (handle: Timer) => void;
	now?: () => number;
};

export type PresenceSeats<P> = {
	/** Where this client is now. Null is a leave. */
	set(state: P | null): void;
	/** Ask the others where they are, so a newcomer sees peers who are not moving. */
	ask(): void;
	/** Hand every presence frame here. Anything else is ignored. */
	receive(frame: unknown): void;
	seats(): ReadonlyMap<string, P>;
	/** Leave (if this client ever spoke) and forget every seat. */
	close(): void;
};

export function createPresenceSeats<P>(opts: PresenceSeatsOpts<P>): PresenceSeats<P> {
	const { clientId } = opts;
	const throttleMs = opts.throttleMs ?? 0;
	const canSpeak = opts.canSpeak ?? (() => true);
	const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.cancel ?? ((h) => clearTimeout(h));
	const now = opts.now ?? (() => Date.now());
	const board = presenceBoard<P>(`${opts.board ?? ''}:${clientId}`);
	board.clear();

	let closed = false;
	let timer: Timer | null = null;
	let sentAt = Number.NEGATIVE_INFINITY;
	/** The last state on the wire, re-sent when someone asks. */
	let last: P | null = null;
	/** The newest state not yet on the wire; `undefined` means none waiting. */
	let pending: P | null | undefined;

	function send(frame: PresenceFrame<P>): void {
		try {
			opts.send(frame);
		} catch {
			/* a dead channel must not reach a pointer handler */
		}
	}

	function publish(): void {
		const out = new Map<string, P>();
		for (const seat of board.list()) if (seat.clientId !== clientId) out.set(seat.clientId, seat.place);
		opts.onChange(out);
	}

	function flush(): void {
		timer = null;
		if (closed || pending === undefined || !canSpeak()) return;
		const state = pending;
		pending = undefined;
		sentAt = now();
		last = state;
		send({ kind: 'presence', clientId, state });
	}

	return {
		set(state) {
			if (closed || !canSpeak()) return;
			pending = state;
			if (timer != null) return;
			const wait = throttleMs - (now() - sentAt);
			if (wait <= 0) flush();
			else timer = schedule(flush, wait);
		},
		ask() {
			if (closed) return;
			send({ kind: 'presence', clientId, state: null, ping: true });
		},
		receive(frame) {
			if (closed || !isPresenceFrame(frame) || frame.clientId === clientId) return;
			if (frame.ping) {
				if (!canSpeak()) return;
				const answer = opts.current?.() ?? last;
				if (answer === null) return;
				// Said once, so close owes the others a leave.
				last = answer;
				send({ kind: 'presence', clientId, state: answer });
				return;
			}
			const state = frame.state === null ? null : opts.sanitize(frame.clientId, frame.state);
			if (state === null) {
				if (!board.list().some((seat) => seat.clientId === frame.clientId)) return;
				board.drop(frame.clientId);
			} else {
				board.note(frame.clientId, state);
			}
			publish();
		},
		seats() {
			const out = new Map<string, P>();
			for (const seat of board.list()) out.set(seat.clientId, seat.place);
			return out;
		},
		close() {
			if (closed) return;
			if (timer != null) cancel(timer);
			timer = null;
			// Before `closed`, so the others drop this seat now rather than when
			// the transport notices.
			if (last !== null || pending != null) send({ kind: 'presence', clientId, state: null });
			closed = true;
			last = null;
			pending = undefined;
			const had = board.list().length > 0;
			board.clear();
			if (had) opts.onChange(new Map());
		}
	};
}
