<script lang="ts">
	import { portalToPaneWindowHeader } from '../pane-layout/chrome.js';

	type FileChromeItem = 'new' | 'open' | 'save' | 'saveAs' | 'close';

	let {
		hasDocument,
		isDirty = false,
		testidPrefix = 'file',
		showWindows = false,
		windowEditOpen = $bindable(false),
		windowsFirst = false,
		items = undefined,
		labels = undefined,
		onNew,
		onOpen,
		onSave,
		onSaveAs,
		onClose,
		right
	}: {
		hasDocument: boolean;
		isDirty?: boolean;
		testidPrefix?: string;
		showWindows?: boolean;
		windowEditOpen?: boolean;
		/**
		 * Render the Windows toggle before the File menu (Windows, File,
		 * Save — the sketcher order). Default false preserves the
		 * File-first order used by the 3D app and Projects.
		 */
		windowsFirst?: boolean;
		/**
		 * Which menu entries this app has. Omitted entries stay visible, so an
		 * app that saves documents needs no config; one that only opens things
		 * (Projects) passes `{ new: false, save: false, saveAs: false }`.
		 * `save: false` also drops the quick-save button.
		 */
		items?: Partial<Record<FileChromeItem, boolean>>;
		/** Per-entry label overrides, e.g. `{ open: 'Open project…' }`. */
		labels?: Partial<Record<FileChromeItem, string>>;
		onNew: () => void;
		onOpen: () => void;
		onSave: () => void;
		onSaveAs: () => void;
		onClose: () => void;
		right?: any;
	} = $props();

	const shows = (item: FileChromeItem) => items?.[item] !== false;
	const labelOf = (item: FileChromeItem, fallback: string) => labels?.[item] ?? fallback;

	let menuOpen = $state(false);
	let wrapEl: HTMLDivElement | undefined = $state();

	function pick(fn: () => void) {
		menuOpen = false;
		fn();
	}

	$effect(() => {
		if (!menuOpen) return;
		const onDoc = (e: MouseEvent) => {
			if (wrapEl && e.target instanceof Node && wrapEl.contains(e.target)) return;
			menuOpen = false;
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	});
</script>

<div
	class="file-chrome"
	class:has-right={Boolean(right)}
	use:portalToPaneWindowHeader
	data-testid="{testidPrefix}-file-chrome"
>
	<div class="file-actions" data-testid="{testidPrefix}-file-actions">
		{#if windowsFirst}{@render windowsButton()}{/if}
		<div class="file-wrap" data-testid="{testidPrefix}-file-wrap" bind:this={wrapEl}>
			<button
				type="button"
				class="file-btn"
				class:active={menuOpen}
				aria-label="File"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				data-tooltip="File"
				data-tooltip-pos="bottom-right"
				data-testid="{testidPrefix}-file-btn"
				onclick={() => (menuOpen = !menuOpen)}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
			</button>
			{#if menuOpen}
				<div class="file-menu" role="menu" aria-label="File" data-testid="{testidPrefix}-file-menu">
					{#if shows('new')}
						<button type="button" class="file-item" role="menuitem" data-testid="{testidPrefix}-file-new" onclick={() => pick(onNew)}>
							{labelOf('new', 'New')}
						</button>
					{/if}
					{#if shows('open')}
						<button type="button" class="file-item" role="menuitem" data-testid="{testidPrefix}-file-open" onclick={() => pick(onOpen)}>
							{labelOf('open', 'Open')}
						</button>
					{/if}
					{#if shows('save')}
						<button
							type="button"
							class="file-item"
							role="menuitem"
							data-testid="{testidPrefix}-file-save"
							disabled={!hasDocument}
							onclick={() => pick(onSave)}
						>
							{labelOf('save', 'Save')}
						</button>
					{/if}
					{#if shows('saveAs')}
						<button
							type="button"
							class="file-item"
							role="menuitem"
							data-testid="{testidPrefix}-file-save-as"
							disabled={!hasDocument}
							onclick={() => pick(onSaveAs)}
						>
							{labelOf('saveAs', 'Save as')}
						</button>
					{/if}
					{#if shows('close')}
						<button
							type="button"
							class="file-item"
							role="menuitem"
							data-testid="{testidPrefix}-file-close"
							disabled={!hasDocument}
							onclick={() => pick(onClose)}
						>
							{labelOf('close', 'Close')}
						</button>
					{/if}
				</div>
			{/if}
		</div>
		{#if !windowsFirst}{@render windowsButton()}{/if}
		{#if shows('save')}
		<button
			type="button"
			class="file-btn"
			aria-label="Save"
			data-tooltip="Save"
			data-tooltip-pos="bottom-right"
			data-testid="{testidPrefix}-save-btn"
			disabled={!hasDocument}
			onclick={onSave}
		>
			<span class="save-wrap">
				{#if isDirty}
					<span class="dirty-dot"></span>
				{/if}
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
			</span>
		</button>
		{/if}
	</div>
	{#if right}
		<div class="file-right" data-testid="{testidPrefix}-file-right">
			{@render right()}
		</div>
	{/if}
</div>

{#snippet windowsButton()}
	{#if showWindows}
		<button
			type="button"
			class="file-btn"
			class:active={windowEditOpen}
			aria-label="Windows"
			aria-pressed={windowEditOpen}
			data-tooltip="Edit windows"
			data-tooltip-pos="bottom-right"
			data-testid="{testidPrefix}-windows-btn"
			disabled={!hasDocument}
			onclick={() => (windowEditOpen = !windowEditOpen)}
		>
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>
		</button>
	{/if}
{/snippet}

<style>
	.file-chrome {
		display: flex;
		align-items: center;
		visibility: hidden;
	}
	.file-chrome:global(.in-overlay),
	.file-chrome:global(.in-chrome) {
		visibility: visible;
	}
	.file-chrome:global(.in-overlay) {
		position: absolute;
		top: calc(12px + env(safe-area-inset-top, 0px));
		left: calc(12px + env(safe-area-inset-left, 0px));
		z-index: var(--z-popover, 40);
	}
	.file-chrome:global(.in-overlay.has-right) {
		right: calc(12px + env(safe-area-inset-right, 0px));
		display: flex;
		justify-content: space-between;
		pointer-events: none;
	}
	.file-chrome:global(.in-overlay.has-right) .file-actions,
	.file-chrome:global(.in-overlay.has-right) .file-right {
		pointer-events: auto;
	}
	.file-chrome:global(.in-chrome) {
		position: relative;
		z-index: 3;
		height: 100%;
	}
	.file-chrome:global(.in-chrome.has-right) {
		flex: 1 1 0;
		min-width: 0;
		width: 100%;
		display: flex;
		justify-content: space-between;
	}
	.file-actions {
		display: flex;
		align-items: center;
		gap: 0;
	}
	.file-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.file-wrap {
		position: relative;
		display: flex;
		align-items: center;
	}
	.file-btn {
		box-sizing: border-box;
		width: 38px;
		height: 38px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-chrome, rgba(18, 18, 24, 0.94));
		border: 1px solid var(--border, var(--line-strong));
		border-radius: var(--radius-md, 6px);
		color: var(--text-primary);
		cursor: pointer;
	}
	.file-chrome:global(.in-chrome) .file-btn {
		width: var(--control-h-sm, 26px);
		height: var(--control-h-sm, 26px);
		min-width: var(--control-h-sm, 26px);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 0;
		color: var(--text-secondary);
	}
	.file-chrome:global(.in-chrome) .file-btn:hover,
	.file-chrome:global(.in-chrome) .file-btn:focus-visible,
	.file-chrome:global(.in-chrome) .file-btn.active {
		background: var(--surface-3);
		color: var(--text-primary);
		outline: none;
	}
	.file-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.file-menu {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 6px;
		min-width: 10rem;
		padding: 6px;
		z-index: var(--z-popover-menu, 50);
		display: flex;
		flex-direction: column;
		gap: 2px;
		background: var(--bg-chrome, rgba(18, 18, 24, 0.94));
		border: 1px solid var(--border, var(--line-strong));
		border-radius: var(--radius-lg, 8px);
		box-shadow: 0 10px 30px var(--shadow-hard, rgb(0 0 0 / 0.35));
	}
	.file-item {
		display: flex;
		align-items: center;
		padding: 8px 10px;
		border: none;
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.8rem;
		cursor: pointer;
		text-align: left;
	}
	.file-item:hover:not(:disabled) {
		background: var(--surface-3, rgb(255 255 255 / 0.06));
	}
	.file-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.save-wrap {
		position: relative;
		display: inline-flex;
	}
	.dirty-dot {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent, #38bdf8);
	}
</style>
