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
	import { onMount } from 'svelte';
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

	/** task → the section rows candidates for the Defaults pickers read;
	 * loaded lazily and re-read whenever a selection ping arrives. */
	let candidates = $state<Record<string, AiLibraryModelRow[] | null>>({});

	$effect(() => {
		for (const group of defaultsGroups) {
			if (group.task in candidates) continue;
			candidates = { ...candidates, [group.task]: null };
			const section = sources.sections.find((s) => s.task === group.task);
			if (!section) continue;
			section
				.models()
				.then((rows) => {
					candidates = { ...candidates, [group.task]: rows };
				})
				.catch(() => {
					candidates = { ...candidates, [group.task]: [] };
				});
		}
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

	function sameRef(a: AiModelRef | null, b: AiModelRef): boolean {
		return (
			a != null &&
			a.location === b.location &&
			a.modelId === b.modelId &&
			(a.sourceId ?? null) === (b.sourceId ?? null) &&
			(a.variantId ?? null) === (b.variantId ?? null)
		);
	}

	/** Library sections: lazy rows per registered section. */
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
		remote: 'streamed on use',
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
			sectionStates = {
				...sectionStates,
				[section.id]: { rows: await section.models(), busy: false, error: '' }
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
		`${sectionId}/${row.ref.modelId}/${row.ref.sourceId ?? ''}`;

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
			sectionStates = {
				...sectionStates,
				[section.id]: { rows: await section.models(), busy: false, error: '' }
			};
		} catch (e) {
			sectionStates = {
				...sectionStates,
				[section.id]: { rows: null, busy: false, error: e instanceof Error ? e.message : String(e) }
			};
		}
	}

	/** Monitors group: one panel per saved monitor profile. */
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let monitorsLoaded = $state(false);

	onMount(() => {
		void (async () => {
			try {
				monitorProfiles = await listMonitorProfiles();
			} catch {
				monitorProfiles = [];
			}
			monitorsLoaded = true;
		})();
	});
</script>

<div class="ai-tab">
	{#if sources.sections.length === 0}
		<p class="hint" data-testid="ai-library-unavailable">
			The AI model library is not available in this app. Open the hub's settings popup to manage models.
		</p>
	{/if}

	{#if defaultsGroups.length}
		<section class="group" data-testid="ai-defaults">
			<h3 class="group-title">Defaults</h3>
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
		</section>
	{/if}

	{#if sources.sections.length}
		<section class="group" data-testid="ai-library">
			<h3 class="group-title">Library</h3>
			{#each sources.sections as section (section.id)}
				{@const state = sectionStates[section.id]}
				<details
					class="lib-section"
					data-testid="ai-lib-section-{section.id}"
					ontoggle={() => void ensureRows(section)}
				>
					<summary>{section.title}</summary>
					{#if state?.busy}
						<p class="hint">Loading models…</p>
					{:else if state?.error}
						<p class="hint danger">{state.error}</p>
					{:else if state?.rows}
						<ul class="lib-rows">
							{#each state.rows as row (rowKey(section.id, row))}
								<li class="lib-row" data-testid="ai-lib-row-{row.ref.modelId}">
									<span class="lib-label">{row.label}</span>
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
											{inflight.has(rowKey(section.id, row)) ? 'Working…' : 'Install'}
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
			{/each}
		</section>
	{/if}

	<section class="group" data-testid="ai-monitors">
		<h3 class="group-title">Monitors</h3>
		{#if monitorProfiles.length}
			<div class="monitor-panels">
				{#each monitorProfiles as profile (profile.id)}
					<div class="monitor-panel">
						<h4 class="panel-name">{profile.name}</h4>
						<MonitorModelsPanel baseUrl={profile.baseUrl} />
					</div>
				{/each}
			</div>
		{:else if monitorsLoaded}
			<p class="hint" data-testid="ai-monitors-none">
				No monitor connected. Models that run on your other machines are configured per monitor on
				the Connections tab.
			</p>
		{/if}
	</section>
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
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
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
	.monitor-panel h4 {
		margin: 0.6rem 0 0.15rem;
		font-size: 0.8rem;
	}
</style>