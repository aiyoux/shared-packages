<script lang="ts">
	import SplitHandle from '../pane-layout/SplitHandle.svelte';
	import type { LayoutNode } from '../pane-layout/types.js';
	import { appWindowSlotId } from './leafHome.js';
	import AppWindowTree from './AppWindowTree.svelte';

	let {
		node,
		layoutId,
		testidPrefix,
		onResize
	}: {
		node: LayoutNode;
		layoutId: string;
		testidPrefix: string;
		onResize: (splitId: string, deltaRatio: number) => void;
	} = $props();
</script>

{#if node.kind === 'leaf'}
	<div
		class="aw-slot"
		id={appWindowSlotId(layoutId, node.id)}
		data-aw-slot={node.id}
	></div>
{:else}
	<div
		class="aw-split"
		class:row={node.direction === 'row'}
		class:col={node.direction === 'col'}
		data-testid="{testidPrefix}-split"
		data-aw-id={node.id}
		data-aw-direction={node.direction}
	>
		<div class="aw-child" style="flex: {node.ratio} 1 0;">
			<AppWindowTree node={node.first} {layoutId} {testidPrefix} {onResize} />
		</div>
		<SplitHandle
			axis={node.direction === 'row' ? 'x' : 'y'}
			testid="{testidPrefix}-handle"
			onRatioDelta={(delta) => onResize(node.id, delta)}
		/>
		<div class="aw-child" style="flex: {1 - node.ratio} 1 0;">
			<AppWindowTree node={node.second} {layoutId} {testidPrefix} {onResize} />
		</div>
	</div>
{/if}

<style>
	.aw-slot,
	.aw-split,
	.aw-child {
		display: flex;
		min-width: 0;
		min-height: 0;
		flex: 1 1 0;
		height: 100%;
		width: 100%;
	}
	.aw-split.row {
		flex-direction: row;
	}
	.aw-split.col {
		flex-direction: column;
	}
</style>
