<script lang="ts">
	/**
	 * The "AI models" tab of the settings popup: per-app default models, the
	 * browser library, and one AI panel per saved monitor.
	 *
	 * The browser library and the defaults pickers come from the registry
	 * (`../ai/modelRegistry.ts`) — this component owns no model names. A
	 * consumer that never registered a library (an immersive app mounting
	 * the dialog itself) degrades to the "library unavailable" note rather
	 * than crashing.
	 *
	 * Defaults write through the shared selection map, so a change here and
	 * a change made in an app's own picker converge (same store, same
	 * change-pings).
	 */
	import { onMount, type Snippet } from 'svelte';
	let { modelInstallation }: { modelInstallation?: Snippet<[onChanged: () => void]> } = $props();
	import { browserAiHost, type BrowserModelState } from '../ai/browserHost.js';
	let hostLabel = $state('Not started');
	let hostModels = $state<Record<string, BrowserModelState>>({});
	import { toast } from '@shared-packages/ui';
	import {
		getAiSelectionMap,
		listAiLibrarySources,
		resolveAiModelRef,
		setAiModelRef,
		subscribeAiSelection,
		type AiLibraryModelRow,
		type AiLibraryModelStatus,
		type AiModelRef,
		type AiTaskKey
	} from '../ai/index.js';
	import { listProfiles as listMonitorProfiles } from '../monitor/credentials.js';
	import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
	import MonitorModelsPanel from './MonitorModelsPanel.svelte';
	import MonitorStatus from './MonitorStatus.svelte';

	const sources = listAiLibrarySources();

	/** Defaults group: registered surfaces grouped by task, resolved against
	 * the shared selection map (own cell → task 'default' cell → null). */
	const defaultsGroups = $derived.by(() => {
		const groups: Array<{ task: AiTaskKey; surfaces: Array<{ appId: string; label: string }> }> = [];
		const seen = new Map<string, Array<{ appId: string; label: string }>>();
		for (const surface of sources.surfaces) {
			let group = seen.get(surface.task);
			if (!group) {
				group = [];
				seen.set(surface.task, group);
				groups.push({ task: surface.task, surfaces: group });
			}
			group.push({ appId: surface.appId, label: surface.label });
		}
		return groups;
	});

	/** (task, appId) → resolved ref, refreshed by selection change-pings. */
	let resolved = $state<Record<string, AiModelRef | null>>({});
	let selectionReady = $state(false);

	const refKey = (task: string, appId: string) => `${task}/${appId}`;

	async function loadSelections() {
		try {
			const map = await getAiSelectionMap();
			const next: Record<string, AiModelRef | null> = {};
			for (const group of defaultsGroups) {
				for (const surface of group.surfaces) {
					next[refKey(group.task, surface.appId)] = resolveAiModelRef(
						map,
						group.task,
						surface.appId
					);
				}
			}
			resolved = next;
			selectionReady = true;
		} catch {
			selectionReady = false;
		}
	}

	$effect(() => {
		void loadSelections();
		const off = subscribeAiSelection(() => void loadSelections());
		return () => off();
	});

	/** Defaults and location sections share one read of each registered catalog. */
	const candidates = $derived.by(() => {
		const rows: Record<string, AiLibraryModelRow[] | null> = {};
		for (const group of defaultsGroups) {
			const section = sources.sections.find((section) => (section.selectionTask ?? section.task) === group.task);
			rows[group.task] = section ? sectionStates[section.id]?.rows ?? null : [];
		}
		return rows;
	});

	function pickDefaults(group: { task: AiTaskKey }, appId: string, value: string) {
		let ref: AiModelRef | null = null;
		if (value) {
			try {
				ref = JSON.parse(value) as AiModelRef;
			} catch {
				return;
			}
		}
		setAiModelRef(group.task, appId, ref)
			.then(() => toast.success('Default model updated'))
			.catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
	}

	function encodeRef(ref: AiModelRef): string {
		return JSON.stringify(ref);
	}

	/** Highlight match against a row: the row is the canonical identity, an
	 * app's stored ref may be more specific than it (chat writes the device
	 * variant, transcribe the on-device variant) — a row without a variant
	 * or source still matches such a ref on what it does name. */
	function sameRef(a: AiModelRef | null, b: AiModelRef): boolean {
		return (
			a != null &&
			a.location === b.location &&
			a.modelId === b.modelId &&
			(!b.sourceId || a.sourceId === b.sourceId) &&
			(!b.variantId || a.variantId === b.variantId) &&
			(!b.monitorProfileId || a.monitorProfileId === b.monitorProfileId)
		);
	}

	/** Catalog metadata is read once, then grouped by each row's execution location. */
	type SectionState = {
		rows: AiLibraryModelRow[] | null;
		busy: boolean;
		error: string;
	};
	let sectionStates = $state<Record<string, SectionState>>({});

	const statusLabel: Record<AiLibraryModelStatus, string> = {
		installed: 'installed',
		'not-installed': 'not installed',
		partial: 'partially imported',
		unavailable: 'unavailable',
		remote: 'on demand / service',
		'built-in': 'built-in'
	};

	const sizeLabel = (bytes: number | null) =>
		bytes == null
			? ''
			: bytes >= 1024 * 1024 * 1024
				? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
				: `${Math.round(bytes / (1024 * 1024))} MiB`;

	async function ensureRows(section: (typeof sources.sections)[number]) {
		const state = sectionStates[section.id];
		if (state && (state.rows || state.busy)) return;
		sectionStates = {
			...sectionStates,
			[section.id]: { rows: state?.rows ?? null, busy: true, error: '' }
		};
		try {
			const rows = await section.models();
			sectionStates = {
				...sectionStates,
				[section.id]: { rows, busy: false, error: '' }
			};
		} catch (e) {
			sectionStates = {
				...sectionStates,
				[section.id]: { rows: null, busy: false, error: e instanceof Error ? e.message : String(e) }
			};
		}
	}

	let inflight = $state<ReadonlySet<string>>(new Set());
	const rowKey = (sectionId: string, row: AiLibraryModelRow) =>
		`${sectionId}/${encodeRef(row.ref)}`;

	async function runInstall(section: (typeof sources.sections)[number], row: AiLibraryModelRow) {
		if (!row.install) return;
		const key = rowKey(section.id, row);
		inflight = new Set([...inflight, key]);
		try {
			await row.install();
			await refreshSection(section);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			const next = new Set(inflight);
			next.delete(key);
			inflight = next;
		}
	}

	async function runRemove(section: (typeof sources.sections)[number], row: AiLibraryModelRow) {
		if (!row.remove) return;
		const key = rowKey(section.id, row);
		inflight = new Set([...inflight, key]);
		try {
			await row.remove();
			await refreshSection(section);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			const next = new Set(inflight);
			next.delete(key);
			inflight = next;
		}
	}

	async function refreshSection(section: (typeof sources.sections)[number]) {
		const state = sectionStates[section.id];
		if (!state) return;
		try {
			const rows = await section.models();
			sectionStates = {
				...sectionStates,
				[section.id]: { rows, busy: false, error: '' }
			};
		} catch (e) {
			sectionStates = {
				...sectionStates,
				[section.id]: { rows: null, busy: false, error: e instanceof Error ? e.message : String(e) }
			};
		}
	}

	function refreshLibrary() {
		for (const section of sources.sections) void refreshSection(section);
	}

	/** Monitors group: one panel per saved monitor profile. */
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let monitorsLoaded = $state(false);

	onMount(() => {
		for (const section of sources.sections) void ensureRows(section);
		let offHost = () => {};
		try {
		const host = browserAiHost();
		const updateHost = () => {
			const leader = host.host;
			hostLabel = leader ? `Tab ${leader.tabId.slice(0, 8)}` : 'Waiting for a host tab';
			hostModels = host.models;
		};
		updateHost();
		offHost = host.subscribe(updateHost);
		} catch (error) { hostLabel = 'Browser model status is unavailable.'; }
		void (async () => {
			try {
				monitorProfiles = await listMonitorProfiles();
			} catch {
				monitorProfiles = [];
			}
			monitorsLoaded = true;
		})();
		return offHost;
	});
</script>

{#snippet librarySection(section: (typeof sources.sections)[number], rows: AiLibraryModelRow[], monitorId = '')}
	{@const state = sectionStates[section.id]}
	<details
		class="lib-section"
		data-testid="ai-lib-section-{section.id}{monitorId ? `-${monitorId}` : ''}"
		ontoggle={() => void ensureRows(section)}
	>
		<summary>{section.title}</summary>
		{#if state?.busy}
			<p class="hint">Loading models…</p>
		{:else if state?.error}
			<p class="hint danger">{state.error}</p>
		{:else if state?.rows}
			<ul class="lib-rows">
				{#each rows as row (rowKey(section.id, row))}
					<li class="lib-row" data-testid="ai-lib-row-{row.ref.modelId}">
						{#if row.ref.location === 'browser'}
							<span class="hint">{hostModels[row.ref.modelId] ?? 'not loaded'}</span>
						{/if}
						<span class="lib-label">{row.label}</span>
						{#if row.detail}<span class="hint lib-detail">{row.detail}</span>{/if}
						<span class="chip chip--{row.status}">{statusLabel[row.status]}</span>
						{#if row.sizeBytes}
							<span class="hint">{sizeLabel(row.sizeBytes)}</span>
						{/if}
						{#if row.install}
							<button
								type="button"
								class="ds-btn ds-btn--sm ds-btn--secondary"
								data-testid="ai-lib-install-{section.id}-{row.ref.modelId}"
								disabled={inflight.has(rowKey(section.id, row))}
								onclick={() => void runInstall(section, row)}
							>
								{inflight.has(rowKey(section.id, row)) ? 'Working…' : row.installLabel ?? 'Install'}
							</button>
						{/if}
						{#if row.remove}
							<button
								type="button"
								class="ds-btn ds-btn--sm ds-btn--ghost"
								data-testid="ai-lib-remove-{section.id}-{row.ref.modelId}"
								disabled={inflight.has(rowKey(section.id, row))}
								onclick={() => void runRemove(section, row)}
							>
								Remove
							</button>
						{/if}
						{#if row.note}
							<p class="hint">{row.note}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</details>
{/snippet}

<div class="ai-tab">
	<details class="group location-group browser-group" data-testid="ai-browser" open>
		<summary><h3 class="group-title">In browser:</h3></summary>
		<p class="hint">Models that run on this device in your browser.</p>
		{#if sources.sections.length === 0}
			<p class="hint" data-testid="ai-library-unavailable">The browser model library is not available in this app. Open the hub's settings to manage browser models.</p>
		{:else}
			<div class="group" data-testid="ai-library">
				{#if sources.sections.some((section) => !sectionStates[section.id] || sectionStates[section.id].busy)}
					<p class="hint">Loading models…</p>
				{/if}
				{#each sources.sections as section (section.id)}
					{@const rows = sectionStates[section.id]?.rows?.filter((row) => row.ref.location === 'browser') ?? []}
					{#if rows.length}
						{@render librarySection(section, rows)}
					{:else if sectionStates[section.id]?.error}
						<p class="hint danger">{section.title}: {sectionStates[section.id].error}</p>
					{/if}
				{/each}
			</div>
		{/if}
		{@render modelInstallation?.(refreshLibrary)}
		<details class="host-status" data-testid="ai-browser-host">
			<summary>Browser model status</summary>
			<p class="hint">{hostLabel}</p>
			{#each Object.entries(hostModels) as [model, state] (model)}
				<p class="hint">{model}: {state === 'not-loaded' ? 'not loaded' : state}</p>
			{/each}
		</details>
	</details>

	<section class="group" data-testid="ai-monitors">
		{#if monitorProfiles.length}
			{#each monitorProfiles as profile (profile.id)}
				<section class="monitor-panel location-group" data-testid="ai-monitor-{profile.id}" aria-label={profile.name}>
					<h3 class="group-title">{profile.name}</h3>
					<MonitorStatus {profile} compact />
					<MonitorModelsPanel
						baseUrl={profile.baseUrl}
						onChanged={refreshLibrary}
						hasDeviceModels={sources.sections.some((section) => sectionStates[section.id]?.rows?.some((row) => row.ref.location === 'monitor-native' && row.ref.monitorProfileId === profile.id))}
					>
						{#snippet deviceModels()}
							{#each sources.sections as section (section.id)}
								{@const rows = sectionStates[section.id]?.rows?.filter((row) => row.ref.location === 'monitor-native' && row.ref.monitorProfileId === profile.id) ?? []}
								{#if rows.length}{@render librarySection(section, rows, profile.id)}{/if}
							{/each}
						{/snippet}
						{#snippet apiModels()}
							{#each sources.sections as section (section.id)}
								{@const rows = sectionStates[section.id]?.rows?.filter((row) => row.ref.location === 'monitor-provider' && row.ref.monitorProfileId === profile.id) ?? []}
								{#if rows.length}{@render librarySection(section, rows, `${profile.id}-api`)}{/if}
							{/each}
						{/snippet}
					</MonitorModelsPanel>
				</section>
			{/each}
		{:else if monitorsLoaded}
			<p class="hint" data-testid="ai-monitors-none">No monitors added. Add a monitor on the Connections tab to run models on that device or connect it to an API.</p>
		{/if}
	</section>

	{#if defaultsGroups.length}
		<details class="group defaults" data-testid="ai-defaults">
			<summary>Default models for apps</summary>
			{#each defaultsGroups as group (group.task)}
				{@const rows = candidates[group.task]}
				<div class="default-row" data-testid="ai-defaults-{group.task}">
					{#each group.surfaces as surface (surface.appId)}
						{@const ref = resolved[refKey(group.task, surface.appId)]}
						<label class="default-pick">
							<span class="default-label">{surface.label}</span>
							<select
								data-testid="ai-default-{group.task}-{surface.appId}"
								disabled={!rows || !selectionReady}
								onchange={(e) => pickDefaults(group, surface.appId, e.currentTarget.value)}
							>
								<option value="">App default</option>
								{#each rows ?? [] as row (encodeRef(row.ref))}
									<option
										value={encodeRef(row.ref)}
										selected={sameRef(ref, row.ref)}
									>
										{row.label}
									</option>
								{/each}
							</select>
						</label>
					{/each}
				</div>
			{/each}
		</details>
	{/if}

</div>

<style>
	.ai-tab {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.group-title {
		margin: 0;
		font-size: 0.94rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--text-primary);
	}
	.default-row {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.default-pick {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 0.5rem;
		align-items: center;
	}
	.default-pick select {
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
		min-width: 0;
	}
	.lib-section summary {
		cursor: pointer;
		font-size: 0.86rem;
		font-weight: 600;
		padding: 0.25rem 0;
	}
	.lib-rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.lib-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.45rem;
		border: 1px solid var(--line-hairline);
	}
	.lib-label {
		font-size: 0.86rem;
		font-weight: 600;
	}
	.chip {
		font-size: 0.66rem;
		padding: 0 0.3rem;
		border: 1px solid var(--line-hairline);
		color: var(--text-muted);
	}
	.hint {
		margin: 0;
		font-size: 0.74rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.hint.danger {
		color: var(--cat-red-soft);
	}
	.location-group {
		padding: 0.75rem;
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		background: var(--surface-1);
	}
	.monitor-panel { display: flex; flex-direction: column; gap: 0.4rem; }
	.browser-group > summary { cursor: pointer; }
	.browser-group > summary h3 { display: inline; }
	.defaults > summary { cursor: pointer; font-size: 0.86rem; font-weight: 600; }
	.host-status { font-size: 0.74rem; color: var(--text-muted); }
	.host-status summary { cursor: pointer; }
	.lib-detail { flex-basis: 100%; }
</style>
