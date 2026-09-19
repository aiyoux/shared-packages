import { describe, expect, it, vi } from 'vitest';
import { admitAlways, admitOnExactBase, createSequencer } from './sequencer.js';

type Doc = string[];
type Op = string;

function make(admit = admitOnExactBase<Op>, body?: (ops: Op[]) => Op[]) {
	return createSequencer<Doc, Op>({
		emptyDoc: [],
		apply: (doc, ops) => [...doc, ...ops],
		admit,
		body
	});
}

describe('seeding', () => {
	it('adopts the first seed and ignores the rest', () => {
		const s = make();
		expect(s.seed(['first'])).toBe(true);
		// Every joiner offers its own. Adopting a later one would replace a
		// document people are already editing with whatever that tab held.
		expect(s.seed(['second'])).toBe(false);
		expect(s.doc).toEqual(['first']);
	});

	it('starts a seeded document at head zero', () => {
		const s = make();
		s.seed(['x']);
		expect(s.headSeq).toBe(0);
	});
});

describe('numbering', () => {
	it('numbers accepted submissions from one, monotonically', () => {
		const s = make();
		s.seed([]);
		expect(s.submit({ baseSeq: 0, ops: ['a'] })).toEqual({ kind: 'accept', seq: 1, ops: ['a'] });
		expect(s.submit({ baseSeq: 1, ops: ['b'] })).toEqual({ kind: 'accept', seq: 2, ops: ['b'] });
		expect(s.doc).toEqual(['a', 'b']);
	});

	it('does not consume a number for a refused submission', () => {
		const s = make();
		s.seed([]);
		expect(s.submit({ baseSeq: 99, ops: ['a'] })).toEqual({ kind: 'reject', headSeq: 0 });
		expect(s.headSeq).toBe(0);
		expect(s.doc).toEqual([]);
		// And the next valid one takes the number the refused one did not.
		expect(s.submit({ baseSeq: 0, ops: ['b'] })).toMatchObject({ seq: 1 });
	});

	it('does not number an empty body', () => {
		// Filtering can empty a submission. Numbering that would advance the
		// head for a frame that changes nothing, and every replica would then
		// see a gap.
		const s = make(admitOnExactBase, (ops) => ops.filter((o) => o !== 'noop'));
		s.seed([]);
		expect(s.submit({ baseSeq: 0, ops: ['noop'] })).toEqual({ kind: 'ignore' });
		expect(s.headSeq).toBe(0);
	});

	it('numbers and applies only the filtered body', () => {
		const s = make(admitOnExactBase, (ops) => ops.filter((o) => o !== 'drop'));
		s.seed([]);
		expect(s.submit({ baseSeq: 0, ops: ['keep', 'drop'] })).toEqual({
			kind: 'accept',
			seq: 1,
			ops: ['keep']
		});
		expect(s.doc).toEqual(['keep']);
	});
});

describe('admission policy', () => {
	it('exact-base refuses anything written against a moved head', () => {
		const s = make(admitOnExactBase);
		s.seed([]);
		s.submit({ baseSeq: 0, ops: ['a'] });
		// Written against head 0, but the head is 1 now: these ops index a
		// document that has moved.
		expect(s.submit({ baseSeq: 0, ops: ['b'] })).toEqual({ kind: 'reject', headSeq: 1 });
	});

	it('admit-always orders everything and refuses nothing', () => {
		// Creative's model. Rejecting on a moved head would turn ordinary
		// concurrent editing into a resync storm, because its frames are scope
		// snapshots resolved last-writer-wins rather than indexed ops.
		const s = make(admitAlways);
		s.seed([]);
		s.submit({ ops: ['a'] });
		expect(s.submit({ ops: ['b'] })).toEqual({ kind: 'accept', seq: 2, ops: ['b'] });
	});

	it('is asked only after the body survives filtering', () => {
		const admit = vi.fn(() => true);
		const s = make(admit, () => []);
		s.seed([]);
		s.submit({ baseSeq: 0, ops: ['a'] });
		expect(admit).not.toHaveBeenCalled();
	});
});

describe('reset', () => {
	it('adopts a document and a head wholesale', () => {
		const s = make();
		s.seed(['old']);
		s.submit({ baseSeq: 0, ops: ['a'] });
		s.reset(['new'], 41);
		expect(s.doc).toEqual(['new']);
		expect(s.headSeq).toBe(41);
		expect(s.submit({ baseSeq: 41, ops: ['b'] })).toMatchObject({ seq: 42 });
	});

	it('counts as seeded, so a stale seed cannot overwrite it', () => {
		const s = make();
		s.reset(['adopted'], 7);
		expect(s.seeded).toBe(true);
		expect(s.seed(['late'])).toBe(false);
		expect(s.doc).toEqual(['adopted']);
	});
});
