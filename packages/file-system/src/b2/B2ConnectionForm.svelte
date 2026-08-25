<script lang="ts">
	import {
		deleteProfile,
		getActiveProfileId,
		listProfiles,
		saveProfile,
		setActiveProfileId
	} from './credentials.js';
	import { HUB_B2_PROFILES_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import { validateProfileInput, type B2ConnectionProfileV1 } from './types.js';
	import { toast } from '@shared-packages/ui';
	import { formatExplorerError } from '../ui/explorerError.js';
	import VaultPanel from '../vault/VaultPanel.svelte';

	interface Props {
		/** Called after save when user wants to connect with this profile */
		onConnected?: (profile: B2ConnectionProfileV1) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
		/** When true, "Save & connect" runs; edit-only save uses Save without connect */
		autoConnectOnSave?: boolean;
	}

	let { onConnected, onDisconnected, onCancel, autoConnectOnSave = true }: Props = $props();

	let profiles = $state<B2ConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	/** When set, Save updates this profile instead of creating a new one */
	let editingId = $state<string | null>(null);
	let name = $state('My B2');
	let applicationKeyId = $state('');
	let applicationKey = $state('');
	let bucketName = $state('');
	let namePrefix = $state('');
	/** When editing, empty key field means "keep existing secret" */
	let keyDirty = $state(false);
	/** Default: persist in IndexedDB. Unchecked = this tab only. */
	let persistSecret = $state(true);
	let error = $state('');
	let busy = $state(false);

	async function reload() {
		profiles = await listProfiles();
		activeId = await getActiveProfileId();
	}

	$effect(() => {
		void reload();
		return subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, () => {
			void reload();
		});
	});

	function clearFieldsForNew() {
		editingId = null;
		name = 'My B2';
		applicationKeyId = '';
		applicationKey = '';
		bucketName = '';
		namePrefix = '';
		keyDirty = false;
		persistSecret = true;
		error = '';
	}

	function loadForEdit(p: B2ConnectionProfileV1) {
		editingId = p.id;
		name = p.name;
		applicationKeyId = p.applicationKeyId;
		applicationKey = ''; // never show stored secret; leave blank to keep
		keyDirty = false;
		bucketName = p.bucketName;
		namePrefix = p.namePrefix ?? '';
		persistSecret = p.persistSecret !== false;
		error = '';
	}

	async function save(connectAfter: boolean) {
		error = '';
		const existing = editingId ? profiles.find((p) => p.id === editingId) : undefined;
		const keyToSave =
			keyDirty || !existing ? applicationKey : existing.applicationKey;

		const requireApplicationKey = !existing || keyDirty;
		const err = validateProfileInput({
			name,
			applicationKeyId,
			applicationKey: keyToSave,
			bucketName,
			namePrefix,
			requireApplicationKey
		});
		if (err) {
			error = err;
			return;
		}
		if (!keyToSave?.trim()) {
			error = 'Application key is required';
			return;
		}

		busy = true;
		try {
			const id = editingId ?? crypto.randomUUID();
			const profile = await saveProfile({
				id,
				name,
				applicationKeyId,
				applicationKey: requireApplicationKey ? keyToSave : '',
				bucketName,
				namePrefix: namePrefix || undefined,
				persistSecret,
				createdAt: existing?.createdAt
			});
			await setActiveProfileId(profile.id);
			await reload();
			editingId = profile.id;
			applicationKey = '';
			keyDirty = false;
			if (connectAfter && autoConnectOnSave) {
				onConnected?.(profile);
			}
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	async function connectProfile(p: B2ConnectionProfileV1) {
		error = '';
		await setActiveProfileId(p.id);
		activeId = p.id;
		onConnected?.(p);
	}

	async function removeProfile(id: string) {
		if (!window.confirm('Remove this B2 connection from this browser?')) return;
		await deleteProfile(id);
		if (editingId === id) clearFieldsForNew();
		await reload();
		if (activeId === id) {
			activeId = null;
			onDisconnected?.();
		}
	}
</script>

<div class="b2-form" data-testid="b2-connection-form">
	<h3>Backblaze B2 connection</h3>
	<p class="hint">
		Keys stay only in this browser. Control-plane calls go through this hub; file bytes
		upload/download direct to B2. A <strong>bucket-scoped application key</strong> is required —
		master keys are refused.
	</p>
	<VaultPanel />

	{#if error}
		<div class="err" data-testid="b2-form-error" role="alert">{error}</div>
	{/if}

	{#if profiles.length}
		<div class="saved" data-testid="b2-saved-profiles">
			<h4>Saved connections</h4>
			<ul>
				{#each profiles as p (p.id)}
					<li class:active={p.id === activeId} class:editing={p.id === editingId}>
						<div class="profile-main">
							<span class="profile-name">{p.name}</span>
							<span class="meta"
								>{p.bucketName}{p.namePrefix ? ` · ${p.namePrefix}` : ''}{p.persistSecret ===
								false
									? ' · this tab'
									: ''}</span
							>
						</div>
						<button
							type="button"
							data-testid="b2-profile-edit"
							onclick={() => loadForEdit(p)}>Edit</button
						>
						<button
							type="button"
							data-testid="b2-profile-select"
							onclick={() => connectProfile(p)}>Connect</button
						>
						<button
							type="button"
							class="danger"
							data-testid="b2-profile-delete"
							onclick={() => removeProfile(p.id)}>Remove</button
						>
					</li>
				{/each}
			</ul>
			<button type="button" class="ghost" data-testid="b2-profile-new" onclick={clearFieldsForNew}>
				+ New connection
			</button>
		</div>
	{/if}

	<div class="fields">
		{#if editingId}
			<p class="editing-label" data-testid="b2-editing-banner">
				Editing saved connection — leave key blank to keep the current key.
			</p>
		{/if}
		<label>
			Display name
			<input data-testid="b2-name" bind:value={name} autocomplete="off" />
		</label>
		<label>
			Application key ID
			<input data-testid="b2-key-id" bind:value={applicationKeyId} autocomplete="off" />
		</label>
		<label>
			Application key
			<input
				data-testid="b2-key"
				type="password"
				bind:value={applicationKey}
				autocomplete="off"
				placeholder={editingId ? '(unchanged if blank)' : ''}
				oninput={() => (keyDirty = true)}
			/>
		</label>
		<label>
			Bucket name
			<input data-testid="b2-bucket" bind:value={bucketName} autocomplete="off" />
		</label>
		<label>
			Name prefix (optional)
			<input
				data-testid="b2-prefix"
				bind:value={namePrefix}
				placeholder="team/docs/"
				autocomplete="off"
			/>
		</label>
		<label class="check">
			<input
				data-testid="b2-persist-secret"
				type="checkbox"
				bind:checked={persistSecret}
			/>
			Save this key in the browser
		</label>
		{#if !persistSecret}
			<p class="editing-label" data-testid="b2-session-only-note">
				This tab only — the key is forgotten when the tab closes.
			</p>
		{/if}
	</div>

	<div class="actions">
		<button
			type="button"
			data-testid="b2-save-only"
			disabled={busy}
			onclick={() => save(false)}
		>
			{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save'}
		</button>
		<button
			type="button"
			data-testid="b2-save-connect"
			disabled={busy}
			onclick={() => save(true)}
		>
			{busy ? 'Saving…' : editingId ? 'Save & connect' : 'Save & connect'}
		</button>
		{#if onCancel}
			<button type="button" data-testid="b2-cancel" onclick={onCancel}>Cancel</button>
		{/if}
	</div>
</div>

<style>
	.b2-form {
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
	label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
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
	}
	h4 {
		margin: 0 0 0.35rem;
		font-size: 0.9rem;
	}
</style>
