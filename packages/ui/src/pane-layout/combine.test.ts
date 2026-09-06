import { beforeEach, describe, expect, it } from 'vitest';
import {
	combineLeaves,
	combineTargets,
	leafRects,
	treeFromTiles
} from './combine.ts';
import { createLeaf, resetLayoutIdsForTests, splitLeaf } from './tree.ts';

beforeEach(() => {
	resetLayoutIdsForTests();
});

function close(a: number, b: number) {
	expect(a).toBeCloseTo(b, 4);
}

describe('pane combine', () => {
	it('absorbs an equal-size sibling and leaves one window', () => {
		const split = splitLeaf(createLeaf('a'), 'a', 'row', 'after', 0.4)!;
		const b = split.newLeaf.id;
		const targets = combineTargets(split.root, 'a');
		expect(targets).toEqual([
			expect.objectContaining({ side: 'right', towardId: b, removes: true })
		]);
		close(targets[0]!.result.w, 1);
		close(targets[0]!.result.h, 1);
		const next = combineLeaves(split.root, 'a', b)!;
		expect(next.removed).toEqual([b]);
		expect(next.created).toEqual([]);
		expect(next.root).toEqual({ kind: 'leaf', id: 'a' });
	});

	it('slices through a taller neighbor and keeps the remnant', () => {
		const row = splitLeaf(createLeaf('a'), 'a', 'row', 'after', 0.5)!;
		const b = row.newLeaf.id;
		const col = splitLeaf(row.root, b, 'col', 'after', 0.4)!;
		const c = col.newLeaf.id;
		const before = leafRects(col.root);
		close(before.a.w, 0.5);
		close(before.a.h, 1);
		close(before[c]!.y, 0.4);

		const fromC = combineTargets(col.root, c);
		const throughA = fromC.find((t) => t.towardId === 'a');
		expect(throughA).toEqual(
			expect.objectContaining({ side: 'left', towardId: 'a', removes: false })
		);
		close(throughA!.result.x, 0);
		close(throughA!.result.y, 0.4);
		close(throughA!.result.w, 1);
		close(throughA!.result.h, 0.6);

		const next = combineLeaves(col.root, c, 'a')!;
		expect(next.removed).toEqual([]);
		expect(next.created).toEqual([]);
		const after = leafRects(next.root);
		close(after.a.x, 0);
		close(after.a.y, 0);
		close(after.a.w, 0.5);
		close(after.a.h, 0.4);
		close(after[b]!.x, 0.5);
		close(after[b]!.y, 0);
		close(after[b]!.h, 0.4);
		close(after[c]!.x, 0);
		close(after[c]!.y, 0.4);
		close(after[c]!.w, 1);
		close(after[c]!.h, 0.6);
	});

	it('does not offer combine on a side with two smaller neighbors', () => {
		const row = splitLeaf(createLeaf('a'), 'a', 'row', 'after', 0.5)!;
		const b = row.newLeaf.id;
		const col = splitLeaf(row.root, b, 'col', 'after', 0.5)!;
		expect(combineTargets(col.root, 'a').map((t) => t.side)).toEqual([]);
		expect(combineTargets(col.root, col.newLeaf.id).some((t) => t.side === 'left')).toBe(true);
	});

	it('creates a second remnant when slicing through the middle of a neighbor', () => {
		const row = splitLeaf(createLeaf('a'), 'a', 'row', 'after', 0.5)!;
		const b = row.newLeaf.id;
		const lower = splitLeaf(row.root, b, 'col', 'after', 1 / 3)!;
		const mid = lower.newLeaf.id;
		const bottom = splitLeaf(lower.root, mid, 'col', 'after', 0.5)!;
		const c = mid;
		const next = combineLeaves(bottom.root, c, 'a')!;
		expect(next.removed).toEqual([]);
		expect(next.created).toHaveLength(1);
		const after = leafRects(next.root);
		close(after[c]!.x, 0);
		close(after[c]!.w, 1);
		close(after.a.h, 1 / 3);
		close(after[next.created[0]!]!.y, 2 / 3);
	});

	it('rebuilds a two-tile row', () => {
		const tree = treeFromTiles([
			{ id: 'a', rect: { x: 0, y: 0, w: 0.3, h: 1 } },
			{ id: 'b', rect: { x: 0.3, y: 0, w: 0.7, h: 1 } }
		]);
		expect(tree?.kind).toBe('split');
		if (tree?.kind !== 'split') return;
		expect(tree.direction).toBe('row');
		close(tree.ratio, 0.3);
	});
});
