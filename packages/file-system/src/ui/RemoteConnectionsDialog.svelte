<script lang="ts">
	/**
	 * The gear-icon settings popup: one modal with two tabs.
	 *
	 * - "Connections" (ConnectionsTab): B2, rclone, and monitor list/new/edit,
	 *   plus the vault — unchanged behavior, kept behind that tab.
	 * - "AI models" (AiModelsTab): the browser model library, per-app default
	 *   pickers, and one AI panel per saved monitor. AI is not a browser-side
	 *   connection kind — it is configured here instead (it used to be part
	 *   of the monitor edit form).
	 */
	import { onMount } from 'svelte';
	import '@shared-packages/design-system/button.css';
	import { Tabs, type TabItem } from '@shared-packages/ui';
	import ConnectionsTab from './ConnectionsTab.svelte';
	import AiModelsTab from './AiModelsTab.svelte';
	import { portal } from './portal.js';
	import type { RemoteKind } from './componentTypes.js';

	interface Props {
		onClose: () => void;
		onConnected?: (kind: RemoteKind, profile: object) => void;
		onDisconnected?: (kind: RemoteKind) => void;
	}

	let { onClose, onConnected, onDisconnected }: Props = $props();

	const TAB_ITEMS: TabItem[] = [
		{ value: 'connections', label: 'Connections', testId: 'settings-tab-connections' },
		{ value: 'models', label: 'AI models', testId: 'settings-tab-models' }
	];
	type TabValue = (typeof TAB_ITEMS)[number]['value'];
	let tab = $state<TabValue>('connections');

	onMount(() => {
		// ConnectionsTab owns Escape while its body shows (cancel form vs
		// close); the shell closes only while the AI tab is showing.
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || tab !== 'models') return;
			e.preventDefault();
			onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="portal-root" use:portal={'body'}>
	<div
		class="modal-root"
		data-testid="connections-dialog"
		role="dialog"
		aria-modal="true"
		aria-label="Settings"
	>
		<div class="scrim" onclick={onClose} role="presentation"></div>
		<div class="card">
			<div class="tabs-row">
				<Tabs items={TAB_ITEMS} bind:value={tab} variant="pill" />
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--ghost"
					data-testid="connections-dialog-close"
					onclick={onClose}
				>
					Close
				</button>
			</div>

			{#if tab === 'connections'}
				<ConnectionsTab {onClose} {onConnected} {onDisconnected} />
			{:else}
				<AiModelsTab />
			{/if}
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
		width: min(30rem, calc(100vw - 2rem));
		max-height: min(80vh, 42rem);
		overflow: auto;
		padding: 0.8rem 1.2rem 1.15rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.tabs-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
</style>