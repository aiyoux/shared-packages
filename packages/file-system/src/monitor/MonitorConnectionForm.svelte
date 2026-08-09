<script lang="ts">
	import {
		deleteProfile,
		getActiveProfileId,
		listProfiles,
		saveProfile,
		setActiveProfileId
	} from './credentials.js';
	import {
		DEFAULT_MONITOR_BASE_URL,
		validateMonitorProfileInput,
		type MonitorConnectionProfileV1
	} from './types.js';

	interface Props {
		onConnected?: (profile: MonitorConnectionProfileV1) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
		autoConnectOnSave?: boolean;
	}

	let { onConnected, onDisconnected, onCancel, autoConnectOnSave = true }: Props = $props();

	let profiles = $state<MonitorConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let name = $state('Local monitor');
	let baseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let rootPath = $state('/tmp');
	let error = $state('');
	let busy = $state(false);

	async function reload() {
		profiles = await listProfiles();
		activeId = await getActiveProfileId();
	}

	$effect(() => {
		void reload();
	});

	function clearFieldsForNew() {
		editingId = null;
		name = 'Local monitor';
		baseUrl = DEFAULT_MONITOR_BASE_URL;
		rootPath = '/tmp';
		error = '';
	}

	function loadForEdit(p: MonitorConnectionProfileV1) {
		editingId = p.id;
		name = p.name;
		baseUrl = p.baseUrl || DEFAULT_MONITOR_BASE_URL;
		rootPath = p.rootPath;
		error = '';
	}

	function newId(): string {
		return crypto.randomUUID();
	}

	async function save(connectAfter: boolean) {
		error = '';
		const err = validateMonitorProfileInput({ name, baseUrl, rootPath });
		if (err) {
			error = err;
			return;
		}
		busy = true;
		try {
			const id = editingId ?? newId();
			const saved = await saveProfile({
				id,
				name,
				baseUrl: baseUrl.trim() || DEFAULT_MONITOR_BASE_URL,
				rootPath
			});
			await setActiveProfileId(saved.id);
			await reload();
			editingId = saved.id;
			if (connectAfter && autoConnectOnSave) {
				onConnected?.(saved);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function remove(id: string) {
		busy = true;
		try {
			await deleteProfile(id);
			if (activeId === id) onDisconnected?.();
			if (editingId === id) clearFieldsForNew();
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function connectExisting(p: MonitorConnectionProfileV1) {
		busy = true;
		error = '';
		try {
			await setActiveProfileId(p.id);
			onConnected?.(p);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="mon-form" data-testid="monitor-connection-form">
	<p class="lead">
		Browse a local directory via the <strong>monitor</strong> service (loopback,
		<code>/v1/fs</code>). Read-only. Default
		<code>http://127.0.0.1:8300</code>.
	</p>

	{#if profiles.length}
		<ul class="profile-list" data-testid="monitor-profile-list">
			{#each profiles as p (p.id)}
				<li>
					<button type="button" class="profile-btn" disabled={busy} onclick={() => loadForEdit(p)}>
						<span class="pn">{p.name}</span>
						<span class="pd">{p.rootPath}</span>
					</button>
					<button
						type="button"
						class="connect"
						disabled={busy}
						onclick={() => connectExisting(p)}
						data-testid="monitor-connect-profile"
					>
						Connect
					</button>
					<button type="button" class="ghost" disabled={busy} onclick={() => remove(p.id)}>Delete</button>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="fields">
		<label>
			Name
			<input type="text" bind:value={name} data-testid="monitor-name" disabled={busy} />
		</label>
		<label>
			Base URL
			<input type="text" bind:value={baseUrl} data-testid="monitor-base-url" disabled={busy} />
		</label>
		<label>
			Root path (absolute)
			<input type="text" bind:value={rootPath} data-testid="monitor-root-path" disabled={busy} />
		</label>
	</div>

	{#if error}
		<p class="err" role="alert" data-testid="monitor-form-error">{error}</p>
	{/if}

	<div class="actions">
		<button type="button" class="primary" disabled={busy} data-testid="monitor-save-connect" onclick={() => save(true)}>
			{busy ? 'Working…' : 'Save & connect'}
		</button>
		<button type="button" class="ghost" disabled={busy} onclick={() => save(false)}>Save</button>
		<button type="button" class="ghost" disabled={busy} onclick={clearFieldsForNew}>New</button>
		{#if onCancel}
			<button type="button" class="ghost" disabled={busy} onclick={() => onCancel?.()}>Cancel</button>
		{/if}
	</div>
</div>

<style>
	.mon-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--border, #334155);
		border-radius: 10px;
		background: var(--surface, #1e293b);
	}
	.lead {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary, #94a3b8);
		line-height: 1.45;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8rem;
		color: var(--text-muted, #94a3b8);
	}
	input {
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--border, #475569);
		background: #0f172a;
		color: inherit;
		font-size: 0.9rem;
	}
	.profile-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.profile-list li {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.profile-btn {
		flex: 1;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--border, #475569);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.pn {
		font-weight: 600;
		font-size: 0.9rem;
	}
	.pd {
		font-size: 0.75rem;
		opacity: 0.8;
		font-family: ui-monospace, monospace;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	button {
		padding: 8px 12px;
		border-radius: 8px;
		border: 1px solid var(--border, #475569);
		background: transparent;
		color: inherit;
		cursor: pointer;
		font-size: 0.85rem;
	}
	button.primary {
		background: rgba(14, 165, 233, 0.15);
		border-color: rgba(14, 165, 233, 0.4);
	}
	button.ghost {
		opacity: 0.9;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.err {
		margin: 0;
		color: #fca5a5;
		font-size: 0.85rem;
	}
	code {
		font-size: 0.85em;
	}
</style>
