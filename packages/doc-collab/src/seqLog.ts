/**
 * A total order over collab frames, and the integrity checks that order buys.
 *
 * This is deliberately NOT an op algebra. It knows nothing about what a frame
 * means, only how frames relate in time, so a product whose frames are mostly
 * snapshots (Creative) and a product whose frames are mostly ops (Documents)
 * can share it. Semantics stay in the injected `apply`.
 *
 * What it is for, in order of how much it matters:
 *
 *  1. **A relayed frame has no transport ordering.** Each transport orders its
 *     own traffic — SCTP data channels and `BroadcastChannel` both — but a frame
 *     crossing bus → gateway → peer crosses a seam where that guarantee ends.
 *     Without a sequence number an out-of-order snapshot applies older-wins and
 *     nothing notices.
 *  2. **Divergence should be detectable for every frame kind**, not only for the
 *     one kind whose apply happens to return false. A gap in the stream says
 *     something was lost before any document has visibly drifted.
 *  3. **An echo must advance the clock even though it must not re-apply.** The
 *     sender already applied it locally. Dropping it without bookkeeping is what
 *     makes a watermark drift away from the document it describes.
 */

export type SeqRole = 'sequencer' | 'replica';

/**
 * The fields the log needs on a frame. A product's own frame type extends this;
 * everything else on it is opaque here.
 */
export type LogFrame = {
	/** 0 until the sequencer stamps it. Monotonic across the whole document. */
	seq: number;
	/**
	 * What this frame replaces or edits — a page id, a `(page, layer)` pair, a
	 * file id. Frames in different scopes never contend; frames in the same
	 * scope are ordered by `seq`.
	 */
	scope: string;
	/** Who wrote it. Used to recognise our own frame coming back. */
	clientId: string;
	/** Stable per-frame id, assigned by the writer. Survives stamping. */
	frameId: string;
};

export type LogDecision<F> =
	/**
	 * Applied. `broadcast` is set only on a sequencer that has just numbered a
	 * replica's frame: that stamped frame is the one every other participant
	 * must receive, and the unstamped original must never be forwarded.
	 */
	| { action: 'applied'; broadcast?: F }
	| { action: 'dropped'; reason: 'echo' | 'stale' }
	| { action: 'repair'; reason: 'gap' | 'rejected' | 'two-sequencers' };

export type SeqLog<F extends LogFrame> = {
	readonly role: SeqRole;
	/** Highest sequence number this participant has seen. */
	readonly head: number;
	/**
	 * Prepare an outbound frame.
	 *
	 * A sequencer numbers its own frames, because it IS the clock. A replica
	 * sends `seq: 0` and the sequencer numbers it — so a replica's frame is
	 * ordered where it arrives, not where it was written.
	 */
	stamp(frame: F): F;
	/**
	 * Take an inbound frame, decide what it is, and apply it if it should be.
	 *
	 * The log applies rather than the caller, because the watermark and the
	 * document have to move together. A caller that receives a decision and
	 * forgets to report back is the failure this signature removes.
	 *
	 * `apply` returns false when the frame could not be applied to the document
	 * it found — an op whose indices no longer fit. That is a repair, not a drop.
	 */
	receive(
		frame: F,
		apply: (frame: F) => boolean,
		opts?: {
			/**
			 * This frame CONTAINS everything before it — a whole-document
			 * snapshot — so there is no gap it could be missing. It rebases the
			 * clock instead of being checked against it.
			 *
			 * Without this a joining participant is hopeless: it starts at 0 and
			 * the seed it is handed is numbered wherever the document had got
			 * to, which reads as an enormous gap and asks for a repair that
			 * hands back the same frame again.
			 *
			 * Staleness is still enforced. A snapshot older than what we hold
			 * would move the document backwards, which is the one thing the
			 * clock exists to prevent.
			 */
			rebase?: boolean;
		}
	): LogDecision<F>;
	/**
	 * Adopt a snapshot's sequence number after a resync or a join.
	 *
	 * Clears the in-flight set: those frames described a document that has just
	 * been replaced, so their echoes must not re-apply against the new one.
	 */
	reset(seq: number): void;
};

export function createSeqLog<F extends LogFrame>(opts: {
	role: SeqRole;
	clientId: string;
}): SeqLog<F> {
	const { role, clientId } = opts;
	let head = 0;

	/** Last applied sequence number per scope. Only echoes consult it. */
	const scopeSeq = new Map<string, number>();

	/**
	 * Our own frames that have gone out and not yet come back, with the scope
	 * clock as it stood when they left.
	 *
	 * This exists for one case, and it is the case that makes optimistic local
	 * apply safe: we apply our own frame immediately, and if a peer's frame for
	 * the SAME scope is ordered in between, everyone else ends with ours on top
	 * and we end with theirs. Re-applying our frame when its echo lands repairs
	 * that, and comparing the scope clock is how we know it happened.
	 */
	const inFlight = new Map<string, { scope: string; mark: number }>();

	function noteApplied(frame: F): void {
		if (frame.seq > head) head = frame.seq;
		const prev = scopeSeq.get(frame.scope) ?? 0;
		if (frame.seq > prev) scopeSeq.set(frame.scope, frame.seq);
	}

	return {
		role,
		get head() {
			return head;
		},

		stamp(frame) {
			if (role === 'sequencer') {
				const seq = ++head;
				const stamped = { ...frame, seq };
				noteApplied(stamped);
				return stamped;
			}
			inFlight.set(frame.frameId, {
				scope: frame.scope,
				mark: scopeSeq.get(frame.scope) ?? 0
			});
			return { ...frame, seq: 0 };
		},

		receive(frame, apply, opts) {
			// Our own frame, whatever our role. Checked BEFORE the role branch:
			// a sequencer that fell through to its numbering path would stamp
			// and apply its own edit a second time.
			if (frame.clientId === clientId) {
				const pending = inFlight.get(frame.frameId);
				inFlight.delete(frame.frameId);
				const contended = pending ? (scopeSeq.get(pending.scope) ?? 0) !== pending.mark : false;
				// Ordered last for a scope somebody else touched while it was in
				// flight: every other participant ends with ours on top, and we
				// would end with theirs. Re-apply to agree.
				if (contended && apply(frame)) {
					noteApplied(frame);
					return { action: 'applied' };
				}
				noteApplied(frame);
				return { action: 'dropped', reason: 'echo' };
			}

			if (role === 'sequencer') {
				// Only the sequencer numbers frames, so a number we did not
				// assign means a second one is running. Ordering is already
				// ambiguous; say so rather than pick a winner.
				if (frame.seq > 0) return { action: 'repair', reason: 'two-sequencers' };
				// Numbered on arrival, not on write: a replica's frame is
				// ordered where it lands. `head` moves only once the document
				// has actually taken it, so a rejected frame leaves no hole.
				const stamped = { ...frame, seq: head + 1 };
				if (!apply(stamped)) return { action: 'repair', reason: 'rejected' };
				noteApplied(stamped);
				return { action: 'applied', broadcast: stamped };
			}

			// An unstamped frame reaching a replica has bypassed the sequencer —
			// two writers on one document, or a relay forwarding a frame before
			// it was numbered. It cannot be ordered, so it is not applied.
			if (frame.seq <= 0) return { action: 'repair', reason: 'gap' };

			// Already seen, or overtaken by a newer frame — the relay seam, or a
			// transport that redelivered. Applying it would move the document
			// backwards.
			if (frame.seq <= head) return { action: 'dropped', reason: 'stale' };

			// A number we were never handed. Something was lost in between, and
			// the documents may already differ in a way no apply will reveal.
			// A rebasing frame is exempt: it is the whole document, so whatever
			// we missed is inside it.
			if (!opts?.rebase && frame.seq > head + 1) return { action: 'repair', reason: 'gap' };

			if (!apply(frame)) return { action: 'repair', reason: 'rejected' };
			noteApplied(frame);
			return { action: 'applied' };
		},

		reset(seq) {
			head = seq;
			scopeSeq.clear();
			inFlight.clear();
		}
	};
}
