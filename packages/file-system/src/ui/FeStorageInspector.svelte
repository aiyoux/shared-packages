<script lang="ts">
	/**
	 * Storage inspector: a squarified treemap of what is taking up space,
	 * in the spirit of GrandPerspective / Disk Inventory X.
	 *
	 * General to the file manager — it maps ALL files, not just packed ones.
	 * Three visual kinds are distinguished by outline, because they behave
	 * differently when you delete them:
	 *   plain    — an ordinary file or folder
	 *   project  — a project whose file bytes live in shared packs
	 *   pack     — one shared pack file, whose space only returns when every
	 *              member inside it is gone
	 */
	import { layoutTreemap, formatSize, type TreemapInput, type TreemapRect } from './sizeTreemap.js';

	let {
		roots = [],
		width = 640,
		height = 420,
		title = 'Storage',
		onSelect
	}: {
		roots?: TreemapInput[];
		width?: number;
		height?: number;
		title?: string;
		onSelect?: (rect: TreemapRect) => void;
	} = $props();

	let hovered = $state<TreemapRect | null>(null);

	const rects = $derived(layoutTreemap(roots, width, height));
	const total = $derived(roots.reduce((n, r) => n + r.size, 0));

	/** Deeper rectangles are lighter, so nesting reads without extra chrome. */
	function fillFor(rect: TreemapRect): string {
		const alpha = Math.max(0.08, 0.34 - rect.depth * 0.08);
		if (rect.group === 'pack') return `rgb(var(--accent-rgb) / ${alpha + 0.12})`;
		if (rect.group === 'project') return `rgb(var(--accent-rgb) / ${alpha})`;
		return `rgb(var(--text-primary-rgb, 200 200 200) / ${alpha * 0.5})`;
	}

	function labelFits(rect: TreemapRect): boolean {
		return rect.w > 56 && rect.h > 20;
	}
</script>

<div class="inspector" data-testid="fe-storage-inspector">
	<div class="head">
		<span class="title">{title}</span>
		<span class="total">{formatSize(total)}</span>
	</div>

	<svg
		{width}
		{height}
		viewBox="0 0 {width} {height}"
		role="img"
		aria-label="{title}: {formatSize(total)} across {rects.length} items"
		data-testid="fe-storage-treemap"
	>
		{#each rects as rect (rect.id)}
			<g
				class="cell {rect.group}"
				class:folder={rect.kind === 'folder'}
				class:has-packed={rect.packedBytes > 0}
				data-testid="fe-treemap-cell"
				data-group={rect.group}
				data-packed-bytes={rect.packedBytes}
				data-name={rect.name}
				role="button"
				tabindex="0"
				aria-label="{rect.name}, {formatSize(rect.size)}"
				onmouseenter={() => (hovered = rect)}
				onmouseleave={() => (hovered = hovered?.id === rect.id ? null : hovered)}
				onfocus={() => (hovered = rect)}
				onblur={() => (hovered = hovered?.id === rect.id ? null : hovered)}
				onclick={() => onSelect?.(rect)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onSelect?.(rect);
					}
				}}
			>
				<rect
					x={rect.x}
					y={rect.y}
					width={rect.w}
					height={rect.h}
					fill={fillFor(rect)}
					rx="2"
				/>
				{#if labelFits(rect)}
					<text x={rect.x + 5} y={rect.y + 13} class="name">{rect.name}</text>
					{#if rect.h > 34}
						<text x={rect.x + 5} y={rect.y + 26} class="size">{formatSize(rect.size)}</text>
					{/if}
				{/if}
			</g>
		{/each}
	</svg>

	<div class="legend">
		<span class="key plain">File</span>
		<span class="key project">Project</span>
		<span class="key pack">Pack</span>
		<span class="hint">
			{#if hovered}
				{hovered.name} — {formatSize(hovered.size)}{hovered.group === 'pack'
					? ' (shared pack: space returns when every member is deleted)'
					: hovered.packedBytes > 0
						? ` (${formatSize(hovered.packedBytes)} in shared packs)`
						: ''}
			{:else}
				Area is proportional to size
			{/if}
		</span>
	</div>
</div>

<style>
	.inspector {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.title {
		font-weight: 600;
		color: var(--text-primary);
	}
	.total {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	svg {
		max-width: 100%;
		height: auto;
		background: var(--surface-1);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
	}
	.cell {
		cursor: pointer;
	}
	.cell rect {
		stroke: var(--line-hairline);
		stroke-width: 1;
	}
	/* Outline is what separates the three kinds — colour alone would not
	   survive a colourblind viewer or a low-contrast theme. */
	.cell.project rect {
		stroke: var(--accent);
		stroke-width: 2;
		stroke-dasharray: none;
	}
	/* A folder is what gets drawn once the map stops descending, so packed
	   storage has to be visible on folders too — not only on leaf files that
	   a deep tree never reaches. */
	.cell.pack rect,
	.cell.has-packed rect {
		stroke: var(--accent-light, var(--accent));
		stroke-width: 2;
		stroke-dasharray: 4 2;
	}
	.cell:hover rect,
	.cell:focus-visible rect {
		stroke: var(--accent);
		stroke-width: 2.5;
	}
	.cell:focus-visible {
		outline: none;
	}
	.name {
		font-size: 10px;
		fill: var(--text-primary);
		pointer-events: none;
	}
	.size {
		font-size: 9px;
		fill: var(--text-muted);
		pointer-events: none;
		font-variant-numeric: tabular-nums;
	}
	.legend {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.72rem;
		color: var(--text-muted);
		flex-wrap: wrap;
	}
	.key::before {
		content: '';
		display: inline-block;
		width: 10px;
		height: 10px;
		margin-right: 0.3rem;
		vertical-align: -1px;
		border-radius: 2px;
		border: 1px solid var(--line-hairline);
	}
	.key.project::before {
		border: 2px solid var(--accent);
	}
	.key.pack::before {
		border: 2px dashed var(--accent-light, var(--accent));
	}
	.hint {
		margin-left: auto;
		text-align: right;
	}
</style>
