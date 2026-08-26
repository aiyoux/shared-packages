<script lang="ts">
	import { onMount } from 'svelte';
	import type { TransferItem } from '../transferRegistry.js';
	import { stackTransferItems, stackedStageLabel, stagePercent, type StackedProgress } from './stackProgress.js';
	import FeIcon from './FeIcon.svelte';

	interface Props {
		items: TransferItem[];
		onDismiss?: (id: string) => void;
		onDismissAll?: () => void;
	}

	let { items, onDismiss, onDismissAll }: Props = $props();

	const stacked = $derived(stackTransferItems(items));
	const latest = $derived.by((): StackedProgress | null => {
		if (!stacked.length) return null;
		const active = [...stacked].reverse().find((t) => !t.done && t.status !== 'failed');
		return active ?? stacked[stacked.length - 1]!;
	});
	const hasFinished = $derived(stacked.some((t) => t.done || t.status === 'failed'));

	let open = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);

	function hopStatus(t: StackedProgress): string | null {
		if (t.ice === 'failed') return 'WebRTC failed — through this device';
		if (t.hopNote) return t.hopNote;
		if (t.hop === 'server') return 'Server copy';
		if (t.hop === 'delegated') return 'Delegated';
		if (t.hop === 'webrtc') {
			if (t.icePath === 'host') return 'WebRTC (host)';
			if (t.icePath === 'stun') return 'WebRTC (STUN)';
			return 'WebRTC (connecting)';
		}
		if (t.hop === 'dual-phase' || t.hop === 'direct') return 'Through this device';
		return null;
	}

	function iceAttr(t: StackedProgress): string | undefined {
		if (t.ice === 'failed') return 'failed';
		if (t.icePath === 'host' || t.icePath === 'stun') return t.icePath;
		if (t.ice === 'checking' || t.ice === 'connected') return 'checking';
		return t.ice;
	}

	function dismissRow(t: StackedProgress) {
		if (!onDismiss) return;
		for (const id of t.ids) onDismiss(id);
	}

	function onDocPointer(e: PointerEvent) {
		if (!open) return;
		if (rootEl && e.target instanceof Node && rootEl.contains(e.target)) return;
		open = false;
	}

	onMount(() => {
		document.addEventListener('pointerdown', onDocPointer, true);
		return () => document.removeEventListener('pointerdown', onDocPointer, true);
	});
</script>

{#if latest}
	<div class="chip-wrap dpe-copy-chip" bind:this={rootEl} data-testid="fe-op-progress">
		<button
			type="button"
			class="chip"
			class:failed={latest.status === 'failed'}
			class:done={latest.done && latest.status !== 'failed'}
			data-testid="fe-op-progress-row"
			data-name={latest.name}
			data-copy-hop={latest.hop}
			data-ice={iceAttr(latest)}
			data-ice-path={latest.icePath}
			aria-expanded={open}
			aria-haspopup="true"
			title={latest.error || hopStatus(latest) || latest.name}
			onclick={() => (open = !open)}
		>
			<div
				class="bar dpe-copy-bar"
				role="progressbar"
				aria-valuenow={stagePercent(latest.behind, latest.size, latest.done)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${latest.name}: ${stackedStageLabel(latest)}`}
			>
				<div class="fill ahead" style="width: {stagePercent(latest.ahead, latest.size, latest.done)}%"></div>
				<div class="fill behind" style="width: {stagePercent(latest.behind, latest.size, latest.done)}%"></div>
			</div>
			<span class="name">{latest.name}</span>
			<span class="pct">{stackedStageLabel(latest)}</span>
		</button>
		{#if open}
			<div class="menu" role="menu" data-testid="fe-op-progress-menu">
				{#each stacked as t (t.id)}
					<div
						class="menu-row"
						class:failed={t.status === 'failed'}
						class:done={t.done && t.status !== 'failed'}
						data-testid="fe-op-progress-menu-row"
						data-name={t.name}
						data-copy-hop={t.hop}
					>
						<div
							class="bar"
							role="progressbar"
							aria-valuenow={stagePercent(t.behind, t.size, t.done)}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							<div class="fill ahead" style="width: {stagePercent(t.ahead, t.size, t.done)}%"></div>
							<div class="fill behind" style="width: {stagePercent(t.behind, t.size, t.done)}%"></div>
						</div>
						<span class="name" title={hopStatus(t) ?? t.name}>{t.name}</span>
						<span class="pct">{stackedStageLabel(t)}</span>
						{#if onDismiss}
							<button
								type="button"
								class="x"
								onclick={() => dismissRow(t)}
								aria-label={t.done || t.status === 'failed' ? 'Dismiss' : 'Cancel'}
								title={t.done || t.status === 'failed' ? 'Dismiss' : 'Cancel'}
							>
								<FeIcon name="x" size={12} />
							</button>
						{/if}
					</div>
					{#if t.error}
						<p class="err">{t.error}</p>
					{/if}
				{/each}
				{#if onDismissAll && hasFinished}
					<button
						type="button"
						class="clear"
						data-testid="fe-op-progress-dismiss"
						onclick={() => {
							onDismissAll();
							open = false;
						}}
					>
						Clear finished
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.chip-wrap {
		position: relative;
		display: flex;
		align-items: center;
		flex: 0 1 18rem;
		min-width: 9rem;
		max-width: 20rem;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		max-width: 100%;
		height: var(--control-h-sm, 1.75rem);
		padding: 0 0.35rem 0 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.chip:hover .bar {
		outline: 1px solid var(--line-hairline, #64748b);
	}
	.bar {
		position: relative;
		flex: 1 1 7.5rem;
		min-width: 5.5rem;
		height: 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 14%, transparent);
		overflow: hidden;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		height: 100%;
		border-radius: 999px;
	}
	.fill.ahead {
		background: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
	}
	.fill.behind {
		background: var(--accent, #38bdf8);
	}
	.failed .fill.ahead {
		background: color-mix(in srgb, var(--danger, #f87171) 40%, transparent);
	}
	.failed .fill.behind {
		background: var(--danger, #f87171);
	}
	.done .fill.ahead,
	.done .fill.behind {
		background: var(--accent-emerald, #34d399);
	}
	.name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.pct {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
		white-space: nowrap;
	}
	.menu {
		position: absolute;
		z-index: 50;
		top: calc(100% + 4px);
		left: 0;
		min-width: max(100%, 16rem);
		max-width: min(24rem, 80vw);
		max-height: min(40vh, 280px);
		overflow: auto;
		padding: 0.4rem 0.45rem 0.45rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.35);
	}
	.menu-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0;
	}
	.x,
	.clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: 0;
		color: inherit;
		cursor: pointer;
		opacity: 0.75;
		padding: 0 0.2rem;
		font: inherit;
		font-size: 0.72rem;
	}
	.clear {
		width: 100%;
		margin-top: 0.25rem;
		padding: 0.3rem 0.25rem;
		border-top: 1px solid var(--line-hairline);
		opacity: 0.85;
	}
	.err {
		margin: 0 0 0.25rem;
		color: var(--cat-red-soft);
		font-size: 0.72rem;
	}
</style>
