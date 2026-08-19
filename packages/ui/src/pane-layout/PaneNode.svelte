<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutNode, SplitDirection } from './types.js';
	import { paneChromeSlotId } from './chrome.js';
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
		onApps,
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
		onApps?: (leafId: string) => void;
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
				<div
					class="pl-chrome-app"
					id={paneChromeSlotId(node.id)}
					data-testid="pl-chrome-app"
					data-pl-leaf={node.id}
				></div>
				<div class="pl-chrome-window" data-testid="pl-chrome-window">
					{#if onApps}
						<button
							type="button"
							data-testid="pl-apps"
							title="Choose an app for this pane"
							aria-label="Choose an app for this pane"
							onclick={(e) => {
								e.stopPropagation();
								onApps(node.id);
							}}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
						</button>
					{/if}
					<button
						type="button"
						data-testid="pl-split-row"
						title="Split right"
						aria-label="Split right"
						onclick={(e) => {
							e.stopPropagation();
							onSplit(node.id, 'row');
						}}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>
					</button>
					<button
						type="button"
						data-testid="pl-split-col"
						title="Split down"
						aria-label="Split down"
						onclick={(e) => {
							e.stopPropagation();
							onSplit(node.id, 'col');
						}}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/></svg>
					</button>
					<button
						type="button"
						data-testid="pl-close"
						title="Close pane"
						aria-label="Close pane"
						disabled={!canClose}
						onclick={(e) => {
							e.stopPropagation();
							onClose(node.id);
						}}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
					</button>
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
				{onApps}
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
				{onApps}
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
		justify-content: flex-end;
		gap: 8px;
		flex-shrink: 0;
		min-height: 32px;
		padding: 4px 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--border, #334155) 70%, transparent);
		background: color-mix(in srgb, var(--surface, #1e293b) 88%, transparent);
		font-size: 11px;
	}
	.pl-chrome-app {
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		display: flex;
		align-items: center;
	}
	.pl-chrome-window {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
		padding: 2px;
		border: 1px solid color-mix(in srgb, var(--border, #475569) 70%, transparent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--surface, #1e293b) 70%, #000);
	}
	.pl-chrome-window button {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 5px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.pl-chrome-window button:hover:not(:disabled),
	.pl-chrome-window button:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--border, #475569) 80%, transparent);
		background: color-mix(in srgb, var(--surface, #334155) 55%, transparent);
	}
	.pl-chrome-window button:focus-visible {
		outline: none;
	}
	.pl-chrome-window button:disabled {
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
