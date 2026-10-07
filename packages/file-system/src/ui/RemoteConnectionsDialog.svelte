<script lang="ts">
	import { overlay } from '@shared-packages/design-system';
	/**
	 * The gear-icon settings popup: one modal with two built-in tabs plus
	 * host-provided ones.
	 *
	 * - "Connections" (ConnectionsTab): B2 and monitor list/new/edit,
	 *   unchanged behavior, kept behind that tab.
	 * - "AI models" (AiModelsTab): the browser model library, per-app default
	 *   pickers, and one AI panel per saved monitor. AI is not a browser-side
	 *   connection kind — it is configured here instead (it used to be part
	 *   of the monitor edit form).
	 * - Host snippets (only shown when the host passes them): "ocr" — the
	 *   hub's consolidated OCR settings (modules, engine weights, per-app
	 *   defaults) — plus appearance/editing/outputs, and agentAccess renders
	 *   under the AI models tab.
	 */
	import { onMount, untrack, type Snippet } from 'svelte';
	import '@shared-packages/design-system/button.css';
	import { Tabs, type TabItem } from '@shared-packages/ui';
	import ConnectionsTab from './ConnectionsTab.svelte';
	import AiModelsTab from './AiModelsTab.svelte';
	import MonitorStatus from './MonitorStatus.svelte';
	import { listProfiles } from '../monitor/credentials.js';
	import { HUB_MONITOR_PROFILES_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
	import { portal } from './portal.js';
	import type { RemoteKind } from './componentTypes.js';

	interface Props {
		onClose: () => void;
		initialTab?: 'connections' | 'models' | 'ocr';
		appearance?: Snippet;
		/** How documents save (autosave): the host app's setting. */
		editing?: Snippet;
		outputs?: Snippet;
		agentAccess?: Snippet;
		/** The hub's consolidated OCR settings (modules + engine models + defaults). */
		ocr?: Snippet;
		onConnected?: (kind: RemoteKind, profile: object) => void;
		/** A connection was removed; hosts detach whatever shows that id. */
		onDisconnected?: (kind: RemoteKind, id: string) => void;
	}

	let { onClose, initialTab = 'connections', onConnected, onDisconnected, appearance, editing, outputs, agentAccess, ocr }: Props = $props();

	const TAB_ITEMS = $derived<TabItem[]>([
		{ value: 'connections', label: 'Connections', testId: 'settings-tab-connections' },
		{ value: 'models', label: 'AI models', testId: 'settings-tab-models' },
		...(ocr ? [{ value: 'ocr', label: 'OCR', testId: 'settings-tab-ocr' }] : []),
		...(appearance ? [{ value: 'appearance', label: 'Appearance', testId: 'settings-tab-appearance' }] : []),
		...(editing ? [{ value: 'editing', label: 'Editing', testId: 'settings-tab-editing' }] : []),
		...(outputs ? [{ value: 'outputs', label: 'Outputs', testId: 'settings-tab-outputs' }] : [])
	]);
	type TabValue = (typeof TAB_ITEMS)[number]['value'];
	let tab = $state<TabValue>(untrack(() => initialTab));
	let monitors = $state<MonitorConnectionProfileV1[]>([]);
	onMount(() => {
		let disposed = false;
		const refresh = () => { void listProfiles().then((rows) => { if (!disposed) monitors = rows; }).catch((error) => console.error('Could not read monitor profiles', error)); };
		refresh();
		const stop = subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, refresh);
		return () => { disposed = true; stop(); };
	});

	let connectionsTab = $state<{ dismiss: () => void }>();

</script>

<div class="portal-root" use:portal={'body'}>
	<div
		class="modal-root" use:overlay={{ kind: 'modal', panel: '.card', onClose, onEscape: () => tab === 'connections' ? connectionsTab?.dismiss() : onClose() }}
		data-testid="connections-dialog"
		role="dialog"
		aria-modal="true"
		aria-label="Settings"
	>
		<div class="scrim" role="presentation"></div>
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
				<ConnectionsTab bind:this={connectionsTab} {onClose} {onConnected} {onDisconnected} />
				{#each monitors as profile (profile.id)}
					<section aria-label={profile.name}><strong>{profile.name}</strong><MonitorStatus {profile} /></section>
				{/each}
			{:else if tab === 'models'}
				<AiModelsTab onConfigureMonitor={() => (tab = 'connections')} />
				{@render agentAccess?.()}
			{:else if tab === 'ocr'}
				{@render ocr?.()}
			{:else if tab === 'appearance'}
				{@render appearance?.()}
			{:else if tab === 'editing'}
				{@render editing?.()}
			{:else if tab === 'outputs'}
				{@render outputs?.()}
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
		background: rgba(var(--scrim-rgb), 0.55);
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
