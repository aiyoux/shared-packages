<script lang="ts">
	/**
	 * The AI panel for one monitor, inside the settings popup's "AI models"
	 * tab: capability-gated profile/library/native-model management. Moved
	 * verbatim out of the monitor connection form (RemoteConnectionsDialog
	 * used to host it there). Keys live daemon-side — the install form sends
	 * the key to the monitor once and clears it from component state
	 * immediately; nothing is persisted in the browser.
	 */
	import type { Snippet } from 'svelte';
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
		type AiLibraryListResult,
		type AiLibraryEntry,
		type AiModelListResult,
		type AiNativeModelRow,
		type AiProfileListResult
	} from '../ai/index.js';
	import { NATIVE_RUNTIME_NAMES, canConfigureNativeTask, nativeModelLibraryPrefill, nativeModelTaskPrefill, nativeModelFormInput } from '../ai/nativeModelForm.js';
	import type { AiTask } from '../ai/catalog.js';
	import { formatExplorerError } from './explorerError.js';

	interface Props {
		/** Monitor base URL to probe and operate on. */
		baseUrl: string;
		/** Notified after any change so the host can refresh. */
		onChanged?: () => void;
		/** Additional catalog tools that run on this monitor device. */
		deviceModels?: Snippet<[configureTask: (task: AiTask) => void]>;
		apiModels?: Snippet<[addApiConnection: () => void]>;
		hasDeviceModels?: boolean;
	}

	let { baseUrl, onChanged, deviceModels, apiModels, hasDeviceModels = false }: Props = $props();

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
	let nativeError = $state('');
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
		if (supported) { await refresh(); onChanged?.(); }
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
		// An older daemon may expose either endpoint. Do not hide a successful
		// native-model response just because its curated library is unavailable.
		const [libraryResult, nativeResult] = await Promise.allSettled([
			listAiLibrary(probedUrl), listAiNativeModels(probedUrl)
		]);
		library = libraryResult.status === 'fulfilled' ? libraryResult.value : null;
		libraryError = libraryResult.status === 'rejected' ? formatExplorerError(libraryResult.reason) : '';
		nativeRows = nativeResult.status === 'fulfilled' ? nativeResult.value : [];
		nativeError = nativeResult.status === 'rejected' ? formatExplorerError(nativeResult.reason) : '';
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
			toast.success('API connection saved on the monitor');
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
	function startAddModel(entry: AiLibraryEntry) {
		const initial = nativeModelLibraryPrefill(entry);
		applyModelPrefill(initial);
	}

	function configureTask(task: AiTask) {
		if (canConfigureNativeTask(task)) applyModelPrefill(nativeModelTaskPrefill(task));
	}

	function applyModelPrefill(initial: ReturnType<typeof nativeModelTaskPrefill>) {
		showAddModel = true;
		addName = initial.name;
		addModel = initial.model;
		addTask = initial.task;
		addBinary = initial.binary;
		addBackend = initial.backend;
		addDevice = initial.device;
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
			await addAiNativeModel(probedUrl, nativeModelFormInput({
				name: addName.trim(),
				task: addTask as AiNativeModelRow['task'],
				device: addDevice,
				binary: addBinary.trim(),
				model: addModel.trim(),
				backend: addBackend
			}));
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
		<span class="ai-note">Model settings</span>
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--ghost"
			data-testid="monitor-ai-check"
			disabled={listingBusy}
			onclick={() => void probe()}
		>
			Refresh
		</button>
	</div>

	{#if supported === null}
		<p class="ai-note" data-testid="monitor-ai-probing">Checking this monitor for AI…</p>
	{:else if supported === false}
		<p class="ai-note" data-testid="monitor-ai-unsupported">
			{probeError || 'This monitor does not serve AI. Update the monitor daemon to enable it.'}
		</p>
	{:else}
		<section class="ai-native" data-testid="monitor-ai-native" aria-label="On monitor device">
			<div class="ai-native-head">
				<h4 class="ai-native-title">On monitor device:</h4>
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

			<p class="ai-note">Models and tools that run on this device.</p>
			{@render deviceModels?.(configureTask)}
			{#if !nativeRows.length && !libraryError && !hasDeviceModels}<p class="ai-note">No models configured on this device yet.</p>{/if}
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

			{#if nativeError}<p class="ai-note danger" data-testid="monitor-ai-native-error">{nativeError}</p>{/if}
			{#if libraryError}
				<p class="ai-note danger" data-testid="monitor-ai-library-error">{libraryError}</p>
			{/if}

			{#if library && library.entries.length}
				<details class="ai-downloads">
					<summary>Downloadable models</summary>
					<ul class="ai-lib" data-testid="monitor-ai-library">
						{#each library.entries as entry (entry.id)}
							<li>
								<div class="ai-profile-main">
									<span class="ai-profile-name">
										{entry.name}
										<span class="ai-badge ai-badge--muted">{sizeLabel(entry.sizeBytes)}</span>
										<span class="ai-badge ai-badge--muted">{entry.license}</span>
										<span class="ai-badge ai-badge--muted">{entry.task}</span>
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
										onclick={() => startAddModel(entry)}
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
					<p class="ai-note">Download a model, then add it to the models configured on this device.</p>
				</details>
			{/if}

			{#if showAddModel}
				<div class="ai-install" data-testid="monitor-ai-add-model">
					<p class="ai-note">Install the runtime and its compatible weights on the monitor, then enter their absolute paths here. The downloadable library contains only the models listed above.</p>
					{#if addTask === 'text-to-speech'}
						<p class="ai-note">Piper needs both the .onnx model and the matching .onnx.json configuration beside it.</p>
					{/if}
					<label>
						Name
						<input data-testid="monitor-ai-model-name" bind:value={addName} autocomplete="off" />
					</label>
					<label>
						Runtime binary (absolute path on the monitor)
						<input
							data-testid="monitor-ai-model-binary"
							bind:value={addBinary}
							placeholder={`/usr/local/bin/${NATIVE_RUNTIME_NAMES[addTask] ?? 'runtime'}`}
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
		</section>

		<section class="ai-api" data-testid="monitor-ai-api" aria-label="Through monitor to API">
			<h4 class="ai-native-title">Through monitor to API:</h4>
			{@render apiModels?.(() => (showInstall = true))}
			<p class="ai-note">Connect this monitor to a chat API. The monitor makes the requests and stores the API key. Image, speech synthesis, and transcription API models currently require media model entries in the monitor configuration.</p>
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
					No API connections configured on this monitor yet.
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
				{showInstall ? 'Cancel' : 'Add API connection…'}
			</button>
			{#if showInstall}
				<div class="ai-install" data-testid="monitor-ai-install">
					<label>
						Name
						<input data-testid="monitor-ai-name" bind:value={instName} autocomplete="off" />
					</label>
					<label>
						API base URL (OpenAI-compatible)
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
						Use as the default API connection
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
						{installing ? 'Saving…' : 'Save API connection'}
					</button>
				</div>
			{/if}
		</section>
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
	.ai-native,
	.ai-api {
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
		margin: 0;
		font-size: 0.86rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.ai-downloads summary { cursor: pointer; font-size: 0.78rem; font-weight: 600; margin-bottom: 0.35rem; }
	.ai-api { border-top: 1px solid var(--line-hairline); padding-top: 0.65rem; margin-top: 0.4rem; }
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
