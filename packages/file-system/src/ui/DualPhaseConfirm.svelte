<script lang="ts">
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
			<button type="button" class="cancel" data-testid="fe-dual-phase-cancel" onclick={onCancel}>
				Cancel
			</button>
			<button type="button" class="go" data-testid="fe-dual-phase-confirm-go" onclick={onConfirm}>
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
		background: rgba(0, 0, 0, 0.55);
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(440px, calc(100vw - 2rem));
		padding: 1.15rem 1.25rem;
		border-radius: 12px;
		background: #1e293b;
		border: 1px solid #334155;
		color: inherit;
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
	button {
		border-radius: 8px;
		padding: 0.4rem 0.85rem;
		font: inherit;
		cursor: pointer;
	}
	.cancel {
		background: transparent;
		border: 1px solid #475569;
		color: inherit;
	}
	.go {
		background: #38bdf8;
		border: 0;
		color: #0f172a;
		font-weight: 600;
	}
</style>
