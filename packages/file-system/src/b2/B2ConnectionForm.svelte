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
	import ConnectionProfilesDialog, {
		type ConnectionFormMode,
		type ConnectionProfileRow
	} from '../ui/ConnectionProfilesDialog.svelte';

	interface Props {
		onConnected?: (profile: B2ConnectionProfileV1) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
	}

	let { onConnected, onDisconnected, onCancel }: Props = $props();

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
	let mode = $state<ConnectionFormMode>('list');

	const rows = $derived<ConnectionProfileRow[]>(
		profiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: [
				p.bucketName,
				p.namePrefix,
				p.persistSecret === false ? 'this tab' : ''
			]
				.filter(Boolean)
				.join(' · '),
			active: p.id === activeId
		}))
	);

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
		mode = 'new';
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
		mode = 'edit';
	}

	function cancelForm() {
		error = '';
		editingId = null;
		mode = 'list';
	}

	async function save() {
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
			await reload();
			editingId = null;
			applicationKey = '';
			keyDirty = false;
			mode = 'list';
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
		await deleteProfile(id);
		if (editingId === id) {
			editingId = null;
			mode = 'list';
		}
		await reload();
		if (activeId === id) {
			activeId = null;
			onDisconnected?.();
		}
	}

	function editById(id: string) {
		const p = profiles.find((x) => x.id === id);
		if (p) loadForEdit(p);
	}

	function connectById(id: string) {
		const p = profiles.find((x) => x.id === id);
		if (p) void connectProfile(p);
	}
</script>

<ConnectionProfilesDialog
	title="Backblaze B2"
	testid="b2-connection-form"
	prefix="b2"
	profiles={rows}
	{mode}
	{busy}
	{error}
	hint="Keys stay only in this browser. File bytes go direct to B2. A bucket-scoped application key is required — master keys are refused."
	submitTestid="b2-save-only"
	onClose={() => onCancel?.()}
	onNew={clearFieldsForNew}
	onEdit={editById}
	onConnect={connectById}
	onRemove={(id) => void removeProfile(id)}
	onSubmit={() => void save()}
	onCancelForm={cancelForm}
>
	{#snippet extra()}
		<VaultPanel />
	{/snippet}
	{#snippet fields()}
		{#if mode === 'edit'}
			<p class="editing-label" data-testid="b2-editing-banner">
				Leave the key blank to keep the current key.
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
				placeholder={mode === 'edit' ? '(unchanged if blank)' : ''}
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
			<input data-testid="b2-persist-secret" type="checkbox" bind:checked={persistSecret} />
			Save this key in the browser
		</label>
		{#if !persistSecret}
			<p class="editing-label" data-testid="b2-session-only-note">
				This tab only — the key is forgotten when the tab closes.
			</p>
		{/if}
	{/snippet}
</ConnectionProfilesDialog>
