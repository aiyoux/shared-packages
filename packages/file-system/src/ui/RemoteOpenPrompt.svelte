<script lang="ts">
	import '@shared-packages/design-system/button.css';
	import { portalModal } from './portal.js';
	import { formatSize } from './sizeTreemap.js';
	import { describeDuration } from '../linkSpeed.js';
	import type { RemoteOpenAlternative, RemoteOpenPlan } from '../services/remoteCopies.js';

	/**
	 * The one question every app asks before opening a remote file that is slow
	 * to copy, or cannot be opened here at all. Same words in every app: the
	 * copy is what you edit, and Save sends it back.
	 */

	interface Props {
		plan: RemoteOpenPlan;
		alternatives?: RemoteOpenAlternative[];
		onCopy: () => void;
		onAlternative?: (id: string) => void;
		onCancel: () => void;
	}

	let { plan, alternatives = [], onCopy, onAlternative, onCancel }: Props = $props();

	const size = $derived(plan.size !== undefined ? formatSize(plan.size) : 'an unknown size');
	const time = $derived(
		plan.copyMs !== undefined
			? `${describeDuration(plan.copyMs)} on this connection`
			: 'how long depends on this connection, which has not been measured yet'
	);

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onCancel();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="portal-root" use:portalModal>
	<div
		class="modal-root"
		data-testid="fe-remote-open-prompt"
		role="dialog"
		aria-modal="true"
		aria-labelledby="fe-remote-open-title"
	>
		<!-- Escape and Cancel are the accessible ways out; the scrim is a convenience. -->
		<div class="scrim" onclick={onCancel} role="presentation"></div>
		<div class="card">
			{#if plan.blocked}
				<h2 id="fe-remote-open-title">Can't open {plan.name} here</h2>
				<p data-testid="fe-remote-open-blocked">{plan.blocked}</p>
				<p class="hint">Its preview in Files still works, and it stays on {plan.label}.</p>
			{:else if !plan.ask}
				<h2 id="fe-remote-open-title">Open {plan.name}</h2>
				<p>Copy it from {plan.label} to this device and edit the copy here.</p>
			{:else}
				<h2 id="fe-remote-open-title">Copy {plan.name} to this device?</h2>
				<p>
					It is <strong>{size}</strong> on {plan.label}. Opening copies it to this device first:
					<span data-testid="fe-remote-open-time">{time}</span>.
				</p>
				<p class="hint">
					You edit the copy here. Each Save sends it back to {plan.label}, which takes about as long.
				</p>
			{/if}
			{#if !plan.blocked && !plan.ask}
				<p class="hint">Each Save sends the copy back to {plan.label}.</p>
			{/if}
			{#each alternatives as alt (alt.id)}
				<p class="alt-detail">{alt.detail}</p>
			{/each}
			<div class="actions">
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-remote-open-cancel" onclick={onCancel}>
					{plan.blocked ? 'Close' : 'Cancel'}
				</button>
				{#each alternatives as alt (alt.id)}
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--secondary"
						data-testid={`fe-remote-open-alt-${alt.id}`}
						onclick={() => onAlternative?.(alt.id)}
					>
						{alt.label}
					</button>
				{/each}
				{#if !plan.blocked}
					<button type="button" class="ds-btn ds-btn--sm ds-btn--primary" data-testid="fe-remote-open-copy" onclick={onCopy}>
						Copy and open
					</button>
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.portal-root {
		display: contents;
	}
	.modal-root {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(460px, calc(100vw - 2rem));
		padding: 1.15rem 1.25rem;
		border-radius: 0;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.05rem;
		overflow-wrap: anywhere;
	}
	p {
		margin: 0 0 0.75rem;
		line-height: 1.45;
		font-size: 0.92rem;
	}
	.hint,
	.alt-detail {
		opacity: 0.75;
		font-size: 0.82rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
