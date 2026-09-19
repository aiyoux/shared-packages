/**
 * The authoritative half of a collab session: what the document is, what number
 * the next change gets, and whether a change is allowed to land at all.
 *
 * Deliberately NOT a frame vocabulary. Documents speaks `ops`/`ack`/`nack`/
 * `snapshot`; Creative speaks page and plate snapshots plus one erase diff.
 * Those are not converging and do not need to — what they share is the state
 * machine underneath, which is this.
 *
 * The part worth injecting is `admit`. Documents requires a submission to name
 * the exact head it was written against, and nacks anything else, because its
 * ops index a document that has since moved. Creative must NOT do that: its
 * frames are scope snapshots resolved last-writer-wins, so rejecting on a moved
 * head would turn ordinary concurrent editing into a resync storm. One default
 * would have been wrong for one of them, so there is no default.
 */

export type SeqDecision<Op> =
	/** Numbered and applied. `seq` is the number to put on the wire. */
	| { kind: 'accept'; seq: number; ops: Op[] }
	/**
	 * Refused: it was written against a head that has moved. The caller repairs
	 * however its protocol does — Documents nacks and re-snapshots.
	 */
	| { kind: 'reject'; headSeq: number }
	/** Nothing to do (an empty body after filtering). */
	| { kind: 'ignore' };

export type Submission<Op> = {
	/** The head this change was written against, when the protocol carries one. */
	baseSeq?: number;
	ops: Op[];
};

export type Sequencer<Doc, Op> = {
	readonly headSeq: number;
	readonly doc: Doc;
	/** True while a seed has been adopted. */
	readonly seeded: boolean;
	/**
	 * Adopt a starting document. FIRST seed wins.
	 *
	 * Later seeds are ignored rather than applied: every joiner offers its own,
	 * and the second one to arrive would otherwise replace a document people
	 * have already been editing with whatever that tab happened to hold.
	 */
	seed(doc: Doc): boolean;
	submit(input: Submission<Op>): SeqDecision<Op>;
	/** Adopt a document and a head wholesale, after a snapshot or a handover. */
	reset(doc: Doc, headSeq: number): void;
};

export function createSequencer<Doc, Op>(opts: {
	emptyDoc: Doc;
	apply: (doc: Doc, ops: Op[]) => Doc;
	/**
	 * Whether this submission may land on the current head. See the note above
	 * on why there is no default.
	 */
	admit: (input: Submission<Op>, headSeq: number) => boolean;
	/**
	 * The ops that actually change the document, of those submitted. Documents
	 * drops `set-children`, which is structural bookkeeping its peers rebuild
	 * themselves. An empty result is an `ignore`, never an empty numbered frame.
	 */
	body?: (ops: Op[]) => Op[];
}): Sequencer<Doc, Op> {
	const body = opts.body ?? ((ops: Op[]) => ops);
	let headSeq = 0;
	let doc = opts.emptyDoc;
	let seeded = false;

	return {
		get headSeq() {
			return headSeq;
		},
		get doc() {
			return doc;
		},
		get seeded() {
			return seeded;
		},

		seed(next) {
			if (seeded) return false;
			seeded = true;
			doc = next;
			headSeq = 0;
			return true;
		},

		submit(input) {
			const ops = body(input.ops);
			if (ops.length === 0) return { kind: 'ignore' };
			if (!opts.admit(input, headSeq)) return { kind: 'reject', headSeq };
			doc = opts.apply(doc, ops);
			headSeq += 1;
			return { kind: 'accept', seq: headSeq, ops };
		},

		reset(next, seq) {
			doc = next;
			headSeq = seq;
			seeded = true;
		}
	};
}

/**
 * Documents' admission rule: a submission must name the exact current head.
 *
 * Exported so it is a named policy rather than an inline lambda — the choice
 * between this and `admitAlways` is the whole difference between the two
 * products' conflict models, and it should be legible at the call site.
 */
export function admitOnExactBase<Op>(input: Submission<Op>, headSeq: number): boolean {
	return input.baseSeq === headSeq;
}

/** Creative's rule: order everything, refuse nothing. See the note above. */
export function admitAlways(): boolean {
	return true;
}
