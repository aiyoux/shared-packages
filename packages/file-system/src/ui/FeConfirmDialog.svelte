<script lang="ts">
	import { onMount } from 'svelte';
	import '@shared-packages/design-system/button.css';
	import type { FeConfirmCopy } from './feConfirm.js';

	interface Props {
		copy: FeConfirmCopy;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { copy, onConfirm, onCancel }: Props = $props();

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onCancel();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div
	class="modal-root"
	data-testid="fe-confirm-dialog"
	role="dialog"
	aria-modal="true"
	aria-labelledby="fe-confirm-title"
	aria-describedby="fe-confirm-body"
>
	<div class="scrim" onclick={onCancel} role="presentation"></div>
	<div class="card">
		<h2 id="fe-confirm-title" data-testid="fe-confirm-title">{copy.title}</h2>
		<p id="fe-confirm-body" data-testid="fe-confirm-body">{copy.body}</p>
		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="fe-confirm-cancel"
				onclick={onCancel}
			>
				Cancel
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--danger"
				data-testid="fe-confirm-go"
				onclick={onConfirm}
			>
				{copy.confirmLabel}
			</button>
		</div>
	</div>
</div>

<style>
	.modal-root {
		position: fixed;
		inset: 0;
		z-index: 80;
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
		width: min(440px, calc(100vw - 2rem));
		padding: 1.15rem 1.25rem;
		border-radius: 0;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
	}
	h2 {
		margin: 0 0 0.6rem;
		font-size: 1.05rem;
	}
	p {
		margin: 0 0 0.75rem;
		line-height: 1.45;
		font-size: 0.92rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
