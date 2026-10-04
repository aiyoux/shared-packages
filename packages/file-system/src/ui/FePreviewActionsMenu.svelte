<script lang="ts">
	import type { Snippet } from 'svelte';
	import { anchoredPopup } from '@shared-packages/design-system';
	import FeIcon from './FeIcon.svelte';

	let { children, subject }: { children: Snippet; subject: string } = $props();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		// Selection changes must not leave an old file's menu open.
		subject;
		open = false;
	});

</script>

<div class="fe-preview-menu-wrap">
	<button
		bind:this={trigger}
		type="button"
		class="fe-preview-icon"
		data-testid="fe-preview-actions"
		title="Actions"
		aria-label="Actions"
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={(event) => { event.stopPropagation(); open = !open; }}
	>
		<FeIcon name="ellipsis" size={16} />
	</button>
	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="fe-preview-menu" data-testid="fe-preview-actions-menu" use:anchoredPopup={{ anchor: () => trigger, placement: 'top-start', offset: 4, viewportMargin: 8, onClose: () => (open = false) }} onclick={() => (open = false)}>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.fe-preview-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.fe-preview-icon:hover {
		background: var(--surface-3);
		color: var(--text-primary);
	}
	.fe-preview-menu {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: 180px;
		max-width: calc(100vw - 16px);
		max-height: min(50vh, 320px);
		overflow: auto;
		padding: 4px;
		background: var(--surface-2, #1c1c24);
		color: var(--text-primary);
		border: 1px solid var(--line-hairline, #333);
		border-radius: 4px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
	}
	.fe-preview-menu :global(button) {
		display: flex;
		width: 100%;
		justify-content: flex-start;
		align-items: center;
		gap: 8px;
		height: auto;
		min-height: 0;
		padding: 6px 8px;
		background: none;
		border: none;
		box-shadow: none;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		border-radius: 3px;
		cursor: pointer;
		text-align: left;
	}
	.fe-preview-menu :global(button:hover:not(:disabled)) {
		background: var(--surface-3, #2a2a2a);
	}
	.fe-preview-menu :global(button:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
