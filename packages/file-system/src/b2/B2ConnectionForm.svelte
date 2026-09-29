<script lang="ts">
	import { HUB_B2_PROFILES_CHANNEL, HUB_MONITOR_PROFILES_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import { listProfiles as listMonitors } from '../monitor/credentials.js';
	import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
	import {
		createB2Connection,
		deleteB2Connection,
		getActiveB2RowId,
		listB2Connections,
		setActiveB2RowId,
		updateB2Connection
	} from './connections.js';
	import { validateB2Input, type B2ConnectionRow } from './types.js';
	import { toast } from '@shared-packages/ui';
	import { formatExplorerError } from '../ui/explorerError.js';
	import ConnectionProfilesDialog, {
		type ConnectionFormMode,
		type ConnectionProfileRow
	} from '../ui/ConnectionProfilesDialog.svelte';

	interface Props {
		onConnected?: (row: B2ConnectionRow) => void;
		onDisconnected?: () => void;
		onCancel?: () => void;
	}

	let { onConnected, onDisconnected, onCancel }: Props = $props();

	let rows = $state<B2ConnectionRow[]>([]);
	let monitors = $state<MonitorConnectionProfileV1[]>([]);
	let activeId = $state<string | null>(null);
	/** Row id being edited; null while creating. */
	let editingId = $state<string | null>(null);
	let monitorId = $state('');
	let name = $state('My B2');
	let keyId = $state('');
	let key = $state('');
	let bucket = $state('');
	let namePrefix = $state('');
	let error = $state('');
	let busy = $state(false);
	let mode = $state<ConnectionFormMode>('list');

	const listRows = $derived<ConnectionProfileRow[]>(
		rows.map((r) => ({
			id: r.rowId,
			name: r.name,
			detail: [r.bucket, r.namePrefix, `via ${r.monitorName}`].filter(Boolean).join(' · '),
			active: r.rowId === activeId
		}))
	);

	async function reload() {
		const [listing, mons] = await Promise.all([listB2Connections(), listMonitors()]);
		rows = listing.rows;
		monitors = mons;
		activeId = getActiveB2RowId();
	}

	$effect(() => {
		void reload();
		const offs = [
			subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, () => void reload()),
			subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => void reload())
		];
		return () => offs.forEach((off) => off());
	});

	function clearFieldsForNew() {
		editingId = null;
		monitorId = monitors[0]?.id ?? '';
		name = 'My B2';
		keyId = '';
		key = '';
		bucket = '';
		namePrefix = '';
		error = '';
		mode = 'new';
	}

	function loadForEdit(r: B2ConnectionRow) {
		editingId = r.rowId;
		monitorId = r.monitorProfileId;
		name = r.name;
		keyId = r.keyId;
		key = ''; // write-only: the monitor never sends it back
		bucket = r.bucket;
		namePrefix = r.namePrefix;
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
		const input = { name, keyId, key, bucket, namePrefix };
		const err = validateB2Input(input, { requireKey: !editingId });
		if (err) {
			error = err;
			return;
		}
		if (!editingId && !monitorId) {
			error = 'Choose the monitor that will hold this key';
			return;
		}
		busy = true;
		try {
			if (editingId) await updateB2Connection(editingId, input);
			else await createB2Connection(monitorId, input);
			await reload();
			editingId = null;
			key = '';
			mode = 'list';
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	function connectById(id: string) {
		const r = rows.find((x) => x.rowId === id);
		if (!r) return;
		error = '';
		setActiveB2RowId(r.rowId);
		activeId = r.rowId;
		onConnected?.(r);
	}

	async function removeById(id: string) {
		try {
			await deleteB2Connection(id);
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
			return;
		}
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
		const r = rows.find((x) => x.rowId === id);
		if (r) loadForEdit(r);
	}
</script>

<ConnectionProfilesDialog
	title="Backblaze B2"
	testid="b2-connection-form"
	prefix="b2"
	profiles={listRows}
	{mode}
	{busy}
	{error}
	hint="The key is stored on the monitor you choose, never in this browser. Every device that can use that monitor can browse this bucket. A bucket-scoped application key is required — master keys are refused."
	submitTestid="b2-save-only"
	onClose={() => onCancel?.()}
	onNew={clearFieldsForNew}
	editingId={editingId}
	onEdit={editById}
	onConnect={connectById}
	onRemove={(id) => void removeById(id)}
	onSubmit={() => void save()}
	onCancelForm={cancelForm}
>
	{#snippet fields()}
		{#if mode === 'edit'}
			<p class="editing-label" data-testid="b2-editing-banner">
				Leave the key blank to keep the key the monitor holds.
			</p>
		{/if}
		<label>
			Monitor
			<select data-testid="b2-monitor" bind:value={monitorId} disabled={mode === 'edit'}>
				{#each monitors as m (m.id)}
					<option value={m.id}>{m.name}</option>
				{/each}
			</select>
		</label>
		{#if !monitors.length}
			<p class="editing-label" data-testid="b2-needs-monitor">
				B2 runs through a monitor. Add a monitor connection first.
			</p>
		{/if}
		<label>
			Display name
			<input data-testid="b2-name" bind:value={name} autocomplete="off" />
		</label>
		<label>
			Application key ID
			<input data-testid="b2-key-id" bind:value={keyId} autocomplete="off" />
		</label>
		<label>
			Application key
			<input
				data-testid="b2-key"
				type="password"
				bind:value={key}
				autocomplete="off"
				placeholder={mode === 'edit' ? '(unchanged if blank)' : ''}
			/>
		</label>
		<label>
			Bucket name
			<input data-testid="b2-bucket" bind:value={bucket} autocomplete="off" />
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
	{/snippet}
</ConnectionProfilesDialog>
