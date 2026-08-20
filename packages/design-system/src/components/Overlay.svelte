<script lang="ts">
	/**
	 * Full-viewport scrim + HudFrame dialog. Does not manage focus or scroll lock.
	 * Pass extra attributes (`data-testid`, …) through to the frame.
	 */
	import HudFrame from './HudFrame.svelte';

	let {
		onclose,
		label = 'Dialog',
		closeLabel = 'Close',
		wide = false,
		align = 'center',
		class: className = '',
		children,
		...rest
	}: {
		onclose?: () => void;
		label?: string;
		closeLabel?: string;
		/** Wider panel (scan / camera). Default matches CmPanel wide. */
		wide?: boolean;
		align?: 'center' | 'start';
		class?: string;
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div class="ds-overlay">
	<button type="button" class="ds-overlay-scrim" aria-label={closeLabel} onclick={() => onclose?.()}
	></button>
	<div
		class="ds-overlay-panel {wide ? 'ds-overlay-panel--wide' : ''} {className}"
		role="dialog"
		aria-modal="true"
		aria-label={label}
	>
		<HudFrame stack {align} {...rest}>
			{@render children?.()}
		</HudFrame>
	</div>
</div>

<style>
	.ds-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
	}

	.ds-overlay-scrim {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		margin: 0;
		background: rgb(var(--scrim-rgb) / 0.6);
		cursor: default;
	}

	.ds-overlay-panel {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 480px;
	}

	.ds-overlay-panel--wide {
		max-width: 520px;
	}

	/* Page HUD is a wash over graph paper; dialogs must cover the page. */
	.ds-overlay-panel :global(.ds-hud) {
		background: var(--surface-1);
	}
</style>
