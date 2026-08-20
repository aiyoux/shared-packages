<script lang="ts">
	import type { TransferItem } from '../transferRegistry.js';
	import { stackTransferItems, type StackedProgress } from './stackProgress.js';
	import FeIcon from './FeIcon.svelte';

	interface Props {
		items: TransferItem[];
		onDismiss?: (id: string) => void;
		onDismissAll?: () => void;
	}

	let { items, onDismiss, onDismissAll }: Props = $props();

	const stacked = $derived(stackTransferItems(items));

	function pct(n: number, size: number, done: boolean): number {
		if (!size) return done ? 100 : 0;
		return Math.min(100, Math.round((n / size) * 100));
	}

	function label(t: StackedProgress): string {
		if (t.status === 'failed') return 'Failed';
		if (t.done) return 'Done';
		if (t.ahead !== t.behind) {
			const dl = pct(t.ahead, t.size, false);
			const tx = pct(t.behind, t.size, false);
			return `${tx}% sent · ${dl}% ready`;
		}
		if (t.size && t.behind >= t.size) return 'Writing…';
		return 'Copying…';
	}

	function dismissRow(t: StackedProgress) {
		if (!onDismiss) return;
		for (const id of t.ids) onDismiss(id);
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
			{#each stacked as t (t.id)}
				{@const aheadPct = pct(t.ahead, t.size, t.done)}
				{@const behindPct = pct(t.behind, t.size, t.done)}
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
							<button type="button" class="op-x" onclick={() => dismissRow(t)} aria-label="Dismiss">
								<FeIcon name="x" size={12} />
							</button>
						{/if}
					</div>
					<div
						class="op-bar"
						role="progressbar"
						aria-valuenow={behindPct}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label={`${t.name}: ${behindPct}% transferred, ${aheadPct}% downloaded`}
					>
						<div class="op-fill ahead" style="width: {aheadPct}%"></div>
						<div class="op-fill behind" style="width: {behindPct}%"></div>
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
		border-radius: 0;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.35);
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
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
		position: relative;
		height: 6px;
		border-radius: 999px;
		background: rgb(var(--overlay-rgb) / 0.1);
		overflow: hidden;
		margin-top: 0.25rem;
	}
	.op-fill {
		position: absolute;
		inset: 0 auto 0 0;
		height: 100%;
		border-radius: 999px;
		transition: width 120ms ease;
	}
	.op-fill.ahead {
		background: rgb(var(--accent-rgb) / 0.35);
	}
	.op-fill.behind {
		background: var(--accent);
	}
	.op-row.failed .op-fill.ahead {
		background: rgb(var(--danger-rgb) / 0.35);
	}
	.op-row.failed .op-fill.behind {
		background: var(--danger);
	}
	.op-row.done .op-fill.ahead,
	.op-row.done .op-fill.behind {
		background: var(--accent-emerald);
	}
	.op-err {
		margin: 0.25rem 0 0;
		color: var(--cat-red-soft);
		font-size: 0.75rem;
	}
</style>
