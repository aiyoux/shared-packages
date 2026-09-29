<script lang="ts">
	import FeIcon from './FeIcon.svelte';

	/** One saved connection in the manager list. */
	export type ConnectionListRow = {
		key: string;
		label: string;
		openTestId: string;
		removeTestId: string;
		/** A short cue after the label (e.g. the key is not saved). */
		note?: string;
		/** What the cue means, on hover. */
		noteTitle?: string;
	};

	let {
		rows,
		busy = false,
		onOpen,
		onRemove
	}: {
		rows: ConnectionListRow[];
		busy?: boolean;
		onOpen: (key: string) => void;
		onRemove: (key: string) => void;
	} = $props();
</script>

<ul class="conn-rows">
	{#each rows as row (row.key)}
		<li>
			<button
				type="button"
				class="conn-row"
				data-testid={row.openTestId}
				disabled={busy}
				onclick={() => onOpen(row.key)}
			>
				<span class="conn-row-label">{row.label}</span>
				{#if row.note}
					<span class="conn-row-note" title={row.noteTitle} data-testid="{row.openTestId}-note">{row.note}</span>
				{/if}
			</button>
			<button
				type="button"
				class="conn-row-trash"
				data-testid={row.removeTestId}
				aria-label="Remove {row.label}"
				title="Remove"
				disabled={busy}
				onclick={() => onRemove(row.key)}
			>
				<FeIcon name="trash" size={13} />
			</button>
		</li>
	{/each}
</ul>

<style>
	.conn-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	li {
		display: flex;
		align-items: stretch;
		min-width: 0;
	}
	li:hover {
		background: var(--surface-3);
	}
	.conn-row {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		padding: 0.35rem 0.45rem;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.conn-row:disabled,
	.conn-row-trash:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.conn-row-label {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.conn-row-note {
		flex: 0 0 auto;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.conn-row-trash {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.conn-row-trash:hover:not(:disabled) {
		color: var(--cat-red-soft);
	}
</style>
