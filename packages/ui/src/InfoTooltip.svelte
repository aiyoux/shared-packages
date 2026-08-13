<script lang="ts">
	import Info from '@lucide/svelte/icons/info';

	let {
		info,
		label = 'More information',
		/** Which way the bubble opens from the icon: 'right' extends leftward
		 * (good for icons near the right edge), 'left' extends rightward (good
		 * for icons near the left edge, e.g. inline in a label). */
		align = 'right',
		class: className = ''
	}: {
		info: string;
		label?: string;
		align?: 'left' | 'right';
		class?: string;
	} = $props();
</script>

<span class="info-tooltip {className}">
	<button
		type="button"
		class="info-btn"
		aria-label={label}
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<Info size={14} />
	</button>
	<span class="tooltip-bubble" class:align-left={align === 'left'} role="tooltip">{info}</span>
</span>

<style>
	.info-tooltip {
		position: relative;
		display: inline-flex;
	}

	.info-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--text-muted, var(--color-muted-foreground, #94a3b8));
		cursor: help;
		transition: color 0.15s ease;
	}

	.info-btn:hover,
	.info-btn:focus-visible {
		color: var(--text-primary, var(--color-foreground, #f1f5f9));
		outline: none;
	}

	.tooltip-bubble {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 30;
		width: max-content;
		/* Cap to the viewport so a long bubble never runs off-screen on mobile. */
		max-width: min(260px, calc(100vw - 24px));
		padding: 8px 10px;
		border-radius: 8px;
		/* Fallbacks cover both the connections app tokens (--bg-secondary,
		   --border-hover, --text-secondary) and the hub's --color-* tokens. */
		border: 1px solid var(--border-hover, var(--color-border, rgba(255, 255, 255, 0.12)));
		background: var(--bg-secondary, var(--color-surface, #0f172a));
		color: var(--text-secondary, var(--color-muted-foreground, #94a3b8));
		font-size: 0.78rem;
		font-weight: 400;
		line-height: 1.45;
		text-align: left;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}

	.tooltip-bubble.align-left {
		right: auto;
		left: 0;
	}

	.info-tooltip:hover .tooltip-bubble,
	.info-tooltip:focus-within .tooltip-bubble {
		opacity: 1;
	}
</style>
