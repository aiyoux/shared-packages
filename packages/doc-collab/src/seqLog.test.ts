import { describe, expect, it } from 'vitest';
import { createSeqLog, type LogFrame } from './seqLog.js';

type Frame = LogFrame & { body: string };

function frame(over: Partial<Frame> = {}): Frame {
	return { seq: 0, scope: 'page-1', clientId: 'them', frameId: 'f1', body: 'x', ...over };
}

/** Records what the document was told to do, in order. */
function recorder(accept = true) {
	const applied: Frame[] = [];
	return {
		applied,
		apply: (f: Frame) => {
			if (!accept) return false;
			applied.push(f);
			return true;
		}
	};
}

describe('sequencer', () => {
	it('numbers its own frames from one, monotonically', () => {
		const log = createSeqLog<Frame>({ role: 'sequencer', clientId: 'me' });
		expect(log.stamp(frame()).seq).toBe(1);
		expect(log.stamp(frame()).seq).toBe(2);
		expect(log.head).toBe(2);
	});

	it('numbers a replica frame on arrival and hands back what to broadcast', () => {
		const log = createSeqLog<Frame>({ role: 'sequencer', clientId: 'me' });
		const doc = recorder();
		const out = log.receive(frame({ clientId: 'them' }), doc.apply);
		expect(out).toEqual({ action: 'applied', broadcast: expect.objectContaining({ seq: 1 }) });
		// The stamped frame is what was applied — never the unstamped original.
		expect(doc.applied[0]?.seq).toBe(1);
	});

	it('leaves no hole in the numbering when a frame is refused', () => {
		const log = createSeqLog<Frame>({ role: 'sequencer', clientId: 'me' });
		expect(log.receive(frame(), recorder(false).apply)).toEqual({
			action: 'repair',
			reason: 'rejected'
		});
		expect(log.head).toBe(0);
		// The next frame takes the number the refused one did not.
		expect(log.stamp(frame()).seq).toBe(1);
	});

	it('reports a second sequencer rather than picking a winner', () => {
		const log = createSeqLog<Frame>({ role: 'sequencer', clientId: 'me' });
		expect(log.receive(frame({ seq: 4 }), recorder().apply)).toEqual({
			action: 'repair',
			reason: 'two-sequencers'
		});
	});
});

describe('replica', () => {
	it('sends unstamped and applies what the sequencer numbers', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		expect(log.stamp(frame({ clientId: 'me' })).seq).toBe(0);
		const doc = recorder();
		expect(log.receive(frame({ seq: 1 }), doc.apply)).toEqual({ action: 'applied' });
		expect(log.head).toBe(1);
	});

	it('refuses an unstamped frame — it cannot be ordered', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		expect(log.receive(frame({ seq: 0 }), recorder().apply)).toEqual({
			action: 'repair',
			reason: 'gap'
		});
	});

	it('DROPS a frame that arrives after a newer one — the relay seam', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		log.receive(frame({ seq: 1, body: 'first' }), doc.apply);
		log.receive(frame({ seq: 2, body: 'second' }), doc.apply);
		// seq 1 redelivered, or overtaken across a relay hop.
		expect(log.receive(frame({ seq: 1, body: 'first' }), doc.apply)).toEqual({
			action: 'dropped',
			reason: 'stale'
		});
		expect(doc.applied.map((f) => f.body)).toEqual(['first', 'second']);
	});

	it('asks for repair on a gap rather than applying across it', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		log.receive(frame({ seq: 1 }), doc.apply);
		expect(log.receive(frame({ seq: 3 }), doc.apply)).toEqual({ action: 'repair', reason: 'gap' });
		// Nothing was applied, and the clock did not move past the hole.
		expect(doc.applied).toHaveLength(1);
		expect(log.head).toBe(1);
	});

	it('asks for repair when the document refuses a frame', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		expect(log.receive(frame({ seq: 1 }), recorder(false).apply)).toEqual({
			action: 'repair',
			reason: 'rejected'
		});
	});
});

describe('our own frame coming back', () => {
	it('does not re-apply an uncontended echo, but still moves the clock', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		const sent = log.stamp(frame({ clientId: 'me', frameId: 'mine' }));
		expect(log.receive({ ...sent, seq: 1 }, doc.apply)).toEqual({
			action: 'dropped',
			reason: 'echo'
		});
		expect(doc.applied).toHaveLength(0);
		expect(log.head).toBe(1);
	});

	it('RE-APPLIES an echo when a peer touched the same scope in flight', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		const sent = log.stamp(frame({ clientId: 'me', frameId: 'mine', body: 'mine' }));
		// A peer's frame for the same scope is ordered first. Locally we already
		// hold ours, so applying theirs leaves us disagreeing with everyone else.
		log.receive(frame({ seq: 1, clientId: 'them', body: 'theirs' }), doc.apply);
		log.receive({ ...sent, seq: 2 }, doc.apply);
		expect(doc.applied.map((f) => f.body)).toEqual(['theirs', 'mine']);
	});

	it('leaves a different scope alone', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		const sent = log.stamp(frame({ clientId: 'me', frameId: 'mine', scope: 'page-1' }));
		log.receive(frame({ seq: 1, clientId: 'them', scope: 'page-2' }), doc.apply);
		expect(log.receive({ ...sent, seq: 2 }, doc.apply)).toEqual({
			action: 'dropped',
			reason: 'echo'
		});
	});
});

describe('reset', () => {
	it('adopts the snapshot clock and forgets frames it describes', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		const sent = log.stamp(frame({ clientId: 'me', frameId: 'mine' }));
		log.reset(9);
		expect(log.head).toBe(9);
		// The in-flight frame described a document that no longer exists, so its
		// echo must not be re-applied against the replacement.
		expect(log.receive({ ...sent, seq: 10 }, doc.apply)).toEqual({
			action: 'dropped',
			reason: 'echo'
		});
		expect(doc.applied).toHaveLength(0);
	});
});

describe('a rebasing frame', () => {
	it('seeds a joiner whose clock starts far behind', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		// The sequencer has been running; its seed is numbered where it got to.
		expect(log.receive(frame({ seq: 42 }), doc.apply, { rebase: true })).toEqual({
			action: 'applied'
		});
		expect(log.head).toBe(42);
		// And the stream continues from there without a repair.
		expect(log.receive(frame({ seq: 43 }), doc.apply)).toEqual({ action: 'applied' });
	});

	it('is still refused when it would move the document backwards', () => {
		const log = createSeqLog<Frame>({ role: 'replica', clientId: 'me' });
		const doc = recorder();
		log.receive(frame({ seq: 9 }), doc.apply, { rebase: true });
		expect(log.receive(frame({ seq: 4 }), doc.apply, { rebase: true })).toEqual({
			action: 'dropped',
			reason: 'stale'
		});
		expect(doc.applied).toHaveLength(1);
	});
});

describe('a sequencer seeing its own frame come back', () => {
	it('drops it instead of numbering and applying it twice', () => {
		const log = createSeqLog<Frame>({ role: 'sequencer', clientId: 'me' });
		const doc = recorder();
		const sent = log.stamp(frame({ clientId: 'me', frameId: 'mine' }));
		expect(log.receive(sent, doc.apply)).toEqual({ action: 'dropped', reason: 'echo' });
		expect(doc.applied).toHaveLength(0);
		// And it did not consume a second sequence number.
		expect(log.head).toBe(1);
	});
});
