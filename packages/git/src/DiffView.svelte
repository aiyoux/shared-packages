<script lang="ts">
	import type { DiffHunk, FileDiff } from './diffLines.js';

	let {
		diff,
		excluded,
		onToggleLine,
		onToggleHunk
	}: {
		diff: FileDiff;
		/** opIndex values left OUT of the commit for this file. */
		excluded: ReadonlySet<number>;
		onToggleLine: (opIndex: number) => void;
		onToggleHunk: (hunk: DiffHunk) => void;
	} = $props();

	/** `checked`/`indeterminate` for a hunk's own checkbox, from its add/del
	 *  lines' individual state. A context-only hunk can't happen (every hunk
	 *  is built around at least one change) but is treated as "all" if it did. */
	function hunkState(hunk: DiffHunk): 'all' | 'none' | 'some' {
		const changeable = hunk.lines.filter((l) => l.kind !== 'ctx');
		if (!changeable.length) return 'all';
		const excludedCount = changeable.filter((l) => excluded.has(l.opIndex)).length;
		if (excludedCount === 0) return 'all';
		if (excludedCount === changeable.length) return 'none';
		return 'some';
	}

	/** `indeterminate` is a DOM property, not an attribute — checkboxes never
	 *  render it from markup, so it has to be set imperatively. */
	function indeterminate(node: HTMLInputElement, value: boolean) {
		node.indeterminate = value;
		return {
			update(next: boolean) {
				node.indeterminate = next;
			}
		};
	}
</script>

<div class="diff-view" data-testid="git-diff-view">
	{#if diff.kind === 'unchanged'}
		<p class="diff-note">No textual changes.</p>
	{:else if diff.kind === 'binary'}
		<p class="diff-note">Binary file — changes can't be shown line by line.</p>
	{:else if diff.kind === 'tooLarge'}
		<p class="diff-note">File is too large to preview line by line.</p>
	{:else}
		{#each diff.hunks as hunk, hi (hi)}
			{@const state = hunkState(hunk)}
			<div class="hunk" data-testid="git-diff-hunk">
				<div class="hunk-head">
					<input
						type="checkbox"
						checked={state !== 'none'}
						use:indeterminate={state === 'some'}
						aria-label="Include this hunk in the commit"
						data-testid="git-diff-hunk-check"
						onchange={() => onToggleHunk(hunk)}
					/>
					<code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</code>
				</div>
				{#each hunk.lines as line (line.opIndex)}
					<div class="dline kind-{line.kind}" class:excluded={line.kind !== 'ctx' && excluded.has(line.opIndex)}>
						<span class="gutter">{line.oldNo ?? ''}</span>
						<span class="gutter">{line.newNo ?? ''}</span>
						{#if line.kind === 'ctx'}
							<span class="line-check-spacer" aria-hidden="true"></span>
						{:else}
							<input
								type="checkbox"
								class="line-check"
								checked={!excluded.has(line.opIndex)}
								aria-label={line.kind === 'add' ? 'Include this added line' : 'Include this removed line'}
								data-testid="git-diff-line-check"
								onchange={() => onToggleLine(line.opIndex)}
							/>
						{/if}
						<span class="marker" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
						<span class="text">{line.text}</span>
					</div>
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.diff-view {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 4px 0 4px 20px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
	}
	.diff-note {
		margin: 0;
		color: var(--text-secondary, #666);
	}
	.hunk {
		border: 1px solid var(--line-hairline, #ccc);
		border-radius: var(--radius-sm, 4px);
		overflow: hidden;
	}
	.hunk-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		background: var(--surface-2, #f2f2f2);
		border-bottom: 1px solid var(--line-hairline, #ccc);
	}
	.hunk-head code {
		color: var(--text-secondary, #666);
	}
	.dline {
		display: grid;
		grid-template-columns: 2.4em 2.4em 1.4em 1em 1fr;
		align-items: start;
		column-gap: 4px;
		padding: 0 6px;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.gutter {
		color: var(--text-secondary, #888);
		text-align: right;
		user-select: none;
	}
	.line-check,
	.line-check-spacer {
		width: 1em;
		height: 1em;
		margin: 2px 0 0;
	}
	.marker {
		user-select: none;
	}
	.kind-add {
		background: color-mix(in srgb, var(--ok, #2a7) 12%, transparent);
	}
	.kind-add .marker {
		color: var(--ok, #2a7);
	}
	.kind-del {
		background: color-mix(in srgb, var(--danger, #c33) 12%, transparent);
	}
	.kind-del .marker {
		color: var(--danger, #c33);
	}
	.dline.excluded {
		opacity: 0.45;
		text-decoration: line-through;
	}
</style>
