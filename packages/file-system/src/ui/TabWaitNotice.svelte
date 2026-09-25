<script lang="ts">
	/**
	 * "Waiting on another tab" — the visible half of never guessing that a
	 * tab is dead. Shows the oldest wait registered in `live/waits.ts`, with a
	 * button to take the role here when that would help. Mount once per app.
	 */
	import { onDestroy } from 'svelte';
	import { Button } from '@shared-packages/design-system';
	import { subscribeTabWaits, type TabWait } from '../live/waits.js';

	let waits = $state<TabWait[]>([]);
	let taking = $state(false);
	const off = subscribeTabWaits((next) => {
		waits = next;
		if (!next.length) taking = false;
	});
	onDestroy(off);

	const wait = $derived(waits[0] ?? null);

	function takeOver(): void {
		if (!wait?.takeOver) return;
		taking = true;
		wait.takeOver();
	}
</script>

{#if wait}
	<div class="tab-wait" role="status" aria-live="polite" data-testid="tab-wait-notice">
		<div class="tab-wait__text">
			<strong>Waiting on another tab for {wait.what}</strong>
			{#if wait.detail}<span>{wait.detail}</span>{/if}
		</div>
		{#if wait.takeOver}
			<Button
				size="sm"
				variant="secondary"
				loading={taking}
				disabled={taking}
				onclick={takeOver}
				data-testid="tab-wait-take-over"
			>
				Use this tab
			</Button>
		{/if}
	</div>
{/if}

<style>
	.tab-wait {
		position: fixed;
		inset-inline: var(--space-4);
		bottom: var(--space-4);
		margin-inline: auto;
		max-width: 34rem;
		z-index: 1000;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		background: var(--surface-2);
		color: var(--text-primary);
		border: 1px solid var(--line-hairline);
		border-inline-start: 3px solid var(--warning);
		border-radius: var(--radius-lg);
		box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
	}
	.tab-wait__text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
		font-size: var(--text-sm);
	}
	.tab-wait__text span {
		color: var(--text-muted);
	}
</style>
