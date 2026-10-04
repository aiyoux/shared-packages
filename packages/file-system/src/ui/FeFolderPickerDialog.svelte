<script lang="ts">
	import { overlay } from '@shared-packages/design-system';
	/**
	 * Pick an existing folder in a VFS/Explorer driver — "Use this folder"
	 * confirm, breadcrumbs, no file rows. Used by the speech tools to point an
	 * engine at whichever folder its model was imported into. Deliberately a
	 * standalone dialog rather than another FileExplorerDialog mode.
	 */
	import '@shared-packages/design-system/button.css';
	import { portalModal } from './portal.js';
	import { formatExplorerError } from './explorerError.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

	let {
		title = 'Choose a folder',
		confirmLabel = 'Use this folder',
		driver,
		startDirId = null,
		sources,
		sourceId,
		onSourceChange,
		testid = 'fe-folder-picker',
		onSelect,
		onCancel
	}: {
		title?: string;
		confirmLabel?: string;
		driver: ExplorerDriver;
		/** Folder to open first; null starts at the driver root. */
		startDirId?: string | null;
		/** When set, a source dropdown sits above the folder list. */
		sources?: readonly { id: string; label: string }[];
		sourceId?: string;
		onSourceChange?: (id: string) => void;
		testid?: string;
		onSelect: (folder: { id: string | null; name: string }) => void | Promise<void>;
		onCancel: () => void;
	} = $props();

	let parentId = $state<string | null>(startDirId);
	let folders = $state<ExplorerEntry[]>([]);
	let crumbs = $state<ExplorerEntry[]>([]);
	let busy = $state(false);
	let error = $state('');

	let loadedSource: string | undefined;
	$effect(() => {
		const source = sourceId;
		if (source !== loadedSource) {
			loadedSource = source;
			parentId = startDirId ?? null;
		}
		void load(parentId);
	});

	async function load(parent: string | null): Promise<void> {
		busy = true;
		error = '';
		try {
			const listed = await driver.list({ parentId: parent });
			folders = listed.entries.filter((e) => e.kind === 'folder');
			crumbs = parent ? await driver.getPath(parent) : [];
		} catch (e) {
			error = formatExplorerError(e);
		} finally {
			busy = false;
		}
	}

	/** Root when the picker sits at the driver root; else the deepest crumb. */
	const here = $derived(crumbs.length ? crumbs[crumbs.length - 1]!.name : 'Files root');

	function close(): void {
		onCancel();
	}

</script>

<div class="portal-root" use:portalModal>
	<div
		class="modal-root" use:overlay={{ kind: 'modal', panel: '.card', onClose: close }}
		data-testid={testid}
		role="dialog"
		aria-modal="true"
		aria-labelledby="fe-folder-picker-title"
	>
		<div class="scrim" role="presentation"></div>
		<div class="card">
			<h2 id="fe-folder-picker-title">{title}</h2>

			{#if sources?.length}
				<label class="source">
					Source
					<select
						data-testid="fe-folder-picker-source"
						aria-label="Folder source"
						value={sourceId ?? sources[0]!.id}
						onchange={(event) => onSourceChange?.(event.currentTarget.value)}
					>
						{#each sources as source (source.id)}
							<option value={source.id}>{source.label}</option>
						{/each}
					</select>
				</label>
			{/if}

			<div class="crumbs" data-testid="fe-folder-picker-crumbs">
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => (parentId = null)}>
					Root
				</button>
				{#each crumbs as crumb, i (crumb.id)}
					{#if i === crumbs.length - 1}
						<span class="here">{crumb.name}</span>
					{:else}
						<span>/</span>
						<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => (parentId = crumb.id)}>
							{crumb.name}
						</button>
					{/if}
				{/each}
			</div>

			{#if busy}
				<p class="hint">Loading folders…</p>
			{:else if error}
				<p class="err" role="alert" data-testid="fe-folder-picker-error">{error}</p>
			{:else if folders.length === 0}
				<p class="hint">No subfolders here — pick this folder with “{confirmLabel}”.</p>
			{:else}
				<ul data-testid="fe-folder-picker-list">
					{#each folders as folder (folder.id)}
						<li>
							<button
								type="button"
								class="folder-btn"
								data-testid="fe-folder-picker-row"
								onclick={() => (parentId = folder.id)}
							>
								{folder.name}
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if error}
				<p class="err" role="alert">{error}</p>
			{/if}

			<div class="actions">
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-folder-picker-cancel" onclick={close}>
					Cancel
				</button>
				<button
					type="button"
					class="ds-btn ds-btn--sm"
					data-testid="fe-folder-picker-confirm"
					disabled={busy}
					onclick={() => void onSelect({ id: parentId, name: here })}
				>
					{confirmLabel}
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
		/* Settings shells sit at 70. Confirm dialogs sit at 80, so this stays between them. */
		z-index: 75;
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
		max-height: min(80vh, 640px);
		overflow: auto;
		padding: 1.1rem 1.2rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
	}
	.source {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.65rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.source select {
		flex: 1;
		min-width: 0;
		padding: 0.3rem 0.45rem;
		border-radius: var(--radius-md, 6px);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
	}
	.crumbs {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
		margin-bottom: 0.65rem;
		font-size: 0.8rem;
	}
	.here {
		color: var(--text-primary);
		font-weight: 600;
	}
	ul {
		list-style: none;
		margin: 0 0 0.65rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 40vh;
		overflow: auto;
	}
	.folder-btn {
		width: 100%;
		text-align: left;
		padding: 0.4rem 0.55rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm, 6px);
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.folder-btn:hover {
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 8%, transparent);
		border-color: var(--line-hairline);
	}
	.hint {
		margin: 0 0 0.65rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.err {
		margin: 0 0 0.65rem;
		font-size: 0.82rem;
		color: var(--danger, #f87171);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
