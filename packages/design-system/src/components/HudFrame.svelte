<script lang="ts">
	/**
	 * Cyber HUD panel — hairline frame with corner brackets.
	 * Visual chrome only; callers own padding, max-width, and content layout.
	 */
	let {
		class: className = '',
		stack = false,
		align = 'center',
		children,
		...rest
	}: {
		class?: string;
		/** Flex column + standard HUD padding (setup cards, dialogs). */
		stack?: boolean;
		align?: 'center' | 'start';
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div
	class="ds-hud {stack ? 'ds-hud--stack' : ''} {stack && align === 'start' ? 'ds-hud--start' : ''} {className}"
	{...rest}
>
	<span class="ds-hud-c ds-hud-tl" aria-hidden="true"></span>
	<span class="ds-hud-c ds-hud-tr" aria-hidden="true"></span>
	<span class="ds-hud-c ds-hud-bl" aria-hidden="true"></span>
	<span class="ds-hud-c ds-hud-br" aria-hidden="true"></span>
	<div class="ds-hud-body">
		{@render children?.()}
	</div>
</div>

<style>
	.ds-hud {
		position: relative;
		border: 1px solid var(--line-strong);
		background: rgb(var(--scrim-rgb) / 0.35);
		border-radius: var(--hud-radius);
	}

	.ds-hud-body {
		display: contents;
	}

	.ds-hud--stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-6) var(--space-5);
		text-align: center;
	}

	.ds-hud--start {
		text-align: start;
	}

	.ds-hud--stack :global(h1),
	.ds-hud--stack :global(h2) {
		margin: 0;
		font-size: var(--text-lg);
		font-weight: 600;
		color: var(--text-primary);
	}

	.ds-hud-c {
		position: absolute;
		width: 12px;
		height: 12px;
		pointer-events: none;
		z-index: 1;
	}
	.ds-hud-tl {
		top: -1px;
		left: -1px;
		border-top: 2px solid var(--accent);
		border-left: 2px solid var(--accent);
	}
	.ds-hud-tr {
		top: -1px;
		right: -1px;
		border-top: 2px solid var(--accent);
		border-right: 2px solid var(--accent);
	}
	.ds-hud-bl {
		bottom: -1px;
		left: -1px;
		border-bottom: 2px solid var(--accent);
		border-left: 2px solid var(--accent);
	}
	.ds-hud-br {
		bottom: -1px;
		right: -1px;
		border-bottom: 2px solid var(--accent);
		border-right: 2px solid var(--accent);
	}
</style>
