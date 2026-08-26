<script lang="ts">
	import FileExplorer from './FileExplorer.svelte';
	import type { FileTypeId } from '../types.js';
	import type { ExplorerOpenTarget } from './explorerDriver.js';

	let {
		mode,
		accept,
		defaultName = 'Untitled',
		testid = 'vfs-dialog',
		onSave,
		onOpen,
		onClose
	}: {
		mode: 'open' | 'save';
		accept: FileTypeId[];
		defaultName?: string;
		testid?: string;
		onSave?: (args: {
			parentId: string | null;
			name: string;
			overwrite?: boolean;
		}) => void | Promise<void>;
		onOpen?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		onClose: () => void;
	} = $props();

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (document.querySelector('.confirm-modal, [data-testid="fe-trash-popup"]')) return;
			e.preventDefault();
			onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="vfs-scrim" role="presentation" data-testid={testid} onclick={onClose}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="vfs-panel" onclick={(e) => e.stopPropagation()}>
		{#if mode === 'save'}
			<FileExplorer
				mode="save"
				{accept}
				variant="dialog"
				{defaultName}
				compatSaveTestId={false}
				onSave={onSave}
				{onClose}
			/>
		{:else}
			<FileExplorer
				mode="manage"
				{accept}
				variant="dialog"
				onOpen={onOpen}
				{onClose}
			/>
		{/if}
	</div>
</div>

<style>
	.vfs-scrim {
		position: absolute;
		inset: 0;
		background: rgb(var(--scrim-rgb) / 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4, 1rem);
		z-index: var(--z-modal, 80);
	}
	.vfs-panel {
		width: min(720px, 100%);
		height: min(70vh, 640px);
		min-height: 280px;
	}
	.vfs-panel :global(.fe-root) {
		height: 100%;
		max-height: none;
	}
</style>
