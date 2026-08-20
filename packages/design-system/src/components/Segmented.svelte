<script lang="ts">
	/**
	 * Hairline segmented group. Callers render the buttons so testids and
	 * icons stay at the call site; this owns the cyber chrome.
	 *
	 * Selected state: `aria-selected="true"` and/or class `selected`.
	 */
	let {
		label,
		role = 'group',
		class: className = '',
		children,
		...rest
	}: {
		label: string;
		role?: string;
		class?: string;
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div class="ds-seg {className}" {role} aria-label={label} {...rest}>
	{@render children?.()}
</div>

<style>
	.ds-seg {
		display: flex;
		flex-wrap: wrap;
		border: 1px solid var(--line-hairline);
		background: rgb(var(--overlay-rgb) / 0.02);
		border-radius: var(--hud-radius);
	}

	.ds-seg :global(> button) {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: 10px 12px;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text-secondary);
		font-family: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		text-align: center;
		white-space: nowrap;
		cursor: pointer;
	}

	.ds-seg :global(> button + button) {
		border-left: 1px solid var(--line-hairline);
	}

	.ds-seg :global(> button:hover) {
		background: rgb(var(--overlay-rgb) / 0.04);
		color: var(--text-primary);
	}

	.ds-seg :global(> button.selected),
	.ds-seg :global(> button[aria-selected='true']) {
		background: rgb(var(--accent-rgb) / 0.08);
		color: var(--text-primary);
	}
</style>
