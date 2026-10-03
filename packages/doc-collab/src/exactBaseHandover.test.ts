import { describe, expect, it } from 'vitest';
import { createCollabRuntime } from './docRuntime.js';
import type { ExactBaseEvent, ExactBaseRuntime } from './exactBaseRuntime.js';
import { admitOnExactBase, createSequencer } from './sequencer.js';

/**
 * A replica outlives the authority it followed: the authority's tab died, or
 * froze and was taken over, or rebuilt its runtime for a new member. The new
 * authority numbers from zero. These run real exact-base runtimes on both
 * sides over one in-order bus.
 */

type Wire = ExactBaseEvent<string, string> & { baseSeq?: number; from?: string };
type Member = {
	id: string;
	doc: string;
	replaced: number;
	runtime: ExactBaseRuntime<string, string>;
	/** A local edit: the app applies it, then submits it. */
	edit(text: string): void;
	kill(): void;
};

function room() {
	const queue: { from: string; frame: Wire }[] = [];
	const handlers = new Map<string, (frame: Wire) => void>();
	function join(
		id: string,
		role: 'sequencer' | 'replica',
		doc: string,
		carried?: string[][]
	): Member {
		const core = createSequencer<string, string>({
			emptyDoc: '',
			apply: (d, ops) => d + ops.join(''),
			admit: admitOnExactBase
		});
		const m = { id, doc, replaced: 0 } as Member;
		core.seed(doc);
		const snapshot = (): Wire => ({ kind: 'snapshot', documentId: 'doc', seq: core.headSeq, doc: core.doc });
		m.runtime = createCollabRuntime<string, string, Wire>({
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
					m.doc += ops.join('');
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
										{
											to: 'sender',
											frame: { kind: 'nack', headSeq: decision.headSeq, submissionId: frame.submissionId }
										},
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
			reduce: (d, ops) => d + ops.join(''),
			sameDoc: (a, b) => a === b,
			carried
		});
		m.edit = (text) => {
			m.doc += text;
			m.runtime.submit([text]);
		};
		m.kill = () => {
			m.runtime.close();
			handlers.delete(id);
		};
		return m;
	}
	/** Deliver everything, in send order, to every live member but the sender. */
	function drain() {
		for (let guard = 0; queue.length > 0; guard++) {
			if (guard > 1000) throw new Error('bus did not settle');
			const { from, frame } = queue.shift()!;
			for (const [id, handler] of [...handlers]) if (id !== from) handler(frame);
		}
	}
	return { join, drain, queue };
}

describe('exact-base: a new authority', () => {
	it("re-sends the edit in flight to an authority that died, on the new one's head", () => {
		const r = room();
		const a = r.join('a', 'sequencer', 'seed');
		const b = r.join('b', 'replica', '');
		r.drain();
		expect(b.doc).toBe('seed');
		b.edit('!');
		// A's tab dies before it answers.
		a.kill();
		r.drain();
		const c = r.join('c', 'sequencer', 'seed');
		r.drain();
		expect(c.doc).toBe('seed!');
		expect(b.doc).toBe('seed!');
		expect(b.runtime.pending()).toEqual([]);
		// Kept, not replaced: the page never flashed back to the snapshot.
		expect(b.replaced).toBe(1);
	});

	it("rebases on the new authority's head, so the next edit is admitted rather than refused", () => {
		const r = room();
		const a = r.join('a', 'sequencer', 'seed');
		const b = r.join('b', 'replica', '');
		r.drain();
		b.edit('x');
		r.drain();
		b.edit('y');
		r.drain();
		expect(a.doc).toBe('seedxy');
		a.kill();
		const c = r.join('c', 'sequencer', 'seedxy');
		r.drain();
		b.edit('z');
		r.drain();
		expect(c.doc).toBe('seedxyz');
		expect(b.doc).toBe('seedxyz');
		expect(b.replaced).toBe(1);
	});

	it('takes the new authority\'s page when the queued edits were written against another', () => {
		const r = room();
		const a = r.join('a', 'sequencer', 'seed');
		const b = r.join('b', 'replica', '');
		r.drain();
		b.edit('!');
		a.kill();
		r.drain();
		// The new authority's page moved on without them: ops index the page they
		// were written against, so they are not replayed onto this one.
		const c = r.join('c', 'sequencer', 'seed?');
		r.drain();
		expect(b.doc).toBe('seed?');
		expect(c.doc).toBe('seed?');
		expect(b.runtime.pending()).toEqual([]);
	});

	it('does not send twice what the new authority already holds', () => {
		const r = room();
		const a = r.join('a', 'sequencer', 'seed');
		const b = r.join('b', 'replica', '');
		r.drain();
		b.edit('!');
		a.kill();
		r.drain();
		const c = r.join('c', 'sequencer', 'seed!');
		r.drain();
		expect(c.doc).toBe('seed!');
		expect(b.doc).toBe('seed!');
		expect(r.queue).toEqual([]);
	});

	it("an authority rebuilt for a new member: the stale submission's nack does not drop its re-send", () => {
		const r = room();
		const a1 = r.join('a', 'sequencer', 'seed');
		const b = r.join('b', 'replica', '');
		r.drain();
		b.edit('x');
		r.drain();
		// B's next edit is still on the bus when A's tab rebuilds its runtime.
		b.edit('!');
		a1.kill();
		const a2 = r.join('a', 'sequencer', a1.doc);
		r.drain();
		expect(a2.doc).toBe('seedx!');
		expect(b.doc).toBe('seedx!');
		expect(b.runtime.pending()).toEqual([]);
	});

	it('a rebuilt replica carries what its last runtime never had confirmed', () => {
		const r = room();
		const a = r.join('a', 'sequencer', 'seed');
		const b1 = r.join('b', 'replica', '');
		r.drain();
		b1.edit('!');
		a.kill();
		const carried = b1.runtime.pending();
		b1.kill();
		r.drain();
		const c = r.join('c', 'sequencer', 'seed');
		const b2 = r.join('b', 'replica', b1.doc, carried);
		r.drain();
		expect(c.doc).toBe('seed!');
		expect(b2.doc).toBe('seed!');
	});
});
