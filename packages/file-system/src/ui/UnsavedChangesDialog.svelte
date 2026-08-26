<script lang="ts">
	import '@shared-packages/design-system/button.css';

	/**
	 * 3-option dialog for "open a file while the current doc is dirty".
	 * Shown via `showDirtyOpenDialog` (dynamic mount) or directly by an app.
	 * Escape / scrim click = Continue editing.
	 */
	let {
		title = 'Unsaved changes detected',
		message = 'What do you want to do?',
		fileName,
		onDiscard,
		onSave,
		onContinue
	}: {
		title?: string;
		message?: string;
		fileName?: string;
		onDiscard: () => void;
		onSave: () => void;
		onContinue: () => void;
	} = $props();

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onContinue();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

<div
	class="modal-root"
	data-testid="unsaved-changes-dialog"
	role="dialog"
	aria-modal="true"
	aria-labelledby="ucd-title"
	aria-describedby="ucd-body"
>
	<div class="scrim" onclick={onContinue} role="presentation"></div>
	<div class="card">
		<h2 id="ucd-title" data-testid="ucd-title">{title}</h2>
		<p id="ucd-body" data-testid="ucd-body">
			{message}
			{#if fileName}<span class="file-name">“{fileName}”</span>{/if}
		</p>
		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="ucd-continue"
				onclick={onContinue}
			>
				Continue editing (don't open file)
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="ucd-discard"
				onclick={onDiscard}
			>
				Discard changes and open file
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="ucd-save"
				onclick={onSave}
			>
				Save changes and continue with open
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
		width: min(480px, calc(100vw - 2rem));
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
	.file-name {
		font-weight: 600;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.25rem;
	}
</style>
