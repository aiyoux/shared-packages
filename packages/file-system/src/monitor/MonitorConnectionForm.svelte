<script lang="ts">
	import {
		deleteProfile,
		getActiveProfileId,
		listProfiles,
		saveProfile,
		setActiveProfileId
	} from './credentials.js';
	import { HUB_MONITOR_PROFILES_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import {
		DEFAULT_MONITOR_BASE_URL,
		validateMonitorProfileInput,
		type MonitorConnectionProfileV1
	} from './types.js';
	import { toast } from '@shared-packages/ui';
	import { formatExplorerError } from '../ui/explorerError.js';
	import ConnectionProfilesDialog, {
		type ConnectionFormMode,
		type ConnectionProfileRow
	} from '../ui/ConnectionProfilesDialog.svelte';

	interface Props {
		onConnected?: (profile: MonitorConnectionProfileV1) => void | Promise<void>;
		onDisconnected?: () => void;
		onCancel?: () => void;
	}

	let { onConnected, onDisconnected, onCancel }: Props = $props();

	let profiles = $state<MonitorConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let name = $state('Local monitor');
	let baseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let rootPath = $state('/tmp');
	let error = $state('');
	let busy = $state(false);
	let mode = $state<ConnectionFormMode>('list');

	const rows = $derived<ConnectionProfileRow[]>(
		profiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: `${p.rootPath} · ${p.baseUrl}`,
			active: p.id === activeId
		}))
	);

	async function reload() {
		profiles = await listProfiles();
		activeId = await getActiveProfileId();
	}

	$effect(() => {
		void reload();
		return subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => {
			void reload();
		});
	});

	function clearFieldsForNew() {
		editingId = null;
		name = 'Local monitor';
		baseUrl = DEFAULT_MONITOR_BASE_URL;
		rootPath = '/tmp';
		error = '';
		mode = 'new';
	}

	function loadForEdit(p: MonitorConnectionProfileV1) {
		editingId = p.id;
		name = p.name;
		baseUrl = p.baseUrl || DEFAULT_MONITOR_BASE_URL;
		rootPath = p.rootPath;
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
		const err = validateMonitorProfileInput({ name, baseUrl, rootPath });
		if (err) {
			error = err;
			return;
		}
		busy = true;
		try {
			const id = editingId ?? crypto.randomUUID();
			await saveProfile({
				id,
				name,
				baseUrl: baseUrl.trim() || DEFAULT_MONITOR_BASE_URL,
				rootPath
			});
			await reload();
			editingId = null;
			mode = 'list';
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	async function removeProfile(id: string) {
		busy = true;
		try {
			await deleteProfile(id);
			if (activeId === id) onDisconnected?.();
			if (editingId === id) {
				editingId = null;
				mode = 'list';
			}
			await reload();
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	async function connectExisting(p: MonitorConnectionProfileV1) {
		busy = true;
		error = '';
		try {
			await setActiveProfileId(p.id);
			activeId = p.id;
			await onConnected?.(p);
			onCancel?.();
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	function editById(id: string) {
		const p = profiles.find((x) => x.id === id);
		if (p) loadForEdit(p);
	}

	function connectById(id: string) {
		const p = profiles.find((x) => x.id === id);
		if (p) void connectExisting(p);
	}
</script>

<ConnectionProfilesDialog
	title="Monitor"
	testid="monitor-connection-form"
	prefix="monitor"
	profiles={rows}
	{mode}
	{busy}
	{error}
	hint="Browse a directory via the monitor service (/v1/fs). The browser talks to the Base URL you set. Default http://127.0.0.1:8300. Monitor must allow CORS for this site."
	submitTestid="monitor-save-only"
	connectTestid="monitor-connect-profile"
	onClose={() => onCancel?.()}
	onNew={clearFieldsForNew}
	onEdit={editById}
	onConnect={connectById}
	onRemove={(id) => void removeProfile(id)}
	onSubmit={() => void save()}
	onCancelForm={cancelForm}
>
	{#snippet fields()}
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
	{/snippet}
</ConnectionProfilesDialog>
