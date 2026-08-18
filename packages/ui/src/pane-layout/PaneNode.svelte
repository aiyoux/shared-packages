<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode, SplitDirection } from './types.js';
	import SplitHandle from './SplitHandle.svelte';
	import PaneNode from './PaneNode.svelte';

	let {
		node,
		focusedId,
		canClose,
		showChrome,
		pane,
		onFocus,
		onSplit,
		onClose,
		onResize
	}: {
		node: LayoutNode;
		focusedId: string | null;
		canClose: boolean;
		showChrome: boolean;
		pane: Snippet<[{ id: string; focused: boolean }]>;
		onFocus: (id: string) => void;
		onSplit: (leafId: string, direction: SplitDirection) => void;
		onClose: (leafId: string) => void;
		onResize: (splitId: string, deltaRatio: number) => void;
	} = $props();
</script>

{#if node.kind === 'leaf'}
	<!-- Focus-on-click only; every pane is also reachable by the layout's own
	     keyboard commands, so no separate key handler belongs here. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="pl-leaf"
		class:focused={focusedId === node.id}
		data-testid="pl-leaf"
		data-pl-id={node.id}
		data-pl-focused={focusedId === node.id ? 'true' : 'false'}
		onclick={() => onFocus(node.id)}
	>
		{#if showChrome}
			<header class="pl-chrome" data-testid="pl-chrome">
				<span class="pl-chrome-id">{node.id}</span>
				<div class="pl-chrome-actions">
					<button
						type="button"
						data-testid="pl-split-row"
						title="Split right"
						onclick={(e) => {
							e.stopPropagation();
							onSplit(node.id, 'row');
						}}>Split →</button
					>
					<button
						type="button"
						data-testid="pl-split-col"
						title="Split down"
						onclick={(e) => {
							e.stopPropagation();
							onSplit(node.id, 'col');
						}}>Split ↓</button
					>
					<button
						type="button"
						data-testid="pl-close"
						title="Close pane"
						disabled={!canClose}
						onclick={(e) => {
							e.stopPropagation();
							onClose(node.id);
						}}>Close</button
					>
				</div>
			</header>
		{/if}
		<div class="pl-body">
			{@render pane({ id: node.id, focused: focusedId === node.id })}
		</div>
	</div>
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
			<PaneNode
				node={node.first}
				{focusedId}
				{canClose}
				{showChrome}
				{pane}
				{onFocus}
				{onSplit}
				{onClose}
				{onResize}
			/>
		</div>
		<SplitHandle
			axis={node.direction === 'row' ? 'x' : 'y'}
			onRatioDelta={(delta) => onResize(node.id, delta)}
		/>
		<div class="pl-child" style="flex: {1 - node.ratio} 1 0; min-width: 0; min-height: 0;">
			<PaneNode
				node={node.second}
				{focusedId}
				{canClose}
				{showChrome}
				{pane}
				{onFocus}
				{onSplit}
				{onClose}
				{onResize}
			/>
		</div>
	</div>
{/if}

<style>
	.pl-leaf,
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
	.pl-leaf {
		flex-direction: column;
		background: var(--surface, #0f172a);
		border: 1px solid color-mix(in srgb, var(--border, #334155) 80%, transparent);
		border-radius: 0;
		overflow: hidden;
	}
	.pl-leaf.focused {
		border-color: color-mix(in srgb, var(--accent, #38bdf8) 70%, transparent);
	}
	.pl-chrome {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-shrink: 0;
		padding: 4px 6px 4px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--border, #334155) 70%, transparent);
		background: color-mix(in srgb, var(--surface, #1e293b) 88%, transparent);
		font-size: 11px;
	}
	.pl-chrome-id {
		opacity: 0.45;
		font-variant-numeric: tabular-nums;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pl-chrome-actions {
		display: flex;
		gap: 4px;
	}
	.pl-chrome-actions button {
		border: 1px solid color-mix(in srgb, var(--border, #475569) 80%, transparent);
		background: transparent;
		color: inherit;
		border-radius: 5px;
		padding: 2px 7px;
		font: inherit;
		cursor: pointer;
	}
	.pl-chrome-actions button:hover:not(:disabled) {
		border-color: var(--accent, #38bdf8);
	}
	.pl-chrome-actions button:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.pl-body {
		flex: 1 1 0;
		min-height: 0;
		min-width: 0;
		overflow: auto;
	}
</style>
