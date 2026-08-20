<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode, SplitDirection } from './types.js';
	import { closeLeaf, createLeaf, leafCount, setSplitRatio, splitLeaf } from './tree.js';
	import PaneNode from './PaneNode.svelte';

	let {
		// Default here rather than a `if (!root) root = createLeaf()` guard below:
		// the guard narrowed only at that statement, not inside $derived or the
		// exported functions that run later, which saw `LayoutNode | undefined`
		// (7 type errors).
		//
		// Nuance vs the old guard: $bindable's fallback is local, so a caller who
		// binds an *undefined* root no longer has the initial tree written back to
		// them. It self-heals on the first split (which assigns `root`), and every
		// consumer here passes a root already — but bind an initialised value if
		// you depend on reading the tree before interacting with it.
		root = $bindable(createLeaf()),
		focusedId = $bindable(null),
		showChrome = true,
		onApps,
		onCloseLast,
		pane
	}: {
		root?: LayoutNode;
		focusedId?: string | null;
		showChrome?: boolean;
		/** Chrome "Apps" button — host opens a picker without unmounting the leaf. */
		onApps?: (leafId: string) => void;
		/** Last remaining leaf: host unloads the app instead of removing the pane. */
		onCloseLast?: (leafId: string) => void;
		pane: Snippet<[{ id: string; focused: boolean }]>;
	} = $props();

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
		if (leafCount(root) <= 1) {
			onCloseLast?.(leafId);
			return;
		}
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
		{onApps}
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
