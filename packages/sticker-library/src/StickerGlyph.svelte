<script lang="ts">
	import type { StickerTemplate } from './catalog';

	let {
		sticker,
		label
	}: {
		sticker: StickerTemplate;
		label?: string;
	} = $props();
</script>

<svg
	class="sticker-glyph"
	viewBox="0 0 {sticker.viewBoxWidth} {sticker.viewBoxHeight}"
	role="img"
	aria-label={label ?? sticker.name}
>
	{#each sticker.paths as path, i (i)}
		<path
			d={path.d}
			fill={path.fill}
			stroke={path.stroke}
			stroke-width={path.strokeWidth}
			stroke-linecap="round"
			stroke-linejoin="round"
			fill-rule={path.fillRule || 'nonzero'}
			opacity={path.opacity ?? 1}
		/>
	{/each}
</svg>

<style>
	.sticker-glyph {
		width: 100%;
		height: 100%;
		display: block;
		overflow: visible;
	}
</style>
