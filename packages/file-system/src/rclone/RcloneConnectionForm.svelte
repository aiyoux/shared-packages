<script lang="ts">
	import {
		deleteProfile,
		getActiveProfileId,
		listProfiles,
		saveProfile,
		setActiveProfileId
	} from './credentials.js';
	import {
		DEFAULT_RCLONE_BASE_URL,
		validateProfileInput,
		type RcloneConnectionProfileV1
	} from './types.js';

	interface Props {
		/** Called after save when user wants to connect with this profile */
		onConnected?: (profile: RcloneConnectionProfileV1) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
		/** When true, "Save & connect" runs; edit-only save uses Save without connect */
		autoConnectOnSave?: boolean;
	}

	let { onConnected, onDisconnected, onCancel, autoConnectOnSave = true }: Props = $props();

	let profiles = $state<RcloneConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	/** When set, Save updates this profile instead of creating a new one */
	let editingId = $state<string | null>(null);
	let name = $state('My rclone');
	let baseUrl = $state(DEFAULT_RCLONE_BASE_URL);
	let fs = $state('');
	let rootPath = $state('');
	let rcUser = $state('');
	let rcPass = $state('');
	/** When editing, empty pass field means "keep existing secret" */
	let passDirty = $state(false);
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
		name = 'My rclone';
		baseUrl = DEFAULT_RCLONE_BASE_URL;
		fs = '';
		rootPath = '';
		rcUser = '';
		rcPass = '';
		passDirty = false;
		error = '';
	}

	function loadForEdit(p: RcloneConnectionProfileV1) {
		editingId = p.id;
		name = p.name;
		baseUrl = p.baseUrl || DEFAULT_RCLONE_BASE_URL;
		fs = p.fs;
		rootPath = p.rootPath ?? '';
		rcUser = p.rcUser;
		// Never show stored secret; leave blank to keep
		rcPass = '';
		passDirty = false;
		error = '';
	}

	async function save(connectAfter: boolean) {
		error = '';
		const existing = editingId ? profiles.find((p) => p.id === editingId) : undefined;
		const passToSave = passDirty || !existing ? rcPass : existing.rcPass;
		const requireRcPass = !existing || passDirty;

		const err = validateProfileInput({
			name,
			baseUrl,
			fs,
			rootPath,
			rcUser,
			rcPass: passToSave,
			requireRcPass
		});
		if (err) {
			error = err;
			return;
		}
		if (requireRcPass && !passToSave?.trim()) {
			error = 'RC password is required';
			return;
		}

		busy = true;
		try {
			const id = editingId ?? crypto.randomUUID();
			const profile = await saveProfile({
				id,
				name,
				baseUrl: baseUrl.trim() || DEFAULT_RCLONE_BASE_URL,
				fs,
				rootPath: rootPath || undefined,
				rcUser,
				// Blank pass on edit keeps prior secret inside saveProfile
				rcPass: passDirty || !existing ? passToSave : '',
				createdAt: existing?.createdAt
			});
			await setActiveProfileId(profile.id);
			await reload();
			editingId = profile.id;
			rcPass = '';
			passDirty = false;
			if (connectAfter && autoConnectOnSave) {
				onConnected?.(profile);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function connectProfile(p: RcloneConnectionProfileV1) {
		error = '';
		await setActiveProfileId(p.id);
		activeId = p.id;
		onConnected?.(p);
	}

	async function removeProfile(id: string) {
		if (!window.confirm('Remove this rclone connection from this browser?')) return;
		await deleteProfile(id);
		if (editingId === id) clearFieldsForNew();
		await reload();
		if (activeId === id) {
			activeId = null;
			onDisconnected?.();
		}
	}
</script>

<div class="rclone-form" data-testid="rclone-connection-form">
	<h3>rclone RC connection</h3>
	<p class="hint">
		RC credentials stay only in this browser (IndexedDB). The browser talks
		<strong>directly</strong> to the Base URL you set (local rcd, SSH tunnel, etc.;
		default <code>http://127.0.0.1:7750</code>). rcd must allow CORS for this site.
		Use the remote name from your <code>rclone.conf</code> as <strong>fs</strong>
		(e.g. <code>remote:</code>).
	</p>

	{#if error}
		<div class="err" data-testid="rclone-form-error" role="alert">{error}</div>
	{/if}

	{#if profiles.length}
		<div class="saved" data-testid="rclone-saved-profiles">
			<h4>Saved connections</h4>
			<ul>
				{#each profiles as p (p.id)}
					<li class:active={p.id === activeId} class:editing={p.id === editingId}>
						<div class="profile-main">
							<span class="profile-name">{p.name}</span>
							<span class="meta"
								>{p.fs}{p.rootPath ? ` · ${p.rootPath}` : ''} · {p.baseUrl}</span
							>
						</div>
						<button
							type="button"
							data-testid="rclone-profile-edit"
							onclick={() => loadForEdit(p)}>Edit</button
						>
						<button
							type="button"
							data-testid="rclone-profile-select"
							onclick={() => connectProfile(p)}>Connect</button
						>
						<button
							type="button"
							class="danger"
							data-testid="rclone-profile-delete"
							onclick={() => removeProfile(p.id)}>Remove</button
						>
					</li>
				{/each}
			</ul>
			<button
				type="button"
				class="ghost"
				data-testid="rclone-profile-new"
				onclick={clearFieldsForNew}
			>
				+ New connection
			</button>
		</div>
	{/if}

	<div class="fields">
		{#if editingId}
			<p class="editing-label" data-testid="rclone-editing-banner">
				Editing saved connection — leave password blank to keep the current secret.
			</p>
		{/if}
		<label>
			Display name
			<input data-testid="rclone-name" bind:value={name} autocomplete="off" />
		</label>
		<label>
			RC base URL
			<input
				data-testid="rclone-base-url"
				bind:value={baseUrl}
				placeholder={DEFAULT_RCLONE_BASE_URL}
				autocomplete="off"
			/>
		</label>
		<label>
			Remote (fs)
			<input
				data-testid="rclone-fs"
				bind:value={fs}
				placeholder="remote: or remote:bucket"
				autocomplete="off"
			/>
		</label>
		<label>
			Root path (optional)
			<input
				data-testid="rclone-root"
				bind:value={rootPath}
				placeholder="team/docs"
				autocomplete="off"
			/>
		</label>
		<label>
			RC user
			<input data-testid="rclone-user" bind:value={rcUser} autocomplete="off" />
		</label>
		<label>
			RC password
			<input
				data-testid="rclone-pass"
				type="password"
				bind:value={rcPass}
				autocomplete="off"
				placeholder={editingId ? '(unchanged if blank)' : ''}
				oninput={() => (passDirty = true)}
			/>
		</label>
	</div>

	<div class="actions">
		<button
			type="button"
			data-testid="rclone-save-only"
			disabled={busy}
			onclick={() => save(false)}
		>
			{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save'}
		</button>
		<button
			type="button"
			data-testid="rclone-save-connect"
			disabled={busy}
			onclick={() => save(true)}
		>
			{busy ? 'Saving…' : 'Save & connect'}
		</button>
		{#if onCancel}
			<button type="button" data-testid="rclone-cancel" onclick={onCancel}>Cancel</button>
		{/if}
	</div>
</div>

<style>
	.rclone-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.5rem 0 1rem;
		max-width: 32rem;
	}
	h3 {
		margin: 0;
		font-size: 1.1rem;
	}
	.hint {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.hint code {
		font-size: 0.85em;
	}
	.err {
		padding: 0.5rem 0.75rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.9rem;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.editing-label {
		margin: 0;
		font-size: 0.8rem;
		color: var(--accent-light);
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	input {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: inherit;
		font: inherit;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button {
		padding: 0.4rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-strong);
		background: var(--surface-2);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}
	button:disabled {
		opacity: 0.6;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--cat-red-soft);
		background: rgb(var(--danger-rgb) / 0.12);
	}
	button.ghost {
		background: transparent;
		align-self: flex-start;
	}
	.saved ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.saved li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--line-hairline);
	}
	.saved li.editing {
		outline: 1px dashed var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}
	.profile-main {
		flex: 1 1 8rem;
		min-width: 0;
	}
	.profile-name {
		display: block;
		font-weight: 600;
	}
	.meta {
		display: block;
		font-size: 0.75rem;
		opacity: 0.7;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
</style>
