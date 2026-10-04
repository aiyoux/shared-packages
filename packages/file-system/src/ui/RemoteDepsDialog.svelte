<script lang="ts">
	import { overlay } from '@shared-packages/design-system';
	import '@shared-packages/design-system/button.css';
	import { portalModal } from './portal.js';
	import type { RemoteDeps, RemoteDepsChoice } from '../services/remoteCopies.js';

	/**
	 * What a remote Open says when the copy it just made links to files this
	 * browser does not have. They cannot be fetched: a browser-file link names
	 * the id the file had in the browser that made the document, and a copy
	 * on a monitor or B2 keeps no record of those ids. So the person hears it
	 * here, before the document opens with grey chips, and decides whether it
	 * is worth opening at all.
	 */

	interface Props {
		deps: RemoteDeps;
		onChoice: (choice: RemoteDepsChoice) => void;
	}

	let { deps, onChoice }: Props = $props();

	const files = $derived(deps.missing === 1 ? '1 file' : `${deps.missing} files`);

</script>

<div class="portal-root" use:portalModal>
	<div
		class="modal-root" use:overlay={{ kind: 'modal', panel: '.card', onClose: () => onChoice('cancel') }}
		data-testid="fe-remote-deps"
		role="dialog"
		aria-modal="true"
		aria-labelledby="fe-remote-deps-title"
	>
		<!-- Escape and Cancel are the accessible ways out; the scrim is a convenience. -->
		<div class="scrim" role="presentation"></div>
		<div class="card">
			<h2 id="fe-remote-deps-title">{deps.name} links to {files} that are not here</h2>
			<p data-testid="fe-remote-deps-body">
				Those links name files in the browser that made {deps.name}. A copy on {deps.where} does not
				bring them along, so they will show as broken links. Open the document where those files
				are to keep them working.
			</p>
			<div class="actions">
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-remote-deps-cancel" onclick={() => onChoice('cancel')}>
					Cancel
				</button>
				<button type="button" class="ds-btn ds-btn--sm ds-btn--primary" data-testid="fe-remote-deps-asis" onclick={() => onChoice('asis')}>
					Open anyway
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
