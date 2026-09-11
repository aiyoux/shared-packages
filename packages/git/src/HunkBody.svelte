<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { DiffLine } from './diffLines.js';

	let {
		lines,
		row
	}: {
		lines: DiffLine[];
		row: Snippet<[DiffLine]>;
	} = $props();

	/**
	 * Above this many lines, a hunk switches to windowed rendering instead of
	 * mounting a row (with its checkbox) per line. Real diffs are almost
	 * always well under this — it exists for the rare huge hunk (a reformat,
	 * a generated file edited once) where mounting thousands of interactive
	 * rows is what visibly janks a page.
	 */
	const VIRTUALIZE_THRESHOLD = 150;
	/** Must match `.hunk-scroll :global(.dline)`'s fixed height below —
	 *  windowing needs a known row height to turn scrollTop into a line
	 *  range, which is also why virtual mode forces `white-space: pre`
	 *  (no wrap) instead of the normal `pre-wrap`. */
	const ROW_H = 18;
	const VIEWPORT_H = ROW_H * 20;
	const OVERSCAN = 15;

	const virtual = $derived(lines.length > VIRTUALIZE_THRESHOLD);

	let scrollEl = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);

	const range = $derived.by(() => {
		if (!virtual) return { start: 0, end: lines.length };
		const visibleRows = Math.ceil(VIEWPORT_H / ROW_H);
		const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
		const end = Math.min(lines.length, start + visibleRows + OVERSCAN * 2);
		return { start, end };
	});

	const visibleLines = $derived(lines.slice(range.start, range.end));
	const topPad = $derived(range.start * ROW_H);
	const bottomPad = $derived((lines.length - range.end) * ROW_H);

	function onScroll() {
		scrollTop = scrollEl?.scrollTop ?? 0;
	}
</script>

{#if virtual}
	<div
		class="hunk-scroll"
		data-testid="git-diff-hunk-virtual"
		bind:this={scrollEl}
		onscroll={onScroll}
		style="max-height: {VIEWPORT_H}px;"
	>
		<div class="pad" style="height: {topPad}px;" aria-hidden="true"></div>
		{#each visibleLines as line (line.opIndex)}
			{@render row(line)}
		{/each}
		<div class="pad" style="height: {bottomPad}px;" aria-hidden="true"></div>
	</div>
{:else}
	{#each lines as line (line.opIndex)}
		{@render row(line)}
	{/each}
{/if}

<style>
	.hunk-scroll {
		overflow-y: auto;
	}
	/* Fixed height + no wrap: what makes scrollTop -> line-range math exact.
	   Long lines scroll horizontally instead of wrapping while virtualized. */
	.hunk-scroll :global(.dline) {
		height: 18px;
		white-space: pre;
		overflow-x: auto;
	}
</style>
