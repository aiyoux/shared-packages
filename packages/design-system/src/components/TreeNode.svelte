<script lang="ts" generics="K extends string = string, M = unknown">
	import type { Snippet } from 'svelte';
	import type { TreeDrag, TreeNode as TreeNodeModel } from '../tree-model.ts';
	import { isExpandable } from '../tree-model.ts';
	import TreeNode from './TreeNode.svelte';

	let {
		node,
		depth,
		selectedId = null,
		expanded,
		onSelect,
		onToggleExpand,
		onActivate,
		onPointerDown,
		leading,
		actions,
		didDrag
	}: {
		node: TreeNodeModel<K, M>;
		depth: number;
		selectedId?: string | null;
		expanded: Set<string>;
		onSelect?: (node: TreeNodeModel<K, M>) => void;
		onToggleExpand?: (node: TreeNodeModel<K, M>) => void;
		onActivate?: (node: TreeNodeModel<K, M>) => void;
		onPointerDown?: (e: PointerEvent, drag: TreeDrag<K, M>) => void;
		leading?: Snippet<[TreeNodeModel<K, M>]>;
		actions?: Snippet<[TreeNodeModel<K, M>]>;
		didDrag?: () => boolean;
	} = $props();

	const open = $derived(expanded.has(node.id));
	const expandable = $derived(isExpandable(node));
	const selected = $derived(selectedId === node.id);

	function handleClick(e: MouseEvent) {
		if (didDrag?.()) return;
		const target = e.target as Element | null;
		if (target?.closest('[data-no-drag]')) return;
		onSelect?.(node);
	}

	function handleDblClick(e: MouseEvent) {
		if (didDrag?.()) return;
		e.preventDefault();
		onActivate?.(node);
	}

	function handleChevron(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		if (expandable) onToggleExpand?.(node);
	}

	function handlePointerDown(e: PointerEvent) {
		onPointerDown?.(e, { kind: node.kind, id: node.id, meta: node.meta });
	}
</script>

<div
	class="tree-group"
	data-tree-row
	data-tree-id={node.id}
	data-tree-kind={node.kind}
	data-tree-depth={depth}
	data-testid={node.testId}
>
	<button
		type="button"
		class="tree-row"
		data-tree-bar
		data-state={node.state || undefined}
		role="treeitem"
		aria-selected={selected}
		aria-expanded={expandable ? open : undefined}
		aria-level={depth + 1}
		style:--tree-depth={depth}
		onpointerdown={handlePointerDown}
		onclick={handleClick}
		ondblclick={handleDblClick}
	>
		<span
			class="tree-chevron"
			class:is-collapsed={!open}
			class:is-leaf={!expandable}
			data-no-drag
			onclick={handleChevron}
			aria-hidden="true"
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="6 9 12 15 18 9" />
			</svg>
		</span>
		<div class="tree-row-label">
			{#if leading}
				{@render leading(node)}
			{/if}
			<span class="tree-row-name">{node.label}</span>
			{#if node.detail}
				<span class="tree-row-meta">{node.detail}</span>
			{/if}
		</div>
		{#if actions}
			<div class="tree-row-actions" class:is-open={node.actionsOpen} data-no-drag>
				{@render actions(node)}
			</div>
		{/if}
	</button>

	{#if expandable && open && node.children?.length}
		<div role="group">
			{#each node.children as child (child.id)}
				<TreeNode
					node={child}
					depth={depth + 1}
					{selectedId}
					{expanded}
					{onSelect}
					{onToggleExpand}
					{onActivate}
					{onPointerDown}
					{leading}
					{actions}
					{didDrag}
				/>
			{/each}
		</div>
	{/if}
</div>
