<script lang="ts">
	/**
	 * Shared B2 / rclone / monitor connection manager: list of saved profiles,
	 * then a new or edit form. One popup, two views.
	 */
	import { onMount, type Snippet } from 'svelte';
	import '@shared-packages/design-system/button.css';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import type { FeConfirmCopy } from './feConfirm.js';
	import { portal } from './portal.js';

	export type ConnectionProfileRow = {
		id: string;
		name: string;
		detail?: string;
		active?: boolean;
	};

	export type ConnectionFormMode = 'list' | 'new' | 'edit';

	interface Props {
		title: string;
		/** Root test id (b2-connection-form, rclone-connection-form, …). */
		testid: string;
		/** Prefix for list/form control test ids: b2 / rclone / monitor. */
		prefix: string;
		profiles: ConnectionProfileRow[];
		mode: ConnectionFormMode;
		busy?: boolean;
		error?: string;
		hint?: string;
		submitTestid: string;
		connectTestid?: string;
		fields: Snippet;
		extra?: Snippet;
		onClose: () => void;
		onNew: () => void;
		onEdit: (id: string) => void;
		onConnect: (id: string) => void;
		onRemove: (id: string) => void;
		onSubmit: () => void;
		onCancelForm: () => void;
	}

	let {
		title,
		testid,
		prefix,
		profiles,
		mode,
		busy = false,
		error = '',
		hint = '',
		submitTestid,
		connectTestid,
		fields,
		extra,
		onClose,
		onNew,
		onEdit,
		onConnect,
		onRemove,
		onSubmit,
		onCancelForm
	}: Props = $props();

	const connectTid = $derived(connectTestid ?? `${prefix}-profile-select`);
	const submitLabel = $derived(mode === 'edit' ? 'Update' : 'Add');
	const formTitle = $derived(mode === 'edit' ? `Edit ${title}` : `New ${title}`);

	let removePrompt = $state<{ id: string; name: string } | null>(null);

	const removeCopy = $derived.by((): FeConfirmCopy => {
		const name = removePrompt?.name ?? 'this connection';
		return {
			title: 'Remove connection',
			confirmLabel: 'Remove',
			body: `Remove “${name}” from this browser? This does not delete files on the remote.`
		};
	});

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			if (removePrompt) {
				removePrompt = null;
				return;
			}
			if (mode === 'list') onClose();
			else onCancelForm();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="portal-root" use:portal={'body'}>
<div class="modal-root" data-testid={testid} role="dialog" aria-modal="true" aria-labelledby="{prefix}-mgr-title">
	<div class="scrim" onclick={onClose} role="presentation"></div>
	<div class="card">
		<header class="head">
			<h2 id="{prefix}-mgr-title">{mode === 'list' ? title : formTitle}</h2>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="{prefix}-dialog-close"
				onclick={onClose}
			>
				Close
			</button>
		</header>

		{#if hint && mode === 'list'}
			<p class="hint">{hint}</p>
		{/if}

		{#if error}
			<div class="err" data-testid="{prefix}-form-error" role="alert">{error}</div>
		{/if}

		{#if mode === 'list'}
			<div class="saved" data-testid="{prefix}-saved-profiles">
				{#if profiles.length}
					<ul data-testid="{prefix}-profile-list">
						{#each profiles as p (p.id)}
							<li class:active={p.active}>
								<div class="profile-main">
									<span class="profile-name">{p.name}</span>
									{#if p.detail}
										<span class="meta">{p.detail}</span>
									{/if}
								</div>
								<button
									type="button"
									class="ds-btn ds-btn--sm ds-btn--secondary"
									data-testid="{prefix}-profile-edit"
									disabled={busy}
									onclick={() => onEdit(p.id)}>Edit</button
								>
								<button
									type="button"
									class="ds-btn ds-btn--sm ds-btn--primary"
									data-testid={connectTid}
									disabled={busy}
									onclick={() => onConnect(p.id)}>Connect</button
								>
								<button
									type="button"
									class="ds-btn ds-btn--sm ds-btn--ghost danger"
									data-testid="{prefix}-profile-delete"
									disabled={busy}
									onclick={() => (removePrompt = { id: p.id, name: p.name })}>Remove</button
								>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="empty" data-testid="{prefix}-empty">No saved connections.</p>
				{/if}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="{prefix}-profile-new"
					disabled={busy}
					onclick={onNew}
				>
					New connection
				</button>
			</div>
			{#if extra}
				<div class="extra">{@render extra()}</div>
			{/if}
		{:else}
			<div class="fields">
				{@render fields()}
			</div>
			<div class="actions">
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--ghost"
					data-testid="{prefix}-cancel"
					disabled={busy}
					onclick={onCancelForm}
				>
					Cancel
				</button>
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--primary"
					data-testid={submitTestid}
					disabled={busy}
					onclick={onSubmit}
				>
					{busy ? 'Saving…' : submitLabel}
				</button>
			</div>
		{/if}
	</div>
</div>

{#if removePrompt}
	<FeConfirmDialog
		copy={removeCopy}
		onConfirm={() => {
			const id = removePrompt?.id;
			removePrompt = null;
			if (id) onRemove(id);
		}}
		onCancel={() => (removePrompt = null)}
	/>
{/if}
</div>

<style>
	.portal-root {
		display: contents;
	}
	.modal-root {
		position: fixed;
		inset: 0;
		z-index: 70;
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
		width: min(28rem, calc(100vw - 2rem));
		max-height: min(80vh, 40rem);
		overflow: auto;
		padding: 1.1rem 1.2rem 1.15rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.hint,
	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.err {
		padding: 0.5rem 0.75rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.9rem;
	}
	.saved {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.5rem;
		border: 1px solid var(--line-hairline);
	}
	li.active {
		border-color: var(--accent);
	}
	.profile-main {
		flex: 1 1 8rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.profile-name {
		font-weight: 650;
		font-size: 0.88rem;
	}
	.meta {
		font-size: 0.75rem;
		opacity: 0.7;
	}
	.danger {
		color: var(--cat-red-soft);
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.extra {
		min-width: 0;
	}
	.fields :global(label) {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	.fields :global(label.check) {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
	}
	.fields :global(input:not([type='checkbox'])) {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
	}
	.fields :global(.editing-label) {
		margin: 0;
		font-size: 0.8rem;
		color: var(--accent-light);
	}
</style>
