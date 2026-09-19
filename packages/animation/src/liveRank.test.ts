import { describe, expect, it } from 'vitest';
import { compareDocRank, liveBindAllowed, type DocRank } from './liveRank.js';

const rank = (createdAt: number, docId: string): DocRank => ({ createdAt, docId });

describe('compareDocRank', () => {
	it('orders by createdAt first, and agrees both ways', () => {
		const older = rank(1, 'z');
		const newer = rank(2, 'a');
		expect(compareDocRank(older, newer)).toBe(-1);
		expect(compareDocRank(newer, older)).toBe(1);
		expect(compareDocRank(older, newer)).toBe(-compareDocRank(newer, older));
		expect(compareDocRank(older, older)).toBe(0);
	});

	it('same createdAt, different docId still total-orders', () => {
		const a = rank(10, 'a');
		const b = rank(10, 'b');
		expect(compareDocRank(a, b)).toBe(-1);
		expect(compareDocRank(b, a)).toBe(1);
		expect(compareDocRank(a, b)).toBe(-compareDocRank(b, a));
		expect(compareDocRank(a, a)).toBe(0);
	});
});

describe('liveBindAllowed', () => {
	it('A→B allowed implies B→A refused', () => {
		const from = rank(2, 'A');
		const to = rank(1, 'B');
		expect(liveBindAllowed(from, to)).toBe(true);
		expect(liveBindAllowed(to, from)).toBe(false);
	});

	it('refuses equal ranks', () => {
		const a = rank(5, 'same');
		expect(liveBindAllowed(a, a)).toBe(false);
		expect(liveBindAllowed(a, rank(5, 'same'))).toBe(false);
	});

	it('allows two concurrent live binds A→C and B→C when both are newer than C', () => {
		const A = rank(2, 'A');
		const B = rank(2, 'B');
		const C = rank(1, 'C');
		expect(liveBindAllowed(A, C)).toBe(true);
		expect(liveBindAllowed(B, C)).toBe(true);
		// Neither reverse can be live, so the diamond cannot close a cycle.
		expect(liveBindAllowed(C, A)).toBe(false);
		expect(liveBindAllowed(C, B)).toBe(false);
	});

	it('concurrent A→B and B→A: at most one is allowed', () => {
		const pairs: Array<[DocRank, DocRank]> = [
			[rank(1, 'A'), rank(2, 'B')],
			[rank(2, 'A'), rank(1, 'B')],
			[rank(1, 'A'), rank(1, 'B')],
			[rank(1, 'A'), rank(1, 'A')]
		];
		for (const [A, B] of pairs) {
			const ab = liveBindAllowed(A, B);
			const ba = liveBindAllowed(B, A);
			expect(ab && ba).toBe(false);
		}
	});

	// snapshot / clone / gitPin are not this helper's problem: it takes ranks,
	// not a bind mode, and callers simply do not consult it for those binds.
});
