<script lang="ts">
	import {
		deleteProfile,
		getActiveProfileId,
		listProfiles,
		saveProfile,
		setActiveProfileId
	} from './credentials.js';
	import { HUB_RCLONE_PROFILES_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import {
		DEFAULT_RCLONE_BASE_URL,
		validateProfileInput,
		type RcloneConnectionProfileV1
	} from './types.js';
	import { toast } from '@shared-packages/ui';
	import { formatExplorerError } from '../ui/explorerError.js';
	import VaultPanel from '../vault/VaultPanel.svelte';
	import ConnectionProfilesDialog, {
		type ConnectionFormMode,
		type ConnectionProfileRow
	} from '../ui/ConnectionProfilesDialog.svelte';

	interface Props {
		onConnected?: (profile: RcloneConnectionProfileV1) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
	}

	let { onConnected, onDisconnected, onCancel }: Props = $props();

	let profiles = $state<RcloneConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let name = $state('My rclone');
	let baseUrl = $state(DEFAULT_RCLONE_BASE_URL);
	let fs = $state('');
	let rootPath = $state('');
	let rcUser = $state('');
	let rcPass = $state('');
	let passDirty = $state(false);
	let persistSecret = $state(true);
	let error = $state('');
	let busy = $state(false);
	let mode = $state<ConnectionFormMode>('list');

	const rows = $derived<ConnectionProfileRow[]>(
		profiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: [
				p.fs,
				p.rootPath,
				p.baseUrl,
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
		return subscribeTabChannel(HUB_RCLONE_PROFILES_CHANNEL, () => {
			void reload();
		});
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
		persistSecret = true;
		error = '';
		mode = 'new';
	}

	function loadForEdit(p: RcloneConnectionProfileV1) {
		editingId = p.id;
		name = p.name;
		baseUrl = p.baseUrl || DEFAULT_RCLONE_BASE_URL;
		fs = p.fs;
		rootPath = p.rootPath ?? '';
		rcUser = p.rcUser;
		rcPass = '';
		passDirty = false;
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
			await saveProfile({
				id,
				name,
				baseUrl: baseUrl.trim() || DEFAULT_RCLONE_BASE_URL,
				fs,
				rootPath: rootPath || undefined,
				rcUser,
				rcPass: passDirty || !existing ? passToSave : '',
				persistSecret,
				createdAt: existing?.createdAt
			});
			await reload();
			editingId = null;
			rcPass = '';
			passDirty = false;
			mode = 'list';
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
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
	title="rclone"
	testid="rclone-connection-form"
	prefix="rclone"
	profiles={rows}
	{mode}
	{busy}
	{error}
	hint="RC credentials stay in this browser. The page talks directly to the Base URL (local rcd or SSH tunnel). Use the remote name from rclone.conf as fs (e.g. remote:)."
	submitTestid="rclone-save-only"
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
			<p class="editing-label" data-testid="rclone-editing-banner">
				Leave the password blank to keep the current secret.
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
				placeholder={mode === 'edit' ? '(unchanged if blank)' : ''}
				oninput={() => (passDirty = true)}
			/>
		</label>
		<label class="check">
			<input data-testid="rclone-persist-secret" type="checkbox" bind:checked={persistSecret} />
			Save this password in the browser
		</label>
		{#if !persistSecret}
			<p class="editing-label" data-testid="rclone-session-only-note">
				This tab only — the password is forgotten when the tab closes.
			</p>
		{/if}
	{/snippet}
</ConnectionProfilesDialog>
