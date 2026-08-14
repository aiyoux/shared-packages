<script lang="ts">
	import type { TransferItem } from '../transferRegistry.js';

	interface Props {
		items: TransferItem[];
		onDismiss?: (id: string) => void;
		onDismissAll?: () => void;
	}

	let { items, onDismiss, onDismissAll }: Props = $props();

	function pct(t: TransferItem): number {
		if (!t.size) return t.done ? 100 : 0;
		return Math.min(100, Math.round((t.transferred / t.size) * 100));
	}

	function label(t: TransferItem): string {
		if (t.status === 'failed') return 'Failed';
		if (t.done) return 'Done';
		if (t.size && t.transferred >= t.size) return 'Writing…';
		return 'Copying…';
	}
</script>

{#if items.length}
	<aside class="op-pop" data-testid="fe-op-progress" aria-live="polite">
		<header class="op-head">
			<strong>Copy progress</strong>
			{#if onDismissAll}
				<button type="button" class="op-dismiss" data-testid="fe-op-progress-dismiss" onclick={onDismissAll}>
					Hide
				</button>
			{/if}
		</header>
		<ul class="op-list">
			{#each items as t (t.id)}
				<li
					class="op-row"
					class:failed={t.status === 'failed'}
					class:done={t.done && t.status !== 'failed'}
					data-testid="fe-op-progress-row"
					data-name={t.name}
				>
					<div class="op-meta">
						<span class="op-name" title={t.name}>{t.name}</span>
						<span class="op-status">{label(t)}</span>
						{#if onDismiss && (t.done || t.status === 'failed')}
							<button type="button" class="op-x" onclick={() => onDismiss(t.id)} aria-label="Dismiss">
								×
							</button>
						{/if}
					</div>
					<div class="op-bar" role="progressbar" aria-valuenow={pct(t)} aria-valuemin={0} aria-valuemax={100}>
						<div class="op-fill" style="width: {pct(t)}%"></div>
					</div>
					{#if t.error}
						<p class="op-err">{t.error}</p>
					{/if}
				</li>
			{/each}
		</ul>
	</aside>
{/if}

<style>
	.op-pop {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 40;
		width: min(360px, calc(100vw - 2rem));
		max-height: min(40vh, 320px);
		overflow: auto;
		padding: 0.65rem 0.75rem 0.75rem;
		border-radius: 10px;
		border: 1px solid var(--border, #334155);
		background: color-mix(in srgb, var(--surface, #1e293b) 94%, #000);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
		color: inherit;
		font-size: 0.85rem;
	}
	.op-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.op-dismiss,
	.op-x {
		background: none;
		border: 0;
		color: inherit;
		cursor: pointer;
		opacity: 0.75;
		padding: 0 0.25rem;
	}
	.op-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.op-meta {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
	}
	.op-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.op-status {
		font-size: 0.75rem;
		opacity: 0.75;
		white-space: nowrap;
	}
	.op-bar {
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.1);
		overflow: hidden;
		margin-top: 0.25rem;
	}
	.op-fill {
		height: 100%;
		background: #38bdf8;
		border-radius: 999px;
		transition: width 120ms ease;
	}
	.op-row.failed .op-fill {
		background: #f87171;
	}
	.op-row.done .op-fill {
		background: #4ade80;
	}
	.op-err {
		margin: 0.25rem 0 0;
		color: #ffb4b4;
		font-size: 0.75rem;
	}
</style>
