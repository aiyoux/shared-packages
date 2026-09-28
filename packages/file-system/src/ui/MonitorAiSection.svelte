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
		addAiNativeModel,
		deleteAiProfile,
		deleteAiNativeModel,
		installAiLibraryModel,
		installAiProfile,
		listAiLibrary,
		listAiModels,
		listAiNativeModels,
		listAiProfiles,
		normalizeAiBaseUrl,
		removeAiLibraryModel,
		validateAiProfileInput,
		setAiSelection,
		type AiLibraryListResult,
		type AiModelListResult,
		type AiNativeModelRow,
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

	// Model library + native model rows (daemons without them omit the routes).
	let library = $state<AiLibraryListResult | null>(null);
	let nativeRows = $state<AiNativeModelRow[]>([]);
	let libraryError = $state('');
	let installingId = $state('');
	let showAddModel = $state(false);
	let addName = $state('');
	let addBinary = $state('');
	let addModel = $state('');
	let addTask = $state('transcription');
	let addDevice = $state<'cpu' | 'gpu'>('cpu');
	let addBackend = $state('');
	let addError = $state('');
	let addingModel = $state(false);

	const sizeLabel = (bytes: number) =>
		bytes >= 1024 * 1024 * 1024
			? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
			: `${Math.round(bytes / (1024 * 1024))} MiB`;

	/** The tasks the native runtimes cover; a row is per task × file. */
	const ADD_TASKS: Array<{ value: string; label: string }> = [
		{ value: 'transcription', label: 'Transcription' },
		{ value: 'chat', label: 'Chat' },
		{ value: 'text-to-speech', label: 'Text to speech' },
		{ value: 'image-generation', label: 'Image generation' }
	];

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
		// Library and native-model rows are additive: a daemon without them
		// keeps working, the sections just stay hidden.
		try {
			[library, nativeRows] = await Promise.all([
				listAiLibrary(probedUrl),
				listAiNativeModels(probedUrl)
			]);
			libraryError = '';
		} catch (e) {
			library = null;
			nativeRows = [];
			libraryError = formatExplorerError(e);
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

	async function installLibraryModel(id: string) {
		installingId = id;
		try {
			await installAiLibraryModel(probedUrl, id);
			await refresh();
			onChanged?.();
			toast.success('Model downloaded on the monitor');
		} catch (e) {
			toast.error(formatExplorerError(e));
		} finally {
			installingId = '';
		}
	}

	async function removeLibraryModel(id: string) {
		try {
			await removeAiLibraryModel(probedUrl, id);
			await refresh();
			onChanged?.();
		} catch (e) {
			toast.error(formatExplorerError(e));
		}
	}

	/** Prefill the enable form from a library entry's installed file. */
	function startAddModel(fileName: string, installedPath: string) {
		showAddModel = true;
		addName = fileName.replace(/\.gguf$|\.bin$|\.safetensors$/i, '');
		addModel = installedPath;
		addTask = 'transcription';
		addDevice = 'cpu';
		addError = '';
	}

	async function enableModel() {
		addError = '';
		if (!addName.trim() || !addBinary.trim() || !addModel.trim()) {
			addError = 'Name, binary path, and model path are required.';
			return;
		}
		addingModel = true;
		try {
			await addAiNativeModel(probedUrl, {
				name: addName.trim(),
				task: addTask as AiNativeModelRow['task'],
				device: addDevice,
				binary: addBinary.trim(),
				model: addModel.trim(),
				backend: addBackend.trim() || undefined
			});
			addName = '';
			addBinary = '';
			addModel = '';
			addBackend = '';
			showAddModel = false;
			await refresh();
			onChanged?.();
			toast.success('Model enabled — it is now listed in the task pickers');
		} catch (e) {
			addError = formatExplorerError(e);
		} finally {
			addingModel = false;
		}
	}

	async function removeNativeRow(id: string) {
		try {
			await deleteAiNativeModel(probedUrl, id);
			await refresh();
			onChanged?.();
		} catch (e) {
			toast.error(formatExplorerError(e));
		}
	}
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

		{#if library || nativeRows.length || libraryError}
			<div class="ai-native" data-testid="monitor-ai-native">
				<div class="ai-native-head">
					<span class="ai-native-title">Models</span>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="monitor-ai-add-model-toggle"
						disabled={addingModel}
						onclick={() => (showAddModel = !showAddModel)}
					>
						{showAddModel ? 'Cancel' : 'Add model…'}
					</button>
				</div>

				{#if nativeRows.length}
					<ul class="ai-profiles" data-testid="monitor-ai-native-models">
						{#each nativeRows as row (row.id)}
							<li>
								<div class="ai-profile-main">
									<span class="ai-profile-name">
										{row.name}
										<span class="ai-badge ai-badge--muted">{row.task}</span>
										<span class="ai-badge ai-badge--muted">{row.device}</span>
										<span class="ai-badge ai-badge--muted">{row.source}</span>
									</span>
									<span class="ai-profile-meta">
										{row.binary}
										·
										{row.model}
										{#if row.backend}· backend {row.backend}{/if}
									</span>
								</div>
								{#if row.source === 'managed'}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--ghost danger"
										data-testid="monitor-ai-native-delete"
										disabled={addingModel}
										onclick={() => void removeNativeRow(row.id)}>Remove</button
									>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if libraryError}
					<p class="ai-note danger" data-testid="monitor-ai-native-error">{libraryError}</p>
				{/if}

				{#if library && library.entries.length}
					<ul class="ai-lib" data-testid="monitor-ai-library">
						{#each library.entries as entry (entry.id)}
							<li>
								<div class="ai-profile-main">
									<span class="ai-profile-name">
										{entry.name}
										<span class="ai-badge ai-badge--muted">{sizeLabel(entry.sizeBytes)}</span>
										<span class="ai-badge ai-badge--muted">{entry.license}</span>
									</span>
									<span class="ai-profile-meta">
										{#if entry.installedPath}
											{entry.installedPath} · {sizeLabel(entry.installedBytes ?? 0)}
										{:else}
											{entry.runtime} · not installed
										{/if}
									</span>
								</div>
								{#if entry.installedPath}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--secondary"
										data-testid="monitor-ai-model-enable"
										onclick={() => startAddModel(entry.fileName, entry.installedPath ?? '')}
									>
										Add model…
									</button>
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--ghost danger"
										data-testid="monitor-ai-model-remove-file"
										onclick={() => void removeLibraryModel(entry.id)}>Remove</button
									>
								{:else}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--secondary"
										data-testid="monitor-ai-model-download"
										disabled={installingId !== ''}
										onclick={() => void installLibraryModel(entry.id)}
									>
										{installingId === entry.id ? 'Downloading…' : 'Download'}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
					<p class="ai-note">Downloads run on the monitor host, not in this browser.</p>
				{/if}

				{#if showAddModel}
					<div class="ai-install" data-testid="monitor-ai-add-model">
						<label>
							Name
							<input data-testid="monitor-ai-model-name" bind:value={addName} autocomplete="off" />
						</label>
						<label>
							Runtime binary (absolute path on the monitor)
							<input
								data-testid="monitor-ai-model-binary"
								bind:value={addBinary}
								placeholder="/usr/local/bin/whisper-cli"
								autocomplete="off"
							/>
						</label>
						<label>
							Model file (absolute path on the monitor)
							<input data-testid="monitor-ai-model-file" bind:value={addModel} autocomplete="off" />
						</label>
						<div class="ai-add-row">
							<label>
								Task
								<select data-testid="monitor-ai-model-task" bind:value={addTask}>
									{#each ADD_TASKS as t (t.value)}
										<option value={t.value}>{t.label}</option>
									{/each}
								</select>
							</label>
							<label>
								Device
								<select data-testid="monitor-ai-model-device" bind:value={addDevice}>
									<option value="cpu">CPU</option>
									<option value="gpu">GPU</option>
								</select>
							</label>
							{#if addTask === 'image-generation'}
								<label>
									Backend
									<input data-testid="monitor-ai-model-backend" bind:value={addBackend} autocomplete="off" />
								</label>
							{/if}
						</div>
						{#if addError}
							<p class="ai-note danger" data-testid="monitor-ai-model-error">{addError}</p>
						{/if}
						<button
							type="button"
							class="ds-btn ds-btn--sm ds-btn--primary"
							data-testid="monitor-ai-model-save"
							disabled={addingModel}
							onclick={() => void enableModel()}
						>
							{addingModel ? 'Enabling…' : 'Enable on monitor'}
						</button>
					</div>
				{/if}
			</div>
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
	.ai-native {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.ai-native-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.ai-native-title {
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.ai-lib {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.ai-lib li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.45rem;
		border: 1px solid var(--line-hairline);
	}
	.ai-add-row {
		display: flex;
		gap: 0.6rem;
	}
	.ai-add-row label {
		flex: 1;
		min-width: 0;
	}
	.ai-install select {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
	}
</style>