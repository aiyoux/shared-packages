import { describe, expect, it } from 'vitest';
import { createCollabRuntime } from './docRuntime.js';
import type { ExactBaseEvent, ExactBaseRuntime } from './exactBaseRuntime.js';
import { admitOnExactBase, createSequencer } from './sequencer.js';

/**
 * Two people edit at once and the authority numbers one first: the other's
 * submission was written on an older head and is refused (nack). A document
 * here is a set of blocks, `{ key: text }`, and an op `key=text` appends to
 * one block, so edits to different blocks commute and edits to one block do
 * not, and an op applied twice shows.
 * Real exact-base runtimes on every side, over one in-order bus that hands
 * every frame to every other member, as a tab bus does.
 */

type Doc = Record<string, string>;
type Wire = ExactBaseEvent<Doc, string> & { baseSeq?: number };
type Member = {
	id: string;
	doc: Doc;
	replaced: number;
	runtime: ExactBaseRuntime<Doc, string>;
	edit(op: string): void;
};

function reduce(doc: Doc, ops: string[]): Doc {
	const next = { ...doc };
	for (const op of ops) {
		const [key, text] = op.split('=');
		next[key] = (next[key] ?? '') + text;
	}
	return next;
}
const same = (a: Doc, b: Doc) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function room() {
	const queue: { from: string; frame: Wire }[] = [];
	const handlers = new Map<string, (frame: Wire) => void>();
	function join(id: string, role: 'sequencer' | 'replica', doc: Doc): Member {
		const core = createSequencer<Doc, string>({ emptyDoc: {}, apply: reduce, admit: admitOnExactBase });
		const m = { id, doc, replaced: 0 } as Member;
		core.seed(doc);
		const snapshot = (): Wire => ({ kind: 'snapshot', documentId: 'doc', seq: core.headSeq, doc: core.doc });
		m.runtime = createCollabRuntime<Doc, string, Wire>({
			policy: 'exact-base',
			documentId: 'doc',
			transport: {
				role,
				clientId: id,
				send: (frame) => queue.push({ from: id, frame }),
				subscribe(handler) {
					handlers.set(id, handler);
					return () => handlers.delete(id);
				},
				close() {}
			},
			port: {
				snapshot: () => m.doc,
				replace(next) {
					m.doc = next;
					m.replaced += 1;
				},
				apply(ops) {
					m.doc = reduce(m.doc, ops);
				}
			},
			codec: {
				read: (frame) => frame,
				hello: () => ({ kind: 'hello', clientId: id, sequencer: role === 'sequencer' }),
				recover: (documentId) => ({ kind: 'resync', documentId, replace: false }),
				ops: (documentId, ops, submissionId, baseSeq) => ({
					kind: 'ops',
					documentId,
					clientId: id,
					submissionId,
					seq: 0,
					baseSeq,
					ops
				}),
				replaced: (documentId) => ({ kind: 'resync', documentId, replace: true })
			},
			authority:
				role === 'sequencer'
					? {
							get head() {
								return core.headSeq;
							},
							snapshot,
							handle(frame) {
								if (frame.kind === 'hello') return [{ to: 'sender', frame: snapshot() }];
								if (frame.kind !== 'ops') return [];
								const decision = core.submit({ baseSeq: frame.baseSeq, ops: frame.ops });
								if (decision.kind === 'reject')
									return [
										{ to: 'sender', frame: { kind: 'nack', headSeq: decision.headSeq, submissionId: frame.submissionId } },
										{ to: 'sender', frame: snapshot() }
									];
								if (decision.kind === 'ignore') return [];
								return [
									{ to: 'all', frame: { ...frame, seq: decision.seq } },
									{ to: 'sender', frame: { kind: 'ack', submissionId: frame.submissionId, seq: decision.seq } }
								];
							},
							replace(next) {
								core.reset(next, core.headSeq + 1);
								return snapshot();
							}
						}
					: null,
			reduce,
			sameDoc: same
		});
		m.edit = (op) => {
			m.doc = reduce(m.doc, [op]);
			m.runtime.submit([op]);
		};
		return m;
	}
	/** Deliver the oldest frame on the bus. */
	function step() {
		const { from, frame } = queue.shift()!;
		for (const [id, handler] of [...handlers]) if (id !== from) handler(frame);
	}
	function drain() {
		for (let guard = 0; queue.length > 0; guard++) {
			if (guard > 1000) throw new Error('bus did not settle');
			step();
		}
	}
	return { join, drain, step, queue };
}

/** A sequencer and two replicas, joined and settled. */
function three(seed: Doc = { title: 'Plan' }) {
	const r = room();
	const a = r.join('a', 'sequencer', seed);
	const b = r.join('b', 'replica', {});
	const c = r.join('c', 'replica', {});
	r.drain();
	return { r, a, b, c };
}

describe('exact-base: another replica on the bus', () => {
	it("applies a sibling replica's edit once, when it is numbered, not its submission too", () => {
		const { r, a, b, c } = three();
		b.edit('intro=Hello');
		r.drain();
		expect(a.doc).toEqual({ title: 'Plan', intro: 'Hello' });
		expect(c.doc).toEqual({ title: 'Plan', intro: 'Hello' });
		// Its own next edit goes on the real head and is admitted.
		c.edit('outro=Bye');
		r.drain();
		expect(a.doc).toEqual({ title: 'Plan', intro: 'Hello', outro: 'Bye' });
		expect(c.replaced).toBe(1);
	});
});

describe('exact-base: edits refused because another was numbered first', () => {
	it('edits to different blocks both survive, on every side', () => {
		const { r, a, b, c } = three();
		b.edit('intro=Hello');
		c.edit('outro=Bye');
		r.drain();
		const both = { title: 'Plan', intro: 'Hello', outro: 'Bye' };
		expect(a.doc).toEqual(both);
		expect(b.doc).toEqual(both);
		expect(c.doc).toEqual(both);
		expect(b.runtime.pending()).toEqual([]);
		expect(c.runtime.pending()).toEqual([]);
		// Kept, not replaced: the refused side's page never went back to the snapshot.
		expect(c.replaced).toBe(1);
	});

	it('edits to the same block: the one numbered first wins everywhere, as before', () => {
		const { r, a, b, c } = three();
		b.edit('title=Mine');
		c.edit('title=Theirs');
		r.drain();
		expect(a.doc).toEqual({ title: 'PlanMine' });
		expect(b.doc).toEqual({ title: 'PlanMine' });
		expect(c.doc).toEqual({ title: 'PlanMine' });
		expect(c.runtime.pending()).toEqual([]);
	});

	it('an edit made while the refusal is answered is kept with the refused one', () => {
		const { r, a, b, c } = three();
		b.edit('intro=Hello');
		c.edit('outro=Bye');
		// B's submission is numbered; C's is refused, but C types on first.
		while (!r.queue.some((item) => item.frame.kind === 'nack')) r.step();
		c.edit('note=Later');
		r.drain();
		const all = { title: 'Plan', intro: 'Hello', outro: 'Bye', note: 'Later' };
		expect(a.doc).toEqual(all);
		expect(b.doc).toEqual(all);
		expect(c.doc).toEqual(all);
	});

	it('a refused batch that touches a block the other edit wrote is dropped whole, not split', () => {
		const { r, a, b, c } = three();
		b.edit('intro=Hello');
		c.edit('outro=Bye');
		c.edit('intro=Hi');
		r.drain();
		expect(a.doc).toEqual({ title: 'Plan', intro: 'Hello' });
		expect(c.doc).toEqual(a.doc);
		expect(b.doc).toEqual(a.doc);
	});

	it('both replicas refused in turn by a busy authority still converge with every edit', () => {
		const { r, a, b, c } = three();
		a.edit('head=1');
		b.edit('intro=Hello');
		c.edit('outro=Bye');
		r.drain();
		const all = { title: 'Plan', head: '1', intro: 'Hello', outro: 'Bye' };
		expect(a.doc).toEqual(all);
		expect(b.doc).toEqual(all);
		expect(c.doc).toEqual(all);
	});
});
