<script lang="ts" generics="K extends string = string, M = unknown">
	import type { Snippet } from 'svelte';
	import {
		createPointerDrag,
		type PointerDragMods
	} from '../tree-dnd.ts';
	import {
		flattenVisible,
		indexNodes,
		keyboardTarget,
		toIdSet,
		type DropPolicy,
		type TreeDrag,
		type TreeNode as TreeNodeModel,
		type Zone
	} from '../tree-model.ts';
	import TreeNode from './TreeNode.svelte';

	let {
		items,
		selectedId = null,
		expandedIds,
		dropPolicy,
		onDrop,
		onSelect,
		onToggleExpand,
		onActivate,
		leading,
		actions,
		class: className = ''
	}: {
		items: TreeNodeModel<K, M>[];
		selectedId?: string | null;
		expandedIds?: Iterable<string>;
		dropPolicy?: DropPolicy<K, M>;
		onDrop?: (
			drag: TreeDrag<K, M>,
			over: TreeDrag<K, M>,
			zone: Zone,
			mods?: PointerDragMods
		) => void;
		onSelect?: (node: TreeNodeModel<K, M>) => void;
		onToggleExpand?: (node: TreeNodeModel<K, M>) => void;
		onActivate?: (node: TreeNodeModel<K, M>) => void;
		leading?: Snippet<[TreeNodeModel<K, M>]>;
		actions?: Snippet<[TreeNodeModel<K, M>]>;
		class?: string;
	} = $props();

	const expanded = $derived(toIdSet(expandedIds));
	const rows = $derived(flattenVisible(items, expanded));
	const byId = $derived(indexNodes(items));

	const drag = createPointerDrag<K, M>({
		dropPolicy: (d, o) => dropPolicy?.(d, o) ?? [],
		onCommit: (d, o, zone, mods) => onDrop?.(d, o, zone, mods),
		nodeFromEl: (el) => {
			const id = el.dataset.treeId;
			if (!id) return null;
			const node = byId.get(id);
			if (!node) return null;
			return { kind: node.kind, id: node.id, meta: node.meta };
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		const result = keyboardTarget(rows, selectedId, e.key, expanded);
		if (!result) return;
		e.preventDefault();
		if (result.selectId) {
			const node = byId.get(result.selectId);
			if (node) onSelect?.(node);
		}
		if (result.toggleId) {
			const node = byId.get(result.toggleId);
			if (node) onToggleExpand?.(node);
		}
		if (result.activateId) {
			const node = byId.get(result.activateId);
			if (node) onActivate?.(node);
		}
	}
</script>

<div
	class="tree {className}"
	role="tree"
	tabindex="0"
	aria-activedescendant={selectedId ?? undefined}
	onkeydown={handleKeydown}
>
	{#each items as node (node.id)}
		<TreeNode
			{node}
			depth={0}
			{selectedId}
			{expanded}
			{onSelect}
			{onToggleExpand}
			{onActivate}
			onPointerDown={drag.onPointerDown}
			{leading}
			{actions}
			didDrag={drag.didDrag}
		/>
	{/each}
</div>
