<script lang="ts">
	import '@shared-packages/design-system/button.css';
	import { portalModal } from './portal.js';
	import type { RemoteDeps, RemoteDepsChoice } from '../services/remoteCopies.js';

	/**
	 * The question a remote Open asks when the copy it just made references
	 * files that stayed where the file lives. Copying them in is one press,
	 * because "your animation opened with every clip dead" is not something a
	 * person should discover by finding grey chips. Opening as-is is also a
	 * real choice: the references still name the connection, and resolve again
	 * the moment its file is copied or the file is opened elsewhere.
	 */

	interface Props {
		deps: RemoteDeps;
		busy?: boolean;
		onChoice: (choice: RemoteDepsChoice) => void;
	}

	let { deps, busy = false, onChoice }: Props = $props();

	/** Six names read at a glance; the rest are counted, not listed. */
	const shown = $derived(deps.entries.slice(0, 6));
	const hidden = $derived(deps.entries.length - shown.length);
	const name = $derived(deps.name);

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !busy) onChoice('cancel');
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="portal-root" use:portalModal>
	<div
		class="modal-root"
		data-testid="fe-remote-deps"
		role="dialog"
		aria-modal="true"
		aria-labelledby="fe-remote-deps-title"
	>
		<!-- Escape and Cancel are the accessible ways out; the scrim is a convenience. -->
		<div class="scrim" onclick={() => !busy && onChoice('cancel')} role="presentation"></div>
		<div class="card">
			<h2 id="fe-remote-deps-title">Copy the files {name} links to?</h2>
			<p>
				{name} references files that stay on {deps.where}. Opened as-is, the copy would show them
				as unresolvable links.
				{#if deps.stuck.length}
					{deps.stuck.length} more {deps.stuck.length === 1 ? 'reference is' : 'references are'}
					on {deps.where} but beyond this folder.
				{/if}
			</p>
			<ul class="names" data-testid="fe-remote-deps-list">
				{#each shown as dep (dep.key)}
					<li>{dep.name}</li>
				{/each}
				{#if hidden > 0}
					<li class="more">and {hidden} more</li>
				{/if}
			</ul>
			<div class="actions">
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-remote-deps-cancel" onclick={() => onChoice('cancel')} disabled={busy}>
					Cancel
				</button>
				<button type="button" class="ds-btn ds-btn--sm ds-btn--secondary" data-testid="fe-remote-deps-asis" onclick={() => onChoice('asis')} disabled={busy}>
					Open as-is
				</button>
				<button type="button" class="ds-btn ds-btn--sm ds-btn--primary" data-testid="fe-remote-deps-copy" onclick={() => onChoice('copy')} disabled={busy}>
					{busy ? 'Copying…' : `Copy them and open`}
				</button>
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
	.names {
		margin: 0 0 0.9rem;
		padding: 0.45rem 0.75rem;
		background: var(--surface-3);
		border: 1px solid var(--line-hairline);
		max-height: 11rem;
		overflow: auto;
		font-size: 0.85rem;
		line-height: 1.7;
	}
	.more {
		opacity: 0.7;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>