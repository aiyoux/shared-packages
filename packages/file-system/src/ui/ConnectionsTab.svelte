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
		deleteProfile as deleteB2,
		getActiveProfileId as getActiveB2,
		listProfiles as listB2,
		saveProfile as saveB2,
		setActiveProfileId as setActiveB2
	} from '../b2/credentials.js';
	import { validateProfileInput as validateB2, type B2ConnectionProfileV1 } from '../b2/types.js';
	import {
		deleteProfile as deleteMonitor,
		getActiveProfileId as getActiveMonitor,
		listProfiles as listMonitor,
		saveProfile as saveMonitor,
		setActiveProfileId as setActiveMonitor
	} from '../monitor/credentials.js';
	import {
		DEFAULT_MONITOR_BASE_URL,
		validateMonitorProfileInput,
		type MonitorConnectionProfileV1
	} from '../monitor/types.js';
	import ConnectionProfileList, { type ConnectionListRow } from './ConnectionProfileList.svelte';
	import VaultPanel from '../vault/VaultPanel.svelte';
	import { formatExplorerError } from './explorerError.js';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import type { FeConfirmCopy } from './feConfirm.js';
	import type { RemoteKind } from './componentTypes.js';

	type Row = {
		kind: RemoteKind;
		id: string;
		name: string;
		/** The secret lives only in this tab (not saved in the browser). */
		tabOnly?: boolean;
	};

	interface Props {
		/** Close the popup (the tab's Escape path when the list is showing). */
		onClose: () => void;
		onConnected?: (kind: RemoteKind, profile: object) => void;
		onDisconnected?: (kind: RemoteKind) => void;
	}

	let { onClose, onConnected, onDisconnected }: Props = $props();

	let mode = $state<'list' | 'new' | 'edit'>('list');
	let kind = $state<RemoteKind>('b2');
	let editingId = $state<string | null>(null);
	let error = $state('');
	let busy = $state(false);

	let b2Profiles = $state<B2ConnectionProfileV1[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let activeB2 = $state<string | null>(null);
	let activeMonitor = $state<string | null>(null);

	let name = $state('');
	let applicationKeyId = $state('');
	let applicationKey = $state('');
	let bucketName = $state('');
	let namePrefix = $state('');
	let keyDirty = $state(false);
	let persistSecret = $state(true);
	let monitorBaseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let monitorRoot = $state('/tmp');

	const KIND_LABEL: Record<RemoteKind, string> = {
		b2: 'B2',
		monitor: 'Monitor'
	};

	const rows = $derived<Row[]>([
		...b2Profiles.map((p) => ({
			kind: 'b2' as const,
			id: p.id,
			name: p.name,
			tabOnly: p.persistSecret === false
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
			// A tab-only key looks like any other row otherwise, and the
			// connection stops working in a new tab (284e4a3 dropped the cue).
			...(p.tabOnly
				? {
						note: 'key not saved',
						noteTitle: 'The key is kept in this tab only. A new tab asks for it again.'
					}
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

	let removePrompt = $state<{ kind: RemoteKind; id: string; name: string } | null>(null);
	const removeCopy = $derived.by((): FeConfirmCopy => {
		const name = removePrompt?.name ?? 'this connection';
		return {
			title: 'Remove connection',
			confirmLabel: 'Remove',
			body: `Remove “${name}” from this browser? This does not delete files on the remote.`
		};
	});

	async function reload() {
		const [b2, mon, aB2, aMon] = await Promise.all([
			listB2(),
			listMonitor(),
			getActiveB2(),
			getActiveMonitor()
		]);
		b2Profiles = b2;
		monitorProfiles = mon;
		activeB2 = aB2;
		activeMonitor = aMon;
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
		applicationKeyId = '';
		applicationKey = '';
		bucketName = '';
		namePrefix = '';
		keyDirty = false;
		persistSecret = true;
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
			const p = b2Profiles.find((x) => x.id === row.id);
			if (!p) return;
			name = p.name;
			applicationKeyId = p.applicationKeyId;
			applicationKey = '';
			keyDirty = false;
			bucketName = p.bucketName;
			namePrefix = p.namePrefix ?? '';
			persistSecret = p.persistSecret !== false;
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
			const existing = editingId ? b2Profiles.find((p) => p.id === editingId) : undefined;
			const keyToSave = keyDirty || !existing ? applicationKey : existing.applicationKey;
			const requireApplicationKey = !existing || keyDirty;
			const err = validateB2({
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
				await saveB2({
					id: editingId ?? crypto.randomUUID(),
					name,
					applicationKeyId,
					applicationKey: requireApplicationKey ? keyToSave : '',
					bucketName,
					namePrefix: namePrefix || undefined,
					persistSecret,
					createdAt: existing?.createdAt
				});
				applicationKey = '';
				keyDirty = false;
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
				const p = b2Profiles.find((x) => x.id === row.id);
				if (!p) return;
				await setActiveB2(p.id);
				activeB2 = p.id;
				onConnected?.(row.kind, p);
			} else {
				const p = monitorProfiles.find((x) => x.id === row.id);
				if (!p) return;
				await setActiveMonitor(p.id);
				activeMonitor = p.id;
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
		if (row.kind === 'b2') await deleteB2(row.id);
		else await deleteMonitor(row.id);
		if (editingId === row.id && kind === row.kind) {
			editingId = null;
			mode = 'list';
		}
		await reload();
		const active = row.kind === 'b2' ? activeB2 : activeMonitor;
		if (active === row.id) onDisconnected?.(row.kind);
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
							if (row) removePrompt = { kind: row.kind, id: row.id, name: row.name };
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
		<div class="extra"><VaultPanel /></div>
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
	.extra {
		min-width: 0;
	}
	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	.fields label.check {
		flex-direction: row;
		align-items: center;
		gap: 0.45rem;
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