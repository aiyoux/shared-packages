<script lang="ts">
	/**
	 * Open-mode dialog wrapper around ConnectionFilePicker — the same scrim and
	 * panel as FileExplorerDialog, but the explorer carries the connection
	 * menu (browser library, in-memory, computer folder, B2, monitor).
	 */
	import { overlay } from '@shared-packages/design-system';
	import ConnectionFilePicker from './ConnectionFilePicker.svelte';
	import type { ConnectionOpenMany, ConnectionPick } from './connectionPickerTypes.js';
	import type { FileTypeId } from '../types.js';

	let {
		accept,
		testid = 'conn-dialog',
		explorerMode = 'open',
		openLabel = 'Open',
		multiSelect = false,
		notice = '',
		width,
		height,
		onOpen,
		onOpenMany,
		onClose
	}: {
		accept: FileTypeId[];
		testid?: string;
		/** 'open' keeps ImageConnectionPicker's behavior; tools that came from
		 * FileExplorerDialog pass 'manage' to keep their row actions. */
		explorerMode?: 'open' | 'manage';
		openLabel?: string;
		multiSelect?: boolean;
		/** A tool-side problem shown inside the panel (ConnectionFilePicker's). */
		notice?: string;
		width?: string;
		height?: string;
		onOpen: (pick: ConnectionPick) => void | Promise<void>;
		/** Batch multi-select Open; only called when set and >1 file is picked. */
		onOpenMany?: ConnectionOpenMany | undefined;
		onClose: () => void;
	} = $props();
</script>

<div
	class="conn-scrim"
	use:overlay={{ kind: 'modal', portal: true, panel: '.conn-panel', onClose }}
	role="presentation"
	data-testid={testid}
>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="conn-panel"
		style:width={width ?? undefined}
		style:height={height ?? undefined}
		onclick={(e) => e.stopPropagation()}
	>
		<ConnectionFilePicker
			{accept}
			{explorerMode}
			{openLabel}
			{multiSelect}
			{notice}
			{onOpen}
			{onOpenMany}
			{onClose}
		/>
	</div>
</div>

<style>
	.conn-scrim {
		position: absolute;
		inset: 0;
		background: rgba(var(--scrim-rgb), 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4, 1rem);
		z-index: var(--z-modal, 80);
	}
	.conn-panel {
		width: min(720px, 100%);
		height: min(70vh, 640px);
		min-height: 280px;
		max-height: 100%;
	}
	/* Mobile browsers size the layout viewport — which `vh` resolves against —
	   to include the area behind the browser chrome. Same fix as
	   FileExplorerDialog. A caller-passed height (inline) takes precedence. */
	@supports (height: 100dvh) {
		.conn-scrim {
			max-height: 100dvh;
		}
		.conn-panel {
			height: min(70dvh, 640px);
		}
	}
</style>