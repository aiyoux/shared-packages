<script lang="ts">
	/**
	 * ProjectStoragePanel in the same overlay chrome as FeStorageDialog.
	 */
	import '@shared-packages/design-system/button.css';
	import ProjectStoragePanel from './ProjectStoragePanel.svelte';
	import type { VfsService } from '../vfs.js';

	let {
		vfs,
		rootId,
		onClose,
		onChanged,
		onImported,
		onScanExportRefs,
		onFreezeExportRefs
	}: {
		vfs: VfsService;
		rootId: string;
		onClose: () => void;
		onChanged?: () => void;
		onImported?: (result: {
			rootId: string;
			idMap: Map<string, string>;
		}) => Promise<{ refused: number } | void>;
		onScanExportRefs?: (
			rootId: string
		) => Promise<Array<{ key: string; name: string; fromNames: string[] }>>;
		onFreezeExportRefs?: (
			rootId: string,
			keys: string[]
		) => Promise<{ refused: Array<{ name: string; why: string }> } | void>;
	} = $props();
</script>

<div
	class="wrap"
	role="dialog"
	aria-modal="true"
	aria-label="Project storage"
	data-testid="fe-project-storage-dialog"
>
	<button type="button" class="scrim" aria-label="Close" onclick={onClose}></button>
	<div class="card">
		<h2>Project storage</h2>
		<ProjectStoragePanel {vfs} {rootId} {onChanged} {onImported} {onScanExportRefs} {onFreezeExportRefs} />
		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="fe-project-storage-close"
				onclick={onClose}
			>
				Close
			</button>
		</div>
	</div>
</div>

<style>
	.wrap {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.scrim {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
		cursor: pointer;
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(720px, calc(100vw - 2rem));
		max-height: min(86vh, 780px);
		overflow: auto;
		padding: 1.1rem 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		color: var(--text-primary);
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
