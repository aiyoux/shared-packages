<script lang="ts">
	/**
	 * AI section for a monitor connection: capability-gated listing and
	 * profile install. Keys live daemon-side — the install form sends the key
	 * to the monitor once and clears it from component state immediately;
	 * nothing is persisted in the browser.
	 */
	import { toast } from '@shared-packages/ui';
	import { createMonitorClient } from '../monitor/client.js';
	import {
		deleteAiProfile,
		installAiProfile,
		listAiModels,
		listAiProfiles,
		normalizeAiBaseUrl,
		validateAiProfileInput,
		setAiSelection,
		type AiModelListResult,
		type AiProfileListResult
	} from '../ai/index.js';
	import { formatExplorerError } from './explorerError.js';

	interface Props {
		/** Monitor base URL to probe and operate on. */
		baseUrl: string;
		/** Notified after any change so the host can refresh. */
		onChanged?: () => void;
	}

	let { baseUrl, onChanged }: Props = $props();

	let supported = $state<boolean | null>(null); // null = probing
	let probeError = $state('');
	let probedUrl = $state('');
	let models = $state<AiModelListResult | null>(null);
	let profiles = $state<AiProfileListResult | null>(null);
	let listingBusy = $state(false);

	let showInstall = $state(false);
	let instName = $state('');
	let instBaseUrl = $state('');
	let instKey = $state('');
	let instDefault = $state(false);
	let instError = $state('');
	let installing = $state(false);

	let modelsError = $state('');

	async function probe() {
		const url = normalizeAiBaseUrl(baseUrl);
		if (!url) {
			supported = null;
			return;
		}
		probedUrl = url;
		supported = null;
		probeError = '';
		try {
			const meta = await createMonitorClient({ baseUrl: url }).meta();
			const caps = (meta.capabilities as { ai?: { chat?: boolean } } | undefined)?.ai;
			supported = caps?.chat === true;
			if (!supported) {
				probeError = 'This monitor is reachable but does not serve AI — update the daemon.';
			}
		} catch (e) {
			supported = false;
			probeError = formatExplorerError(e);
		}
		if (supported) void refresh();
	}

	async function refresh() {
		if (!supported || !probedUrl) return;
		listingBusy = true;
		try {
			[models, profiles] = await Promise.all([
				listAiModels(probedUrl),
				listAiProfiles(probedUrl)
			]);
			modelsError = '';
		} catch (e) {
			modelsError = formatExplorerError(e);
		} finally {
			listingBusy = false;
		}
	}

	// Re-probe when the edited URL settles.
	$effect(() => {
		const url = baseUrl;
		const t = setTimeout(() => void probe(), 400);
		return () => clearTimeout(t);
	});

	async function install() {
		instError = '';
		const validation = validateAiProfileInput({
			name: instName,
			baseUrl: instBaseUrl,
			apiKey: instKey,
			requireApiKey: true
		});
		if (validation) {
			instError = validation;
			return;
		}
		installing = true;
		try {
			await installAiProfile(probedUrl, {
				name: instName,
				baseUrl: normalizeAiBaseUrl(instBaseUrl),
				apiKey: instKey.trim(),
				default: instDefault
			});
			// The key existed only in component state; drop it now.
			instKey = '';
			instError = '';
			instName = '';
			instBaseUrl = '';
			instDefault = false;
			await refresh();
			onChanged?.();
			toast.success('AI profile installed on the monitor');
		} catch (e) {
			instError = formatExplorerError(e);
		} finally {
			installing = false;
		}
	}

	async function remove(id: string) {
		try {
			await deleteAiProfile(probedUrl, id);
			await refresh();
			onChanged?.();
		} catch (e) {
			toast.error(formatExplorerError(e));
		}
	}

	const groupedModels = $derived.by(() => {
		const groups = new Map<string, { profileName: string; defaultProfile: boolean; models: string[] }>();
		for (const m of models?.models ?? []) {
			const g = groups.get(m.profile) ?? {
				profileName: m.profileName || m.profile,
				defaultProfile: m.defaultProfile,
				models: []
			};
			g.models.push(m.id);
			groups.set(m.profile, g);
		}
		return [...groups.entries()];
	});
</script>

<div class="ai-section" data-testid="monitor-ai-section">
	<div class="ai-head">
		<span class="ai-title">AI</span>
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--ghost"
			data-testid="monitor-ai-check"
			disabled={listingBusy}
			onclick={() => void probe()}
		>
			Check
		</button>
	</div>

	{#if supported === null}
		<p class="ai-note" data-testid="monitor-ai-probing">Checking this monitor for AI…</p>
	{:else if supported === false}
		<p class="ai-note" data-testid="monitor-ai-unsupported">
			{probeError || 'This monitor does not serve AI. Update the monitor daemon to enable it.'}
		</p>
	{:else}
		{#if profiles && profiles.profiles.length}
			<ul class="ai-profiles" data-testid="monitor-ai-profiles">
				{#each profiles.profiles as p (p.id)}
					<li>
						<div class="ai-profile-main">
							<span class="ai-profile-name">
								{p.name}
								{#if p.default}<span class="ai-badge">default</span>{/if}
								<span class="ai-badge ai-badge--muted">{p.source}</span>
							</span>
							<span class="ai-profile-meta">
								{p.baseUrl}
								{#if p.keyFingerprint}
									· key {p.keyFingerprint}
								{:else}
									· no key
								{/if}
							</span>
						</div>
						{#if p.source === 'managed'}
							<button
								type="button"
								class="ds-btn ds-btn--sm ds-btn--ghost danger"
								data-testid="monitor-ai-profile-delete"
								disabled={listingBusy}
								onclick={() => void remove(p.id)}>Remove</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="ai-note" data-testid="monitor-ai-no-profiles">
				No AI profile installed on this monitor yet.
			</p>
		{/if}

		{#if groupedModels.length}
			<div class="ai-models" data-testid="monitor-ai-models">
				{#each groupedModels as [profileId, g] (profileId)}
					<div class="ai-model-group">
						<span class="ai-group-name">{g.profileName}</span>
						<span class="ai-group-models">{g.models.join(', ')}</span>
					</div>
				{/each}
				<p class="ai-note">
					Pick the model in the app that uses it (Sketcher assistant, Documents assistant).
				</p>
			</div>
		{/if}
		{#if modelsError}
			<p class="ai-note danger" data-testid="monitor-ai-models-error">{modelsError}</p>
		{/if}
		{#if models && models.errors.length}
			{#each models.errors as e (e.profile)}
				<p class="ai-note danger">Profile “{e.profile}”: {e.message}</p>
			{/each}
		{/if}

		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="monitor-ai-install-toggle"
			disabled={installing}
			onclick={() => (showInstall = !showInstall)}
		>
			{showInstall ? 'Cancel install' : 'Install profile…'}
		</button>
		{#if showInstall}
			<div class="ai-install" data-testid="monitor-ai-install">
				<label>
					Name
					<input data-testid="monitor-ai-name" bind:value={instName} autocomplete="off" />
				</label>
				<label>
					Upstream base URL (OpenAI-compatible)
					<input
						data-testid="monitor-ai-base-url"
						bind:value={instBaseUrl}
						placeholder="https://api.openai.com/v1"
						autocomplete="off"
					/>
				</label>
				<label>
					API key
					<input
						data-testid="monitor-ai-key"
						type="password"
						bind:value={instKey}
						autocomplete="off"
					/>
				</label>
				<p class="ai-note">
					The key is sent to the monitor once and stored there — never in this browser.
				</p>
				<label class="check">
					<input
						data-testid="monitor-ai-default"
						type="checkbox"
						bind:checked={instDefault}
					/>
					Set as the monitor's default profile
				</label>
				{#if instError}
					<p class="ai-note danger" data-testid="monitor-ai-install-error">{instError}</p>
				{/if}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--primary"
					data-testid="monitor-ai-install-save"
					disabled={installing}
					onclick={() => void install()}
				>
					{installing ? 'Installing…' : 'Install on monitor'}
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.ai-section {
		margin-top: 0.35rem;
		padding-top: 0.55rem;
		border-top: 1px dashed var(--line-hairline);
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.ai-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.ai-title {
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.ai-note {
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.ai-note.danger,
	.danger {
		color: var(--cat-red-soft);
	}
	.ai-profiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ai-profiles li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.45rem;
		border: 1px solid var(--line-hairline);
	}
	.ai-profile-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.ai-profile-name {
		font-size: 0.82rem;
		font-weight: 650;
	}
	.ai-profile-meta {
		font-size: 0.72rem;
		opacity: 0.7;
		overflow-wrap: anywhere;
	}
	.ai-badge {
		font-size: 0.66rem;
		padding: 0 0.3rem;
		border: 1px solid var(--line-hairline);
		color: var(--text-muted);
	}
	.ai-badge--muted {
		opacity: 0.65;
	}
	.ai-models {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ai-model-group {
		display: flex;
		gap: 0.45rem;
		font-size: 0.78rem;
		min-width: 0;
	}
	.ai-group-name {
		font-weight: 600;
		white-space: nowrap;
	}
	.ai-group-models {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.ai-install {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.ai-install label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
	}
	.ai-install label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
	}
	.ai-install input:not([type='checkbox']) {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
	}
</style>