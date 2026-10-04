<script lang="ts">
	import FeIcon from './FeIcon.svelte';
	import type { ExplorerEntry } from './explorerDriver.js';
	import { fileExtensionLabel, fileTypeIcon } from './feThumbnails.js';

	let {
		entry,
		iconSize,
		labelSize = 11
	}: {
		entry: ExplorerEntry;
		iconSize: number;
		labelSize?: number;
	} = $props();

	const label = $derived(fileExtensionLabel(entry.name));
	const icon = $derived(fileTypeIcon(entry));
</script>

<span
	class="fe-type-mark"
	data-testid="fe-type-mark"
	data-icon={icon}
	data-ext={label}
	aria-hidden="true"
>
	<FeIcon name={icon} size={iconSize} />
	{#if label}
		<span class="fe-type-mark-ext" style:font-size="{labelSize}px">{label}</span>
	{/if}
</span>

<style>
	/* The icon and the extension are one group, centered in the tile. */
	.fe-type-mark {
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		color: inherit;
		user-select: none;
	}
	.fe-type-mark-ext {
		max-width: 100%;
		padding: 0 4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.1;
		letter-spacing: 0.03em;
		text-transform: lowercase;
		color: var(--text-muted, #888);
	}
</style>
