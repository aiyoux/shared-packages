<script lang="ts">
	import { feIconSvg, type FeIconName } from './feIcons.js';

	let {
		name,
		size = 16,
		class: className = ''
	}: {
		name: FeIconName;
		size?: number;
		class?: string;
	} = $props();
</script>

<span class="fe-ico {className}" style="width:{size}px;height:{size}px" aria-hidden="true">
	{@html feIconSvg(name, size)}
</span>

<style>
	.fe-ico {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		line-height: 0;
	}
	.fe-ico :global(svg) {
		display: block;
	}
	.fe-ico.fe-mark-git {
		color: #3fae7a;
	}
	.fe-ico.fe-mark-project {
		color: var(--accent, #38bdf8);
	}
	.fe-ico.fe-mark-project-git {
		color: #d4a017;
	}
</style>
