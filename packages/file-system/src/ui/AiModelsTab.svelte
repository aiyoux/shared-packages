<script lang="ts">
	import '@shared-packages/design-system/button.css';
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
	import { onMount } from 'svelte';
	let { onConfigureMonitor }: { onConfigureMonitor?: () => void } = $props();
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
	import FeIcon from './FeIcon.svelte';
	import ModelFilesCard from './ModelFilesCard.svelte';
	import ModelStorageFooter from './ModelStorageFooter.svelte';
	import type { ModelStatus } from '@shared-packages/model-store';
	import MonitorModelsPanel from './MonitorModelsPanel.svelte';
	import MonitorStatus from './MonitorStatus.svelte';
	import { canConfigureNativeTask } from '../ai/nativeModelForm.js';
	import { MONITOR_MODEL_SETUP, monitorModelSetup } from '../ai/monitorModelSetup.js';
	import MonitorModelSetup from './MonitorModelSetup.svelte';

	const sources = listAiLibrarySources();
	// Prerequisite guides are task metadata, not pretend installed model rows.
	// Standalone hosts and failed catalogs still expose every Monitor feature.
	const monitorSections = [
		...sources.sections,
		...Object.entries(MONITOR_MODEL_SETUP)
			.filter(([task]) => !sources.sections.some((section) => section.task === task))
			.map(([task, setup]) => ({ id: task, task: task as keyof typeof MONITOR_MODEL_SETUP, title: setup.title, models: async () => [] }))
	];

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
	/** Live file counts reported by an open card, keyed by row. */
	let fileCounts = $state<Record<string, { present: number; total: number }>>({});
	/** Which of a row's `browserModelOptions` its card shows, by row key. */
	let pickedModels = $state<Record<string, string>>({});
	const rowKey = (sectionId: string, row: AiLibraryModelRow) =>
		`${sectionId}/${encodeRef(row.ref)}`;

	function downloadText(row: AiLibraryModelRow, key: string): string {
		const files = fileCounts[key] ?? row.files;
		return files ? `${files.present}/${files.total}` : statusLabel[row.status];
	}

	function downloadLabel(row: AiLibraryModelRow, key: string): string {
		const files = fileCounts[key] ?? row.files;
		return files ? `${files.present} of ${files.total} files downloaded` : statusLabel[row.status];
	}

	function loadedText(row: AiLibraryModelRow): string {
		const state = hostModels[row.ref.modelId] ?? (row.browserModel ? hostModels[row.browserModel.id] : undefined);
		return state === 'loaded' || state === 'loading' ? state : 'not loaded';
	}

	function rememberCount(key: string, status: ModelStatus) {
		fileCounts = { ...fileCounts, [key]: { present: status.present, total: status.total } };
	}

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
		for (const section of monitorSections) void refreshSection(section);
	}

	/** Monitors group: one panel per saved monitor profile. */
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let monitorsLoaded = $state(false);

	onMount(() => {
		for (const section of monitorSections) void ensureRows(section);
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

{#snippet librarySection(section: (typeof sources.sections)[number], rows: AiLibraryModelRow[], monitorId = '', configureTask: (() => void) | undefined = undefined, location: 'native' | 'api' = 'native')}
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
			{#if rows.length === 0 && configureTask}
				{#if sources.sections.includes(section)}
					<p class="hint" data-testid="ai-monitor-empty-{section.id}-{monitorId}">No model configured for this task on this monitor.</p>
				{:else}
					<p class="hint">This app does not provide a task model catalog. Configured models are listed below under On monitor device; you can register a model using Configure model.</p>
				{/if}
			{/if}
			<ul class="lib-rows">
				{#each rows as row (rowKey(section.id, row))}
					{@const key = rowKey(section.id, row)}
					<li class="lib-row" data-testid="ai-lib-row-{row.ref.modelId}">
						<details>
							<summary>
								<span class="twist"><FeIcon name="chevron-right" size={14} /></span>
								<span class="lib-label">{row.label}</span>
								<span class="pill" data-testid="ai-lib-files-{row.ref.modelId}" aria-label={downloadLabel(row, key)}>{downloadText(row, key)}</span>
								{#if row.ref.location === 'browser' && row.browserModel}
									<span class="pill" data-testid="ai-lib-loaded-{row.ref.modelId}" aria-label="Load state: {loadedText(row)}">{loadedText(row)}</span>
								{/if}
							</summary>
							<div class="lib-body">
								{#if row.detail}<p class="hint">{row.detail}</p>{/if}
								{#if row.sizeBytes}<p class="hint">{sizeLabel(row.sizeBytes)}</p>{/if}
								{#if row.install && !row.browserModel}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--secondary"
										data-testid="ai-lib-install-{section.id}-{row.ref.modelId}"
										disabled={inflight.has(key)}
										onclick={() => void runInstall(section, row)}
									>
										{inflight.has(key) ? 'Working…' : row.installLabel ?? 'Install'}
									</button>
								{/if}
								{#if row.remove && !row.browserModel}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--ghost"
										data-testid="ai-lib-remove-{section.id}-{row.ref.modelId}"
										disabled={inflight.has(key)}
										onclick={() => void runRemove(section, row)}
									>
										Remove
									</button>
								{/if}
								{#if row.browserModel}
									{@const options = row.browserModelOptions}
									{@const picked = options?.find((model) => model.id === pickedModels[key]) ?? row.browserModel}
									{#if options?.length}
										<select aria-label="{row.label}: model" data-testid="ai-lib-pick-{row.ref.modelId}"
											value={picked.id} onchange={(event) => pickedModels = { ...pickedModels, [key]: event.currentTarget.value }}>
											{#each options as model (model.id)}<option value={model.id}>{model.label}</option>{/each}
										</select>
									{/if}
									<ModelFilesCard def={picked} showCount={false} onStatus={(status) => rememberCount(key, status)} onChanged={() => void refreshSection(section)} />
								{/if}
								{#if row.note}
									<p class="hint">{row.note}</p>
								{/if}
							</div>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
		{#if monitorId}
			<MonitorModelSetup task={section.task} {location} />
		{/if}
		{#if configureTask}
			<button type="button" class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="ai-monitor-configure-{section.id}-{monitorId}"
				aria-label="Configure {section.title} model"
				onclick={configureTask}>Configure model…</button>
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
		<ModelStorageFooter />
		<details class="host-status" data-testid="ai-browser-host">
			<summary>Browser model status</summary>
			<p class="hint">{hostLabel}</p>
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
						{#snippet deviceModels(configureTask)}
							{#each monitorSections as section (section.id)}
								{@const task = section.task}
								{@const rows = sectionStates[section.id]?.rows?.filter((row) => row.ref.location === 'monitor-native' && row.ref.monitorProfileId === profile.id) ?? []}
								{#if rows.length || monitorModelSetup(task)}
									{@render librarySection(section, rows, profile.id, canConfigureNativeTask(task) ? () => configureTask(task) : undefined)}
								{/if}
							{/each}
						{/snippet}
						{#snippet apiModels(addApiConnection)}
							{#each monitorSections as section (section.id)}
								{@const rows = sectionStates[section.id]?.rows?.filter((row) => row.ref.location === 'monitor-provider' && row.ref.monitorProfileId === profile.id) ?? []}
								{#if rows.length}
									{@render librarySection(section, rows, `${profile.id}-api`, undefined, 'api')}
								{:else if canConfigureNativeTask(section.task)}
									<details class="lib-section" data-testid="ai-lib-section-{section.id}-{profile.id}-api">
										<summary>{section.title}</summary>
										{#if sectionStates[section.id]?.error}
											<p class="hint danger">{sectionStates[section.id].error}</p>
										{:else if !sectionStates[section.id]?.rows}
											<p class="hint">Loading models…</p>
										{:else if !sources.sections.includes(section)}
											<p class="hint">This app does not provide a task model catalog. Manage API connections below; open the hub’s AI settings to view configured media offers.</p>
										{:else}
											<p class="hint" data-testid="ai-provider-empty-{section.id}-{profile.id}">No {section.title.toLowerCase()} API model configured on this monitor.</p>
										{/if}
										<MonitorModelSetup task={section.task} location="api" />
										<button type="button" class="ds-btn ds-btn--sm ds-btn--secondary"
											aria-label="Configure {section.title} API" onclick={addApiConnection}>Add API connection…</button>
									</details>
								{/if}
							{/each}
						{/snippet}
					</MonitorModelsPanel>
				</section>
			{/each}
		{:else if monitorsLoaded}
			<p class="hint" data-testid="ai-monitors-none">No monitors added. Add a monitor on the Connections tab to run models on that device or connect it to an API.</p>
			<p class="hint">Monitor features stay listed below so you can prepare their backends before connecting a device.</p>
			{#each Object.entries(MONITOR_MODEL_SETUP) as [task, setup] (task)}
				<details class="lib-section" data-testid="ai-monitor-discovery-{task}">
					<summary>{setup.title}</summary>
					<MonitorModelSetup {task} />
					{#if canConfigureNativeTask(task)}<MonitorModelSetup {task} location="api" />{/if}
				</details>
			{/each}
			{#if onConfigureMonitor}<button type="button" class="ds-btn ds-btn--sm ds-btn--secondary" onclick={onConfigureMonitor}>Add a Monitor…</button>{/if}
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
	}
	.lib-row {
		padding: 0.15rem 0;
		background: none;
		border: none;
	}
	.lib-row details > summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		cursor: pointer;
		list-style: none;
	}
	.lib-row summary::-webkit-details-marker { display: none; }
	.lib-row summary::marker { content: ''; }
	.twist {
		display: inline-flex;
		color: var(--text-muted);
		transition: transform 0.12s ease;
	}
	.lib-row details[open] > summary .twist { transform: rotate(90deg); }
	.lib-body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.2rem 0 0.45rem 1.15rem;
	}
	.lib-label {
		font-size: 0.86rem;
		font-weight: 600;
	}
	.pill {
		font-size: 0.66rem;
		line-height: 1.5;
		padding: 0 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--line-hairline);
		color: var(--text-muted);
		background: transparent;
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
</style>
