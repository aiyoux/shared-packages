import { describe, expect, it } from 'vitest';
import {
	compareDocRank,
	liveBindAllowed,
	liveBindRefused,
	rankFromAnimDocument,
	rankFromSketchPayload,
	type DocRank
} from './liveRank.js';

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

describe('rankFromAnimDocument / rankFromSketchPayload', () => {
	it('reads travelling envelope fields and ignores a missing rank', () => {
		expect(rankFromAnimDocument({ id: 'A', createdAt: 2 })).toEqual({ docId: 'A', createdAt: 2 });
		expect(rankFromSketchPayload({ id: 'S', createdAt: 1 })).toEqual({ docId: 'S', createdAt: 1 });
		expect(rankFromAnimDocument({ id: undefined, createdAt: undefined })).toBeNull();
		expect(rankFromSketchPayload({})).toBeNull();
		expect(rankFromAnimDocument({ id: 'A' })).toBeNull();
		expect(rankFromSketchPayload({ createdAt: 1 })).toBeNull();
	});

	it('missing rank does not call a fake refuse', () => {
		let refused = 0;
		const fakeRefuse = () => {
			refused += 1;
		};
		const from = rankFromSketchPayload({});
		const to = rankFromAnimDocument({});
		if (from && to && !liveBindAllowed(from, to)) fakeRefuse();
		expect(from).toBeNull();
		expect(to).toBeNull();
		expect(liveBindRefused(from, to)).toBe(false);
		expect(liveBindRefused(null, rank(1, 'B'))).toBe(false);
		expect(liveBindRefused(rank(2, 'A'), null)).toBe(false);
		expect(refused).toBe(0);
		expect(liveBindRefused(rank(1, 'old'), rank(2, 'new'))).toBe(true);
	});
});
