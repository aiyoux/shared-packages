<script lang="ts">
	/**
	 * One popup for B2, rclone, and monitor: combined list, then new/edit
	 * fields. New uses a segmented type control.
	 */
	import { onMount } from 'svelte';
	import '@shared-packages/design-system/button.css';
	import '@shared-packages/design-system/segmented.css';
	import { toast } from '@shared-packages/ui';
	import {
		HUB_B2_PROFILES_CHANNEL,
		HUB_MONITOR_PROFILES_CHANNEL,
		HUB_RCLONE_PROFILES_CHANNEL,
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
		deleteProfile as deleteRclone,
		getActiveProfileId as getActiveRclone,
		listProfiles as listRclone,
		saveProfile as saveRclone,
		setActiveProfileId as setActiveRclone
	} from '../rclone/credentials.js';
	import {
		DEFAULT_RCLONE_BASE_URL,
		validateProfileInput as validateRclone,
		type RcloneConnectionProfileV1
	} from '../rclone/types.js';
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
	import VaultPanel from '../vault/VaultPanel.svelte';
	import { formatExplorerError } from './explorerError.js';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import type { FeConfirmCopy } from './feConfirm.js';
	import { portal } from './portal.js';
	import type { RemoteKind } from './componentTypes.js';

	type Row = {
		kind: RemoteKind;
		id: string;
		name: string;
		detail: string;
		active: boolean;
	};

	interface Props {
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
	let rcloneProfiles = $state<RcloneConnectionProfileV1[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let activeB2 = $state<string | null>(null);
	let activeRclone = $state<string | null>(null);
	let activeMonitor = $state<string | null>(null);

	let name = $state('');
	let applicationKeyId = $state('');
	let applicationKey = $state('');
	let bucketName = $state('');
	let namePrefix = $state('');
	let keyDirty = $state(false);
	let persistSecret = $state(true);
	let rcBaseUrl = $state(DEFAULT_RCLONE_BASE_URL);
	let rcFs = $state('');
	let rcRoot = $state('');
	let rcUser = $state('');
	let rcPass = $state('');
	let passDirty = $state(false);
	let monitorBaseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let monitorRoot = $state('/tmp');

	const KIND_LABEL: Record<RemoteKind, string> = {
		b2: 'B2',
		rclone: 'rclone',
		monitor: 'Monitor'
	};

	const rows = $derived<Row[]>([
		...b2Profiles.map((p) => ({
			kind: 'b2' as const,
			id: p.id,
			name: p.name,
			detail: [p.bucketName, p.namePrefix, p.persistSecret === false ? 'this tab' : '']
				.filter(Boolean)
				.join(' · '),
			active: p.id === activeB2
		})),
		...monitorProfiles.map((p) => ({
			kind: 'monitor' as const,
			id: p.id,
			name: p.name,
			detail: `${p.rootPath} · ${p.baseUrl}`,
			active: p.id === activeMonitor
		})),
		...rcloneProfiles.map((p) => ({
			kind: 'rclone' as const,
			id: p.id,
			name: p.name,
			detail: [p.fs, p.rootPath, p.baseUrl, p.persistSecret === false ? 'this tab' : '']
				.filter(Boolean)
				.join(' · '),
			active: p.id === activeRclone
		}))
	]);

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
		const [b2, rc, mon, aB2, aRc, aMon] = await Promise.all([
			listB2(),
			listRclone(),
			listMonitor(),
			getActiveB2(),
			getActiveRclone(),
			getActiveMonitor()
		]);
		b2Profiles = b2;
		rcloneProfiles = rc;
		monitorProfiles = mon;
		activeB2 = aB2;
		activeRclone = aRc;
		activeMonitor = aMon;
	}

	$effect(() => {
		void reload();
		const offs = [
			subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, () => void reload()),
			subscribeTabChannel(HUB_RCLONE_PROFILES_CHANNEL, () => void reload()),
			subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => void reload())
		];
		return () => offs.forEach((fn) => fn());
	});

	function resetKindDefaults(next: RemoteKind) {
		kind = next;
		name = next === 'b2' ? 'My B2' : next === 'rclone' ? 'My rclone' : 'Local monitor';
		applicationKeyId = '';
		applicationKey = '';
		bucketName = '';
		namePrefix = '';
		keyDirty = false;
		persistSecret = true;
		rcBaseUrl = DEFAULT_RCLONE_BASE_URL;
		rcFs = '';
		rcRoot = '';
		rcUser = '';
		rcPass = '';
		passDirty = false;
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
		} else if (row.kind === 'rclone') {
			const p = rcloneProfiles.find((x) => x.id === row.id);
			if (!p) return;
			name = p.name;
			rcBaseUrl = p.baseUrl || DEFAULT_RCLONE_BASE_URL;
			rcFs = p.fs;
			rcRoot = p.rootPath ?? '';
			rcUser = p.rcUser;
			rcPass = '';
			passDirty = false;
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
		if (kind === 'rclone') {
			const existing = editingId ? rcloneProfiles.find((p) => p.id === editingId) : undefined;
			const passToSave = passDirty || !existing ? rcPass : existing.rcPass;
			const requireRcPass = !existing || passDirty;
			const err = validateRclone({
				name,
				baseUrl: rcBaseUrl,
				fs: rcFs,
				rootPath: rcRoot,
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
				await saveRclone({
					id: editingId ?? crypto.randomUUID(),
					name,
					baseUrl: rcBaseUrl.trim() || DEFAULT_RCLONE_BASE_URL,
					fs: rcFs,
					rootPath: rcRoot || undefined,
					rcUser,
					rcPass: passDirty || !existing ? passToSave : '',
					persistSecret,
					createdAt: existing?.createdAt
				});
				rcPass = '';
				passDirty = false;
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
			} else if (row.kind === 'rclone') {
				const p = rcloneProfiles.find((x) => x.id === row.id);
				if (!p) return;
				await setActiveRclone(p.id);
				activeRclone = p.id;
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
		else if (row.kind === 'rclone') await deleteRclone(row.id);
		else await deleteMonitor(row.id);
		if (editingId === row.id && kind === row.kind) {
			editingId = null;
			mode = 'list';
		}
		await reload();
		const active =
			row.kind === 'b2' ? activeB2 : row.kind === 'rclone' ? activeRclone : activeMonitor;
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

<div class="portal-root" use:portal={'body'}>
	<div
		class="modal-root"
		data-testid="connections-dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="connections-mgr-title"
	>
		<div class="scrim" onclick={onClose} role="presentation"></div>
		<div class="card">
			<header class="head">
				<h2 id="connections-mgr-title">{mode === 'list' ? 'Connections' : formTitle}</h2>
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--ghost"
					data-testid="connections-dialog-close"
					onclick={onClose}
				>
					Close
				</button>
			</header>

			{#if error}
				<div class="err" data-testid="{kind}-form-error" role="alert">{error}</div>
			{/if}

			{#if mode === 'list'}
				<div class="saved" data-testid="connections-saved-profiles">
					{#if rows.length}
						<ul data-testid="connections-profile-list">
							{#each rows as p (`${p.kind}:${p.id}`)}
								<li class:active={p.active}>
									<div class="profile-main">
										<span class="profile-name">{KIND_LABEL[p.kind]} · {p.name}</span>
										{#if p.detail}
											<span class="meta">{p.detail}</span>
										{/if}
									</div>
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--secondary"
										data-testid="{p.kind}-profile-edit"
										disabled={busy}
										onclick={() => startEdit(p)}>Edit</button
									>
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--primary"
										data-testid={connectTid(p.kind)}
										disabled={busy}
										onclick={() => void connectRow(p)}>Connect</button
									>
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--ghost danger"
										data-testid="{p.kind}-profile-delete"
										disabled={busy}
										onclick={() => (removePrompt = { kind: p.kind, id: p.id, name: p.name })}
										>Remove</button
									>
								</li>
							{/each}
						</ul>
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
							class:active={kind === 'rclone'}
							aria-checked={kind === 'rclone'}
							data-testid="connections-kind-rclone"
							disabled={busy}
							onclick={() => setNewKind('rclone')}>rclone</button
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
					{:else if kind === 'rclone'}
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
								bind:value={rcBaseUrl}
								placeholder={DEFAULT_RCLONE_BASE_URL}
								autocomplete="off"
							/>
						</label>
						<label>
							Remote (fs)
							<input
								data-testid="rclone-fs"
								bind:value={rcFs}
								placeholder="remote: or remote:bucket"
								autocomplete="off"
							/>
						</label>
						<label>
							Root path (optional)
							<input
								data-testid="rclone-root"
								bind:value={rcRoot}
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
							<input
								data-testid="rclone-persist-secret"
								type="checkbox"
								bind:checked={persistSecret}
							/>
							Save this password in the browser
						</label>
						{#if !persistSecret}
							<p class="editing-label" data-testid="rclone-session-only-note">
								This tab only — the password is forgotten when the tab closes.
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
		</div>
	</div>

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
	.portal-root {
		display: contents;
	}
	.modal-root {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(30rem, calc(100vw - 2rem));
		max-height: min(80vh, 42rem);
		overflow: auto;
		padding: 1.1rem 1.2rem 1.15rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
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
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.5rem;
		border: 1px solid var(--line-hairline);
	}
	li.active {
		border-color: var(--accent);
	}
	.profile-main {
		flex: 1 1 8rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.profile-name {
		font-weight: 650;
		font-size: 0.88rem;
	}
	.meta {
		font-size: 0.75rem;
		opacity: 0.7;
	}
	.danger {
		color: var(--cat-red-soft);
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
