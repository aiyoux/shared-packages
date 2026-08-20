<script lang="ts">
	import FeIcon from './FeIcon.svelte';
	import type { FeIconName } from './feIcons.js';

	let {
		testid,
		tip,
		icon,
		disabled = false,
		active = false,
		pressed = undefined as boolean | undefined,
		haspopup = false,
		onclick
	}: {
		testid: string;
		tip: string;
		icon: FeIconName;
		disabled?: boolean;
		active?: boolean;
		pressed?: boolean | undefined;
		haspopup?: boolean;
		onclick: () => void;
	} = $props();
</script>

<span class="fe-tip" data-tooltip={tip} data-tooltip-pos="bottom-left" title={tip}>
	<button
		type="button"
		class="ds-btn ds-btn--icon ds-btn--ghost"
		class:active
		data-testid={testid}
		aria-label={tip}
		aria-pressed={pressed}
		aria-haspopup={haspopup ? 'dialog' : undefined}
		{disabled}
		{onclick}
	>
		<FeIcon name={icon} size={15} />
	</button>
</span>

<style>
	.fe-tip {
		display: inline-flex;
	}
	.fe-tip :global(.ds-btn--icon) {
		width: var(--control-h-sm);
		height: var(--control-h-sm);
	}
	.fe-tip :global(.ds-btn:disabled) {
		opacity: 0.35;
	}
</style>
