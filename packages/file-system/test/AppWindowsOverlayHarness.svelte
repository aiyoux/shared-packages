<script lang="ts">
	import AppWindows from '../../ui/src/app-windows/AppWindows.svelte';
	import { anchoredPopup } from '@shared-packages/design-system';
	import type { LayoutNode } from '../../ui/src/pane-layout/types.js';
	let root = $state<LayoutNode>({ kind: 'leaf', id: 'one' });
	let windows = $state<Record<string, { role: 'files' }>>({ one: { role: 'files' } });
	let focusedId = $state('one');
	let slicing = $state(true);
	let open = $state(false);
	let trigger: HTMLButtonElement;
</script>

<output data-testid="slicing">{String(slicing)}</output>
<AppWindows bind:root bind:windows bind:focusedId bind:slicing roles={[{ id: 'files', label: 'Files' }]} fallbackRole="files" inherit={() => ({ role: 'files' })}>
	{#snippet pane()}
		<button bind:this={trigger} data-testid="menu-trigger" onclick={() => (open = true)}>Menu</button>
		{#if open}
			<div use:anchoredPopup={{ anchor: () => trigger, onClose: () => (open = false), focusOnOpen: false }} data-testid="window-popup">Menu content</div>
		{/if}
	{/snippet}
</AppWindows>
