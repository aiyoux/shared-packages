<script lang="ts">
	/**
	 * The "Connections" tab of the settings popup: B2 and monitor
	 * list/new/edit, moved verbatim out of RemoteConnectionsDialog. Escape
	 * and the remove-confirmation belong to this tab because the form state
	 * does; the dialog shell renders the tab bar around it.
	 */
	import { onMount } from 'svelte';
	import '@shared-packages/design-system/segmented.css';
	import { toast } from '@shared-packages/ui';
	import {
		HUB_B2_PROFILES_CHANNEL,
		HUB_MONITOR_PROFILES_CHANNEL,
		subscribeTabChannel
	} from '../crossTab.js';
	import {
		createB2Connection,
		deleteB2Connection,
		listB2Connections,
		setActiveB2RowId,
		updateB2Connection
	} from '../b2/connections.js';
	import { validateB2Input, type B2ConnectionRow } from '../b2/types.js';
	import {
		deleteProfile as deleteMonitor,
		listProfiles as listMonitor,
		saveProfile as saveMonitor
	} from '../monitor/credentials.js';
	import {
		DEFAULT_MONITOR_BASE_URL,
		validateMonitorProfileInput,
		type MonitorConnectionProfileV1
	} from '../monitor/types.js';
	import ConnectionProfileList, { type ConnectionListRow } from './ConnectionProfileList.svelte';
	import { formatExplorerError } from './explorerError.js';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import type { FeConfirmCopy } from './feConfirm.js';
	import type { RemoteKind } from './componentTypes.js';

	type Row = {
		kind: RemoteKind;
		/** Monitor profile id, or a B2 row id (`${monitorId}.${connectionId}`). */
		id: string;
		name: string;
		/** B2 rows: which monitor holds the key. */
		via?: string;
	};

	interface Props {
		/** Close the popup (the tab's Escape path when the list is showing). */
		onClose: () => void;
		onConnected?: (kind: RemoteKind, profile: object) => void;
		/** A row was removed; the host detaches whatever shows that id. */
		onDisconnected?: (kind: RemoteKind, id: string) => void;
	}

	let { onClose, onConnected, onDisconnected }: Props = $props();

	let mode = $state<'list' | 'new' | 'edit'>('list');
	let kind = $state<RemoteKind>('b2');
	let editingId = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);

	let b2Rows = $state<B2ConnectionRow[]>([]);
	/** Monitors that could not list their B2 connections (offline / CORS). */
	let b2Unreachable = $state<string[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);

	let name = $state('');
	let b2MonitorId = $state('');
	let keyId = $state('');
	let key = $state('');
	let bucket = $state('');
	let namePrefix = $state('');
	let monitorBaseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let monitorRoot = $state('/tmp');

	const KIND_LABEL: Record<RemoteKind, string> = {
		b2: 'B2',
		monitor: 'Monitor'
	};

	const rows = $derived<Row[]>([
		...b2Rows.map((r) => ({
			kind: 'b2' as const,
			id: r.rowId,
			name: r.name,
			via: r.monitorName
		})),
		...monitorProfiles.map((p) => ({
			kind: 'monitor' as const,
			id: p.id,
			name: p.name
		}))
	]);

	const listRows = $derived<ConnectionListRow[]>(
		rows.map((p) => ({
			key: `${p.kind}:${p.id}`,
			label: `${KIND_LABEL[p.kind]} · ${p.name}`,
			openTestId: `${p.kind}-profile-edit`,
			removeTestId: `${p.kind}-profile-delete`,
			...(p.via
				? { note: `via ${p.via}`, noteTitle: `The key is held by the monitor “${p.via}”.` }
				: {})
		}))
	);

	function rowByKey(key: string): Row | undefined {
		return rows.find((p) => `${p.kind}:${p.id}` === key);
	}

	const submitLabel = $derived(mode === 'edit' ? 'Update' : 'Add');
	const formTitle = $derived(
		mode === 'edit' ? `Edit ${KIND_LABEL[kind]}` : `New ${KIND_LABEL[kind]}`
	);
	const submitTestid = $derived(`${kind}-save-only`);

	let removePrompt = $state<{ kind: RemoteKind; id: string; name: string; via?: string } | null>(
		null
	);
	const removeCopy = $derived.by((): FeConfirmCopy => {
		const name = removePrompt?.name ?? 'this connection';
		return {
			title: 'Remove connection',
			confirmLabel: 'Remove',
			body: removePrompt?.via
				? `Remove “${name}” from the monitor “${removePrompt.via}”? Every device that uses that monitor loses this connection. Files in the bucket are not touched.`
				: `Remove “${name}” from this browser? This does not delete files on the remote.`
		};
	});

	async function reload() {
		const [b2, mon] = await Promise.all([listB2Connections(), listMonitor()]);
		b2Rows = b2.rows;
		b2Unreachable = b2.unreachable.map((u) => u.monitorName);
		monitorProfiles = mon;
	}

	$effect(() => {
		void reload();
		const offs = [
			subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, () => void reload()),
			subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => void reload())
		];
		return () => offs.forEach((fn) => fn());
	});

	function resetKindDefaults(next: RemoteKind) {
		kind = next;
		name = next === 'b2' ? 'My B2' : 'Local monitor';
		b2MonitorId = monitorProfiles[0]?.id ?? '';
		keyId = '';
		key = '';
		bucket = '';
		namePrefix = '';
		monitorBaseUrl = DEFAULT_MONITOR_BASE_URL;
		monitorRoot = '/tmp';
		error = '';
	}

	function startNew() {
		editingId = null;
		resetKindDefaults('b2');
		mode = 'new';
	}

	function setNewKind(next: RemoteKind) {
		if (mode !== 'new') return;
		resetKindDefaults(next);
	}

	function startEdit(row: Row) {
		kind = row.kind;
		editingId = row.id;
		error = '';
		if (row.kind === 'b2') {
			const r = b2Rows.find((x) => x.rowId === row.id);
			if (!r) return;
			name = r.name;
			b2MonitorId = r.monitorProfileId;
			keyId = r.keyId;
			key = ''; // write-only: the monitor never sends it back
			bucket = r.bucket;
			namePrefix = r.namePrefix;
		} else {
			const p = monitorProfiles.find((x) => x.id === row.id);
			if (!p) return;
			name = p.name;
			monitorBaseUrl = p.baseUrl || DEFAULT_MONITOR_BASE_URL;
			monitorRoot = p.rootPath;
		}
		mode = 'edit';
	}

	function cancelForm() {
		error = '';
		editingId = null;
		mode = 'list';
	}

	async function save() {
		error = '';
		if (kind === 'b2') {
			const input = { name, keyId, key, bucket, namePrefix };
			const err = validateB2Input(input, { requireKey: !editingId });
			if (err) {
				error = err;
				return;
			}
			if (!editingId && !b2MonitorId) {
				error = 'B2 runs through a monitor. Add a monitor connection first.';
				return;
			}
			busy = true;
			try {
				// The monitor authorizes the key before storing it, so a bad key
				// or bucket fails here rather than at first browse.
				if (editingId) await updateB2Connection(editingId, input);
				else await createB2Connection(b2MonitorId, input);
				key = '';
				editingId = null;
				mode = 'list';
				await reload();
			} catch (e) {
				error = formatExplorerError(e);
				toast.error(error);
			} finally {
				busy = false;
			}
			return;
		}
		const err = validateMonitorProfileInput({
			name,
			baseUrl: monitorBaseUrl,
			rootPath: monitorRoot
		});
		if (err) {
			error = err;
			return;
		}
		busy = true;
		try {
			await saveMonitor({
				id: editingId ?? crypto.randomUUID(),
				name,
				baseUrl: monitorBaseUrl.trim() || DEFAULT_MONITOR_BASE_URL,
				rootPath: monitorRoot
			});
			editingId = null;
			mode = 'list';
			await reload();
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	async function connectRow(row: Row) {
		error = '';
		busy = true;
		try {
			if (row.kind === 'b2') {
				const r = b2Rows.find((x) => x.rowId === row.id);
				if (!r) return;
				setActiveB2RowId(r.rowId);
				onConnected?.(row.kind, r);
			} else {
				const p = monitorProfiles.find((x) => x.id === row.id);
				if (!p) return;
				onConnected?.(row.kind, p);
			}
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
		} finally {
			busy = false;
		}
	}

	async function removeRow(row: { kind: RemoteKind; id: string }) {
		try {
			if (row.kind === 'b2') await deleteB2Connection(row.id);
			else await deleteMonitor(row.id);
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
			return;
		}
		if (editingId === row.id && kind === row.kind) {
			editingId = null;
			mode = 'list';
		}
		await reload();
		onDisconnected?.(row.kind, row.id);
	}

	const connectTid = (k: RemoteKind) =>
		k === 'monitor' ? 'monitor-connect-profile' : `${k}-profile-select`;

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			if (removePrompt) {
				removePrompt = null;
				return;
			}
			if (mode === 'list') onClose();
			else cancelForm();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="tab-body">
	{#if error}
		<div class="err" data-testid="{kind}-form-error" role="alert">{error}</div>
	{/if}

	{#if mode === 'list'}
		<div class="saved" data-testid="connections-saved-profiles">
			{#if rows.length}
				<div data-testid="connections-profile-list">
					<ConnectionProfileList
						rows={listRows}
						{busy}
						onOpen={(key) => {
							const row = rowByKey(key);
							if (row) startEdit(row);
						}}
						onRemove={(key) => {
							const row = rowByKey(key);
							if (row)
								removePrompt = { kind: row.kind, id: row.id, name: row.name, via: row.via };
						}}
					/>
				</div>
			{:else}
				<p class="empty" data-testid="connections-empty">No saved connections.</p>
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="connections-profile-new"
				disabled={busy}
				onclick={startNew}
			>
				New connection
			</button>
		</div>
		{#if b2Unreachable.length}
			<p class="empty" data-testid="connections-b2-unreachable">
				Could not list B2 connections on {b2Unreachable.join(', ')}.
			</p>
		{/if}
	{:else}
		{#if mode === 'new'}
			<div
				class="ds-seg kind-seg"
				role="radiogroup"
				aria-label="Connection type"
				data-testid="connections-kind"
			>
				<button
					type="button"
					role="radio"
					class:active={kind === 'b2'}
					aria-checked={kind === 'b2'}
					data-testid="connections-kind-b2"
					disabled={busy}
					onclick={() => setNewKind('b2')}>B2</button
				>
				<button
					type="button"
					role="radio"
					class:active={kind === 'monitor'}
					aria-checked={kind === 'monitor'}
					data-testid="connections-kind-monitor"
					disabled={busy}
					onclick={() => setNewKind('monitor')}>Monitor</button
				>
			</div>
		{/if}
		<div class="fields">
			{#if kind === 'b2'}
				{#if mode === 'edit'}
					<p class="editing-label" data-testid="b2-editing-banner">
						Leave the key blank to keep the key the monitor holds.
					</p>
				{/if}
				<label>
					Monitor
					<select
						data-testid="b2-monitor"
						bind:value={b2MonitorId}
						disabled={busy || mode === 'edit'}
					>
						{#each monitorProfiles as m (m.id)}
							<option value={m.id}>{m.name}</option>
						{/each}
					</select>
				</label>
				{#if monitorProfiles.length}
					<p class="editing-label" data-testid="b2-monitor-note">
						The key is stored on this monitor, never in the browser. Every device that uses
						the monitor can browse the bucket.
					</p>
				{:else}
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
			{:else}
				<label>
					Name
					<input type="text" bind:value={name} data-testid="monitor-name" disabled={busy} />
				</label>
				<label>
					Base URL
					<input
						type="text"
						bind:value={monitorBaseUrl}
						data-testid="monitor-base-url"
						disabled={busy}
					/>
				</label>
				<label>
					Root path (absolute)
					<input
						type="text"
						bind:value={monitorRoot}
						data-testid="monitor-root-path"
						disabled={busy}
					/>
				</label>
			{/if}
		</div>
		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="connections-cancel"
				disabled={busy}
				onclick={cancelForm}
			>
				Cancel
			</button>
			{#if mode === 'edit' && editingId}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid={connectTid(kind)}
					disabled={busy}
					onclick={() => {
						const id = editingId;
						if (!id) return;
						void connectRow({ kind, id, name });
					}}
				>
					Connect
				</button>
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid={submitTestid}
				disabled={busy}
				onclick={() => void save()}
			>
				{busy ? 'Saving…' : submitLabel}
			</button>
		</div>
	{/if}

	{#if removePrompt}
		<FeConfirmDialog
			copy={removeCopy}
			onConfirm={() => {
				const row = removePrompt;
				removePrompt = null;
				if (row) void removeRow(row);
			}}
			onCancel={() => (removePrompt = null)}
		/>
	{/if}
</div>

<style>
	.tab-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.err {
		padding: 0.5rem 0.75rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.9rem;
	}
	.saved {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.kind-seg {
		width: 100%;
	}
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	.fields input:not([type='checkbox']) {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		font: inherit;
	}
	.editing-label {
		margin: 0;
		font-size: 0.8rem;
		color: var(--accent-light);
	}
</style>