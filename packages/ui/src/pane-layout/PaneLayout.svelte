<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode, SplitDirection } from './types.js';
	import { closeLeaf, createLeaf, leafCount, setSplitRatio, splitLeaf } from './tree.js';
	import PaneNode from './PaneNode.svelte';

	let {
		root = $bindable(),
		focusedId = $bindable(null),
		showChrome = true,
		pane
	}: {
		root?: LayoutNode;
		focusedId?: string | null;
		showChrome?: boolean;
		pane: Snippet<[{ id: string; focused: boolean }]>;
	} = $props();

	if (!root) root = createLeaf();
	if (!focusedId) focusedId = root.kind === 'leaf' ? root.id : null;

	const canClose = $derived(leafCount(root) > 1);

	export function splitFocused(direction: SplitDirection = 'row'): string | null {
		const target = focusedId ?? (root.kind === 'leaf' ? root.id : null);
		if (!target) return null;
		return splitAt(target, direction);
	}

	export function splitAt(leafId: string, direction: SplitDirection = 'row'): string | null {
		const next = splitLeaf(root, leafId, direction);
		if (!next) return null;
		root = next.root;
		focusedId = next.newLeaf.id;
		return next.newLeaf.id;
	}

	export function closeFocused(): void {
		if (focusedId) closeAt(focusedId);
	}

	export function closeAt(leafId: string): void {
		const next = closeLeaf(root, leafId);
		root = next;
		if (focusedId === leafId) {
			focusedId = firstLeafId(next);
		}
	}

	function firstLeafId(node: LayoutNode): string {
		return node.kind === 'leaf' ? node.id : firstLeafId(node.first);
	}

	function onResize(splitId: string, deltaRatio: number) {
		const current = findRatio(root, splitId);
		if (current == null) return;
		root = setSplitRatio(root, splitId, current + deltaRatio);
	}

	function findRatio(node: LayoutNode, splitId: string): number | null {
		if (node.kind === 'leaf') return null;
		if (node.id === splitId) return node.ratio;
		return findRatio(node.first, splitId) ?? findRatio(node.second, splitId);
	}
</script>

<div class="pl-root" data-testid="pane-layout">
	<PaneNode
		node={root}
		{focusedId}
		{canClose}
		{showChrome}
		{pane}
		onFocus={(id) => (focusedId = id)}
		onSplit={(id, dir) => splitAt(id, dir)}
		onClose={(id) => closeAt(id)}
		{onResize}
	/>
</div>

<style>
	.pl-root {
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		width: 100%;
		height: 100%;
	}
</style>
