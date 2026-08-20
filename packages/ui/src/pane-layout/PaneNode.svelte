<script lang="ts">
	import type { LayoutNode } from './types.js';
	import { paneLeafSlotId } from './chrome.js';
	import SplitHandle from './SplitHandle.svelte';
	import PaneNode from './PaneNode.svelte';

	let {
		node,
		onResize
	}: {
		node: LayoutNode;
		onResize: (splitId: string, deltaRatio: number) => void;
	} = $props();
</script>

{#if node.kind === 'leaf'}
	<div class="pl-leaf-slot" id={paneLeafSlotId(node.id)} data-pl-slot={node.id}></div>
{:else}
	<div
		class="pl-split"
		class:row={node.direction === 'row'}
		class:col={node.direction === 'col'}
		data-testid="pl-split"
		data-pl-id={node.id}
		data-pl-direction={node.direction}
	>
		<div class="pl-child" style="flex: {node.ratio} 1 0; min-width: 0; min-height: 0;">
			<PaneNode node={node.first} {onResize} />
		</div>
		<SplitHandle
			axis={node.direction === 'row' ? 'x' : 'y'}
			onRatioDelta={(delta) => onResize(node.id, delta)}
		/>
		<div class="pl-child" style="flex: {1 - node.ratio} 1 0; min-width: 0; min-height: 0;">
			<PaneNode node={node.second} {onResize} />
		</div>
	</div>
{/if}

<style>
	.pl-leaf-slot {
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		height: 100%;
		width: 100%;
	}
	.pl-split {
		display: flex;
		min-width: 0;
		min-height: 0;
		flex: 1 1 0;
		height: 100%;
		width: 100%;
	}
	.pl-split.row {
		flex-direction: row;
	}
	.pl-split.col {
		flex-direction: column;
	}
	.pl-child {
		display: flex;
		min-width: 0;
		min-height: 0;
	}
</style>
