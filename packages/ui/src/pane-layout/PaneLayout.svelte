<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import type { LayoutNode, SplitDirection } from './types.js';
	import { closeLeaf, createLeaf, leafCount, listLeaves, setSplitRatio, splitLeaf } from './tree.js';
	import { createLeafHome, layoutSlotKey } from './leafHome.js';
	import PaneNode from './PaneNode.svelte';
	import PaneLeaf from './PaneLeaf.svelte';

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
		onMinimize,
		onCycleMode,
		minimizedIds = [],
		workspaceMode = 'docked',
		pane
	}: {
		root?: LayoutNode;
		focusedId?: string | null;
		showChrome?: boolean;
		/** Chrome "Apps" button — host opens a picker without unmounting the leaf. */
		onApps?: (leafId: string) => void;
		/** Last remaining leaf: host unloads the app instead of removing the pane. */
		onCloseLast?: (leafId: string) => void;
		/** Minimize button — host docks the pane (e.g. to a tray). */
		onMinimize?: (leafId: string) => void;
		/** Middle button — host cycles docked → floater → fullscreen → docked. */
		onCycleMode?: (leafId: string) => void;
		/** Leaves docked by the host; hidden but kept mounted. */
		minimizedIds?: readonly string[];
		/** Where the whole group lives; drives the middle-button icon. */
		workspaceMode?: 'docked' | 'floating' | 'fullscreen';
		pane: Snippet<[{ id: string; focused: boolean }]>;
	} = $props();

	if (!focusedId) focusedId = root.kind === 'leaf' ? root.id : null;

	const canClose = $derived(leafCount(root) > 1);
	const leaves = $derived(listLeaves(root));
	const slotKey = $derived(layoutSlotKey(root));
	// Per instance: the docked window and every floater each mount a PaneLayout,
	// and a shared registry moved one window's leaves into another's park.
	const home = createLeafHome();

	let parkEl: HTMLElement | null = $state(null);

	// Park keyed leaves before the split tree is torn down, then rehome into
	// the new slots. Resize changes ratio only (slotKey ignores it) so a drag
	// does not blink the panes.
	$effect.pre(() => {
		void slotKey;
		untrack(() => home.parkLeaves(parkEl));
	});
	$effect(() => {
		void slotKey;
		const ids = untrack(() => listLeaves(root).map((leaf) => leaf.id));
		let cancelled = false;
		void tick().then(() => {
			if (!cancelled) home.rehomeLeaves(ids);
		});
		return () => {
			cancelled = true;
		};
	});

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

<div class="pl-host" data-testid="pane-layout">
	<div class="pl-root">
		<PaneNode node={root} {onResize} />
	</div>
	<!-- Keyed leaves live here in the Svelte tree; homeLeaf moves them into
	     the matching slot so split/close can reshape without remounting. -->
	<div class="pl-park" bind:this={parkEl} hidden aria-hidden="true">
		{#each leaves as leaf (leaf.id)}
			<PaneLeaf
				id={leaf.id}
				focused={focusedId === leaf.id}
				{canClose}
				{showChrome}
				{pane}
				{home}
				onFocus={(id) => (focusedId = id)}
				onSplit={(id, dir) => splitAt(id, dir)}
				onClose={(id) => closeAt(id)}
				{onApps}
				{onMinimize}
				{onCycleMode}
				minimized={minimizedIds.includes(leaf.id)}
				workspaceMode={workspaceMode}
				hidden={minimizedIds.includes(leaf.id)}
			/>
		{/each}
	</div>
</div>

<style>
	.pl-host,
	.pl-root {
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		width: 100%;
		height: 100%;
	}
	.pl-host {
		position: relative;
	}
	/* Leaves render inside PaneLeaf, so this must stay global to match them. */
	:global(.pl-leaf.pl-hidden) {
		display: none;
	}
</style>
