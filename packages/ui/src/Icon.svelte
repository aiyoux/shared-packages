<script lang="ts">
	import { iconSvg, type IconName } from './icons.ts';

	let {
		name,
		size = 18,
		class: className = ''
	}: {
		name: IconName;
		size?: number;
		class?: string;
	} = $props();
</script>

<span class="icon {className}" style="width:{size}px;height:{size}px" aria-hidden="true">
	{@html iconSvg(name, size)}
</span>

<style>
	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		line-height: 0;
	}

	.icon :global(svg) {
		display: block;
	}
</style>
