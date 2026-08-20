<script lang="ts">
	import '@shared-packages/design-system/button.css';

	interface Props {
		sourceLabel: string;
		destLabel: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let { sourceLabel, destLabel, onConfirm, onCancel }: Props = $props();
</script>

<div
	class="modal-root"
	data-testid="fe-dual-phase-confirm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="fe-dual-phase-title"
>
	<!-- Backdrop dismissal is a convenience; Escape and the Cancel button are the
	     accessible paths, so the scrim itself stays out of the a11y tree. -->
	<div class="scrim" onclick={onCancel} role="presentation"></div>
	<div class="card">
		<h2 id="fe-dual-phase-title">Dual-phase transfer</h2>
		<p>
			This copies <strong>{sourceLabel}</strong> → <strong>{destLabel}</strong> through this
			device: first download, then upload. Pieces stream so transfer can start before the
			download finishes, and finished pieces are dropped from memory.
		</p>
		<p class="hint">A disconnect or failed upload leaves the destination unchanged when possible.</p>
		<div class="actions">
			<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-dual-phase-cancel" onclick={onCancel}>
				Cancel
			</button>
			<button type="button" class="ds-btn ds-btn--sm ds-btn--primary" data-testid="fe-dual-phase-confirm-go" onclick={onConfirm}>
				Continue
			</button>
		</div>
	</div>
</div>

<style>
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
	.hint {
		opacity: 0.75;
		font-size: 0.82rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
