import type {
	LayoutLeaf,
	LayoutNode,
	LayoutSplit,
	SplitDirection,
	SplitPlacement
} from './types.js';

let seq = 0;

export function resetLayoutIdsForTests(): void {
	seq = 0;
}

export function newLayoutId(prefix = 'pane'): string {
	seq += 1;
	return `${prefix}-${seq}`;
}

export function createLeaf(id?: string): LayoutLeaf {
	return { kind: 'leaf', id: id ?? newLayoutId('leaf') };
}

export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export function clampRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.5;
	return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function listLeaves(node: LayoutNode): LayoutLeaf[] {
	if (node.kind === 'leaf') return [node];
	return [...listLeaves(node.first), ...listLeaves(node.second)];
}

export function leafCount(node: LayoutNode): number {
	return listLeaves(node).length;
}

export function splitLeaf(
	node: LayoutNode,
	leafId: string,
	direction: SplitDirection,
	place: SplitPlacement = 'after',
	ratio = 0.5
): { root: LayoutNode; newLeaf: LayoutLeaf } | null {
	if (node.kind === 'leaf') {
		if (node.id !== leafId) return null;
		const neu = createLeaf();
		const first = place === 'before' ? neu : node;
		const second = place === 'before' ? node : neu;
		const root: LayoutSplit = {
			kind: 'split',
			id: newLayoutId('split'),
			direction,
			ratio: clampRatio(ratio),
			first,
			second
		};
		return { root, newLeaf: neu };
	}
	const inFirst = splitLeaf(node.first, leafId, direction, place, ratio);
	if (inFirst) return { root: { ...node, first: inFirst.root }, newLeaf: inFirst.newLeaf };
	const inSecond = splitLeaf(node.second, leafId, direction, place, ratio);
	if (inSecond) return { root: { ...node, second: inSecond.root }, newLeaf: inSecond.newLeaf };
	return null;
}

/**
 * Remove a leaf. Closing the last remaining leaf is a no-op (returns the root).
 */
export function closeLeaf(node: LayoutNode, leafId: string): LayoutNode {
	const next = closeLeafInner(node, leafId);
	return next ?? node;
}

function closeLeafInner(node: LayoutNode, leafId: string): LayoutNode | null {
	if (node.kind === 'leaf') return node.id === leafId ? null : node;
	const first = closeLeafInner(node.first, leafId);
	const second = closeLeafInner(node.second, leafId);
	if (first == null && second == null) return null;
	if (first == null) return second;
	if (second == null) return first;
	if (first === node.first && second === node.second) return node;
	return { ...node, first, second };
}

export function setSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
	if (node.kind === 'leaf') return node;
	if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) };
	const first = setSplitRatio(node.first, splitId, ratio);
	const second = setSplitRatio(node.second, splitId, ratio);
	if (first === node.first && second === node.second) return node;
	return { ...node, first, second };
}

export function findNode(node: LayoutNode, id: string): LayoutNode | null {
	if (node.id === id) return node;
	if (node.kind === 'leaf') return null;
	return findNode(node.first, id) ?? findNode(node.second, id);
}

/**
 * After restoring a tree from storage, bump the id counter so later splits
 * cannot reuse a `leaf-N` / `split-N` that already exists in the snapshot.
 */
export function syncLayoutIdSeq(node: LayoutNode): void {
	let max = seq;
	walk(node);
	seq = max;

	function walk(n: LayoutNode): void {
		const match = /^(?:leaf|split|pane)-(\d+)$/.exec(n.id);
		if (match) {
			const value = Number(match[1]);
			if (Number.isFinite(value) && value > max) max = value;
		}
		if (n.kind === 'split') {
			walk(n.first);
			walk(n.second);
		}
	}
}
