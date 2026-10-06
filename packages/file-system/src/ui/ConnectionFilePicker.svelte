<script lang="ts">
	/**
	 * Open-from-Files browser over every connection.
	 * The connection menu is the same one Files uses (browser library, in
	 * memory, this computer, B2, monitor). Browser files stay on the shared
	 * library so an open can save back into that node. Every other connection
	 * is read through its own driver.
	 *
	 * The tool embedding this decides what a pick means: a local pick comes
	 * from the shared library and can bind (save back in place), a memory or
	 * picked-folder file is read into the editor unbound, and a B2/monitor
	 * file is fetched through its driver.
	 */
	import { onDestroy, onMount } from 'svelte';
	import {
		HUB_B2_PROFILES_CHANNEL,
		HUB_MONITOR_PROFILES_CHANNEL,
		getMemoryVfs,
		getSharedVfs,
		subscribeTabChannel
	} from '../index.js';
	import {
		ConnectionSwitcher,
		acquireB2Driver,
		getB2Connection,
		listB2Connections,
		mapB2Error,
		releaseB2Driver,
		type B2ConnectionRow,
		type ConnectionKind
	} from '../b2/index.js';
	import {
		acquireMonitorDriver,
		formatMonitorErrorMessage,
		getProfile as getMonitorProfile,
		listProfiles as listMonitorProfiles,
		mapMonitorError,
		releaseMonitorDriver,
		type MonitorConnectionProfileV1
	} from '../monitor/index.js';
	import {
		FileExplorer,
		RemoteConnectionsDialog,
		canPickDirectory,
		createLocalExplorerDriver,
		createMemoryExplorerDriver,
		formatExplorerError,
		pickDirectory,
		createDiskExplorerDriver,
		type ExplorerDriver,
		type ExplorerOpenContext,
		type ExplorerOpenTarget,
		type RemoteKind
	} from './index.js';
	import type { FileTypeId } from '../types.js';
	import type { ConnectionOpenMany, ConnectionPick } from './connectionPickerTypes.js';

	let {
		accept,
		explorerMode = 'open',
		openLabel = 'Open',
		multiSelect = false,
		onOpen,
		onOpenMany,
		onClose,
		notice = '',
		connErrorTestId = 'fe-conn-error',
		rootClass = 'conn-file-picker'
	}: {
		accept: FileTypeId[];
		/** 'open' for open-a-file pickers; tools that came from FileExplorerDialog
		 * pass 'manage' to keep their full row actions. */
		explorerMode?: 'open' | 'manage';
		openLabel?: string;
		/** Lets queue tools take several files in one Open. */
		multiSelect?: boolean;
		onOpen: (pick: ConnectionPick) => void | Promise<void>;
		/** Batch multi-select Open; only called when set and >1 file is picked. */
		onOpenMany?: ConnectionOpenMany | undefined;
		onClose: () => void;
		/** Status line rendered above the explorer (an error from the last open). */
		notice?: string;
		connErrorTestId?: string;
		rootClass?: string;
	} = $props();

	const localDriver = createLocalExplorerDriver(getSharedVfs());
	let memoryDriver: ExplorerDriver | null = null;
	let ownedDisk: ExplorerDriver | null = null;
	let ownedRemote: { kind: 'b2' | 'monitor'; id: string } | null = null;

	let kind = $state<ConnectionKind>('local');
	let activeId = $state('local');
	let driver = $state.raw<ExplorerDriver>(localDriver);
	let explorerKey = $state(0);
	let busy = $state(false);
	let connectError = $state('');
	let settingsOpen = $state(false);
	let b2Rows = $state<B2ConnectionRow[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	let flight = 0;

	const b2Chips = $derived(
		b2Rows.map((row) => ({
			id: row.rowId,
			name: row.name,
			detail: [row.namePrefix ? `${row.bucket} · ${row.namePrefix}` : row.bucket, `via ${row.monitorName}`]
				.filter(Boolean)
				.join(' · ')
		}))
	);
	const monitorChips = $derived(
		monitorProfiles.map((profile) => ({
			id: profile.id,
			name: profile.name,
			detail: profile.rootPath
		}))
	);

	function nextFlight(): number {
		flight += 1;
		return flight;
	}

	function live(ticket: number): boolean {
		return ticket === flight;
	}

	function memoryExplorer(): ExplorerDriver {
		if (!memoryDriver) {
			memoryDriver = createMemoryExplorerDriver(getMemoryVfs(), {
				capabilitiesPatch: { supportsDownload: true, supportsUpload: true }
			});
		}
		return memoryDriver;
	}

	function releaseOwned(disk: ExplorerDriver | null, remote: { kind: 'b2' | 'monitor'; id: string } | null) {
		if (disk) disk.dispose?.();
		if (remote?.kind === 'b2') releaseB2Driver(remote.id);
		else if (remote?.kind === 'monitor') releaseMonitorDriver(remote.id);
	}

	function useDriver(
		nextKind: ConnectionKind,
		nextId: string,
		next: ExplorerDriver,
		own: 'disk' | 'b2' | 'monitor' | null
	) {
		const prevDisk = ownedDisk;
		const prevRemote = ownedRemote;
		ownedDisk = own === 'disk' ? next : null;
		ownedRemote = own === 'b2' || own === 'monitor' ? { kind: own, id: nextId } : null;
		kind = nextKind;
		activeId = nextId;
		driver = next;
		explorerKey += 1;
		connectError = '';
		releaseOwned(
			prevDisk && prevDisk !== next ? prevDisk : null,
			prevRemote && (prevRemote.kind !== ownedRemote?.kind || prevRemote.id !== ownedRemote.id)
				? prevRemote
				: null
		);
	}

	async function reloadProfiles() {
		try {
			monitorProfiles = await listMonitorProfiles();
		} catch {
			monitorProfiles = [];
		}
		try {
			b2Rows = (await listB2Connections()).rows;
		} catch {
			b2Rows = [];
		}
	}

	async function connectDisk(replace: boolean) {
		if (kind === 'disk' && ownedDisk && !replace) return;
		if (!canPickDirectory()) {
			connectError = 'This browser cannot open a computer folder. Use Chrome or Edge.';
			return;
		}
		const ticket = nextFlight();
		busy = true;
		connectError = '';
		try {
			const handle = await pickDirectory();
			if (!live(ticket)) return;
			const next = createDiskExplorerDriver(handle);
			await next.ready();
			if (!live(ticket)) {
				next.dispose?.();
				return;
			}
			useDriver('disk', 'disk', next, 'disk');
		} catch (err) {
			if (!live(ticket)) return;
			const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
			if (name === 'AbortError') return;
			connectError = err instanceof Error ? err.message : 'Could not open that folder';
		} finally {
			if (live(ticket)) busy = false;
		}
	}

	async function connectB2(row: B2ConnectionRow, ticket = nextFlight()) {
		busy = true;
		connectError = '';
		try {
			const next = await acquireB2Driver(row);
			if (!live(ticket)) {
				releaseB2Driver(row.rowId);
				return;
			}
			useDriver('b2', row.rowId, next, 'b2');
		} catch (err) {
			if (!live(ticket)) return;
			connectError = formatExplorerError(mapB2Error(err));
		} finally {
			if (live(ticket)) busy = false;
		}
	}

	async function connectMonitor(profile: MonitorConnectionProfileV1, ticket = nextFlight()) {
		busy = true;
		connectError = '';
		try {
			const next = await acquireMonitorDriver(profile);
			if (!live(ticket)) {
				releaseMonitorDriver(profile.id);
				return;
			}
			useDriver('monitor', profile.id, next, 'monitor');
		} catch (err) {
			if (!live(ticket)) return;
			connectError = formatMonitorErrorMessage(mapMonitorError(err));
		} finally {
			if (live(ticket)) busy = false;
		}
	}

	async function onSelectConnection(selection: string) {
		if (busy) return;
		if (selection === 'local') {
			nextFlight();
			busy = false;
			connectError = '';
			if (kind !== 'local') useDriver('local', 'local', localDriver, null);
			return;
		}
		if (selection === 'memory') {
			nextFlight();
			busy = false;
			connectError = '';
			if (kind !== 'memory') useDriver('memory', 'memory', memoryExplorer(), null);
			return;
		}
		if (selection === 'disk') {
			await connectDisk(kind === 'disk');
			return;
		}
		const selId = selection.startsWith('b2:')
			? selection.slice(3)
			: selection.startsWith('monitor:')
				? selection.slice(8)
				: selection;
		if ((kind === 'b2' || kind === 'monitor') && activeId === selId) return;
		const ticket = nextFlight();
		busy = true;
		connectError = '';
		try {
			const monitor = await getMonitorProfile(selId).catch(() => undefined);
			if (!live(ticket)) return;
			if (monitor) {
				await connectMonitor(monitor, ticket);
				return;
			}
			const row = await getB2Connection(selId).catch(() => undefined);
			if (!live(ticket)) return;
			if (row) {
				await connectB2(row, ticket);
				return;
			}
			await reloadProfiles();
			if (!live(ticket)) return;
			connectError = 'That connection was removed. Pick another or add one in settings.';
		} finally {
			if (live(ticket)) busy = false;
		}
	}

	function onRemoteConnected(remoteKind: RemoteKind, profile: object) {
		settingsOpen = false;
		if (remoteKind === 'b2') void connectB2(profile as B2ConnectionRow);
		else void connectMonitor(profile as MonitorConnectionProfileV1);
		void reloadProfiles();
	}

	function onRemoteDisconnected(remoteKind: RemoteKind, id: string) {
		void reloadProfiles();
		if (ownedRemote?.kind === remoteKind && ownedRemote.id === id) {
			nextFlight();
			busy = false;
			useDriver('local', 'local', localDriver, null);
		}
	}

	async function openEntry(entry: ExplorerOpenTarget, ctx?: ExplorerOpenContext) {
		await onOpen({
			kind,
			entry,
			read: () => ctx?.read() ?? Promise.reject(new Error('This location cannot read files'))
		});
	}

	/** All selected files at once, from wherever this connection stores them. */
	function openManyEntries(entries: ExplorerOpenTarget[], read: (entry: ExplorerOpenTarget) => Promise<Blob>) {
		if (!onOpenMany) return;
		void onOpenMany(entries.map((entry) => ({ kind, entry, read: () => read(entry) })));
	}

	onMount(() => {
		let alive = true;
		void reloadProfiles();
		const stop = [
			subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, () => {
				if (alive) void reloadProfiles();
			}),
			subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => {
				if (alive) void reloadProfiles();
			})
		];
		return () => {
			alive = false;
			for (const unsub of stop) unsub();
		};
	});

	onDestroy(() => {
		flight += 1;
		releaseOwned(ownedDisk, ownedRemote);
		ownedDisk = null;
		ownedRemote = null;
	});
</script>

<div class={rootClass}>
	{#if connectError}
		<p class="conn-notice" role="alert" data-testid={connErrorTestId}>{connectError}</p>
	{/if}
	{#if notice}
		<p class="conn-notice" role="alert">{notice}</p>
	{/if}
	{#key explorerKey}
		<FileExplorer
			mode={explorerMode}
			{accept}
			variant="dialog"
			{openLabel}
			hideToolbarTrash
			{multiSelect}
			{driver}
			onOpen={openEntry}
			onOpenMany={onOpenMany ? openManyEntries : undefined}
			{onClose}
		>
			{#snippet headerLeading()}
				<ConnectionSwitcher
					{activeId}
					activeKind={kind}
					capabilities={driver.capabilities}
					profiles={b2Chips}
					monitorProfiles={monitorChips}
					showMonitor
					showMemory
					showSettings
					showInfo={false}
					{busy}
					onSelect={(selection) => void onSelectConnection(selection)}
					onConfigure={() => (settingsOpen = true)}
				/>
			{/snippet}
		</FileExplorer>
	{/key}
</div>

{#if settingsOpen}
	<RemoteConnectionsDialog
		onClose={() => (settingsOpen = false)}
		onConnected={onRemoteConnected}
		onDisconnected={onRemoteDisconnected}
	/>
{/if}

<style>
	.conn-file-picker {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.conn-file-picker :global(.fe-root) {
		flex: 1 1 auto;
		min-height: 0;
		height: auto;
		max-height: none;
	}

	.conn-notice {
		margin: 0;
		padding: 8px 12px 0;
		color: var(--danger);
		font-size: 0.85rem;
	}
</style>