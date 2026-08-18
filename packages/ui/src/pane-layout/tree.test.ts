import { describe, it, expect, beforeEach } from 'vitest';
import {
	closeLeaf,
	createLeaf,
	leafCount,
	listLeaves,
	resetLayoutIdsForTests,
	setSplitRatio,
	splitLeaf
} from './tree.ts';

describe('pane layout tree', () => {
	beforeEach(() => {
		resetLayoutIdsForTests();
	});

	it('starts as a single leaf', () => {
		const root = createLeaf();
		expect(root.kind).toBe('leaf');
		expect(listLeaves(root)).toHaveLength(1);
	});

	it('splits a leaf into a row with a new sibling', () => {
		const root = createLeaf('home');
		const next = splitLeaf(root, 'home', 'row');
		expect(next).not.toBeNull();
		expect(next!.root.kind).toBe('split');
		if (next!.root.kind !== 'split') return;
		expect(next!.root.direction).toBe('row');
		expect(next!.root.ratio).toBe(0.5);
		expect(next!.root.first).toEqual({ kind: 'leaf', id: 'home' });
		expect(next!.root.second).toEqual(next!.newLeaf);
		expect(leafCount(next!.root)).toBe(2);
	});

	it('splits before the target leaf', () => {
		const root = createLeaf('home');
		const next = splitLeaf(root, 'home', 'col', 'before');
		expect(next!.root.kind).toBe('split');
		if (next!.root.kind !== 'split') return;
		expect(next!.root.first).toEqual(next!.newLeaf);
		expect(next!.root.second).toEqual({ kind: 'leaf', id: 'home' });
	});

	it('splits a nested leaf and preserves the other branch', () => {
		const start = splitLeaf(createLeaf('a'), 'a', 'row')!;
		const nested = splitLeaf(start.root, start.newLeaf.id, 'col')!;
		expect(leafCount(nested.root)).toBe(3);
		if (nested.root.kind !== 'split') return;
		expect(nested.root.first).toEqual({ kind: 'leaf', id: 'a' });
		expect(nested.root.second.kind).toBe('split');
	});

	it('returns null when the leaf is missing', () => {
		expect(splitLeaf(createLeaf('a'), 'missing', 'row')).toBeNull();
	});

	it('closing a leaf collapses its parent split', () => {
		const split = splitLeaf(createLeaf('a'), 'a', 'row')!;
		const closed = closeLeaf(split.root, split.newLeaf.id);
		expect(closed).toEqual({ kind: 'leaf', id: 'a' });
	});

	it('refuses to close the last leaf', () => {
		const root = createLeaf('solo');
		expect(closeLeaf(root, 'solo')).toEqual(root);
	});

	it('clamps resize ratio', () => {
		const split = splitLeaf(createLeaf('a'), 'a', 'row')!;
		if (split.root.kind !== 'split') return;
		const wide = setSplitRatio(split.root, split.root.id, 0.99);
		const thin = setSplitRatio(split.root, split.root.id, 0.01);
		expect(wide.kind === 'split' && wide.ratio).toBe(0.85);
		expect(thin.kind === 'split' && thin.ratio).toBe(0.15);
	});
});
