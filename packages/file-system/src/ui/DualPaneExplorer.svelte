<script lang="ts">
	/**
	 * Dual-pane file explorer with switchable backends (local / memory / b2 /
	 * rclone / monitor) and copy-across between panes.
	 *
	 * Shared by the hub `/tools/files` page and the Connections `FileTransferPanel`
	 * so the dual-pane + remote-connection + copy-across wiring is single-sourced.
	 * Page-owned concerns are passed in as props:
	 *   - `localDriver`: the durable local-class driver (hub: SharedVFS; CM: the
	 *     CM library driver). The memory backend is the global in-memory VFS
	 *     (`getMemoryVfs`), shared app-wide so received files are accessible
	 *     everywhere.
	 *   - `onOpen`: optional open-file handler (hub opens skch/ob3d/vrec).
	 *   - `persistenceVfs`: optional VFS for the storage-persistence chip.
	 *   - `tids`: per-page testid config so each consumer keeps its existing
	 *     e2e selectors (defaults match the hub `/tools/files` page).
	 *
	 * Memory VFS is global (see memoryVfs.ts): it is NOT disposed on pagehide —
	 * received files must survive SPA navigation between /tools/files and /cm.
	 * A hard reload still empties it (the JS realm is torn down). The durable
	 * `__VFS_TEST__` hook stays page-owned; this component only owns the
	 * `__MEMORY_VFS_FILES__` (memory) and `__MONITOR_WATCH__` hooks.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { default as FileExplorer, type ExplorerContext } from './FileExplorer.svelte';
	import { default as StoragePersistenceStatus } from './StoragePersistenceStatus.svelte';
	import OpProgressPopup from './OpProgressPopup.svelte';
	import DualPhaseConfirm from './DualPhaseConfirm.svelte';
	import { stackTransferItems } from './stackProgress.js';
	import { listTransfers, subscribeTransfers, type TransferItem } from '../transferRegistry.js';
	import { type ExplorerDriver, type ExplorerEntry, type ExplorerOpenTarget } from './explorerDriver.js';
	import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
	// PaneId + DualPaneTids live in a .ts module so the ui barrel can re-export
	// them without the *.svelte named-export limitation.
	import { type PaneId, type DualPaneTids } from './dualPaneTypes.js';
	import {
		canShowCopyAcross,
		isDualPhaseCopy,
		describeCopyAcrossPath,
		copyAcross,
		CopyAcrossError,
		destParentFromDropEvent,
		idsFromExplorerDataTransfer,
		idsFromExplorerDragTarget
	} from './copyAcross.js';
	import { getMemoryVfs, type MemoryVfsService, type VfsService } from '../index.js';
	import { canPickDirectory, createDiskExplorerDriver, pickDirectory } from '../disk/index.js';
	import {
		B2ConnectionForm,
		ConnectionSwitcher,
		acquireB2Driver,
		releaseB2Driver,
		getProfile as getB2Profile,
		listProfiles as listB2Profiles,
		setActiveProfileId as setActiveB2ProfileId,
		mapB2Error,
		type B2ConnectionProfileV1,
		type ConnectionKind
	} from '../b2/index.js';
	import {
		RcloneConnectionForm,
		acquireRcloneDriver,
		releaseRcloneDriver,
		getProfile as getRcloneProfile,
		listProfiles as listRcloneProfiles,
		setActiveProfileId as setActiveRcloneProfileId,
		mapRcloneError,
		type RcloneConnectionProfileV1
	} from '../rclone/index.js';
	import {
		MonitorConnectionForm,
		acquireMonitorDriver,
		releaseMonitorDriver,
		getProfile as getMonitorProfile,
		listProfiles as listMonitorProfiles,
		setActiveProfileId as setActiveMonitorProfileId,
		mapMonitorError,
		formatMonitorErrorMessage,
		type MonitorConnectionProfileV1
	} from '../monitor/index.js';

	const defaultTids: DualPaneTids = {
		body: 'files-body',
		pane: (id) => `files-pane-${id}`,
		paneChrome: (id) => `files-pane-chrome-${id}`,
		paneLabel: (id) => `files-pane-label-${id}`,
		explorerHost: () => undefined,
		paneSub: () => undefined,
		copyAcross: (id) => `fe-copy-across-${id}`,
		copyAcrossError: 'fe-copy-across-error',
		send: (id) => `fe-send-${id}`,
		sendError: 'fe-send-error',
		dualToggle: 'fe-dual-pane-toggle',
		rcloneToggle: 'fe-rclone-feature-toggle',
		monitorToggle: 'fe-monitor-feature-toggle',
		persist: 'files-storage-persist'
	};

	type Props = {
		localDriver: ExplorerDriver;
		onOpen?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		persistenceVfs?: VfsService;
		dualPaneKey?: string;
		dualPaneDefault?: boolean;
		memoryScope?: string;
		/** Default backend for each pane on first mount. */
		leftDefault?: ConnectionKind;
		rightDefault?: ConnectionKind;
		/** Hide the dual-pane / feature toggles row (e.g. CM is always dual). */
		hideToggles?: boolean;
		/** Hide the pane labels (e.g. "Left"/"Right") in each pane chrome. */
		hidePaneLabels?: boolean;
		/** Hide the connection/backend switcher in each pane (locks its backend). */
		hideConnectionSwitcher?: boolean;
		/** When set, only these panes show the backend switcher. */
		switcherPanes?: PaneId[];
		/** @deprecated monitor is always enabled. Kept so existing callers compile. */
		monitorEnabled?: boolean;
		/** @deprecated rclone is always enabled. Kept so existing callers compile. */
		rcloneEnabled?: boolean;
		/** Show the In memory chip in the switcher. Default true. */
		switcherShowMemory?: boolean;
		/**
		 * Fired when a FileExplorer row drag starts in a pane. CM uses this to
		 * download-then-send from B2/monitor as well as local/memory VFS.
		 */
		onExplorerDrag?: (args: {
			paneId: PaneId;
			driver: ExplorerDriver;
			selectedIds: string[];
			entries: ExplorerEntry[];
		}) => void;
		/** Guest peer-filesystem on the right pane (Connections share tab). */
		overrideRight?: { driver: ExplorerDriver; label: string } | null;
		/** In-progress transfer rows for each pane's explorer listing. */
		pendingLeft?: Array<{
			id: string;
			name: string;
			transferred: number;
			size: number;
			direction?: string;
			ready?: number;
		}>;
		pendingRight?: Array<{
			id: string;
			name: string;
			transferred: number;
			size: number;
			direction?: string;
			ready?: number;
		}>;
		/** Notified when dual-pane toggles (so a page can widen its shell). */
		onDualChange?: (dual: boolean) => void;
		/**
		 * When provided, renders a "Send" button next to Copy across on each
		 * pane, enabled once that pane has a selection — e.g. CM sending
		 * selected files to the connected peer. Omit to hide the button
		 * entirely (the default; unrelated to copy-across compatibility).
		 */
		onSend?: (args: {
			paneId: PaneId;
			driver: ExplorerDriver;
			selectedIds: string[];
			entries: ExplorerEntry[];
		}) => void | Promise<void>;
		tids?: Partial<DualPaneTids>;
	};

	let {
		localDriver,
		onOpen,
		persistenceVfs,
		dualPaneKey = 'fe:dualPane',
		dualPaneDefault = false,
		memoryScope = 'files',
		leftDefault = 'local',
		rightDefault = 'local',
		hideToggles = false,
		hidePaneLabels = false,
		hideConnectionSwitcher = false,
		switcherPanes,
		monitorEnabled: _monitorEnabled = true,
		rcloneEnabled: _rcloneEnabled = true,
		switcherShowMemory = true,
		onExplorerDrag,
		overrideRight = null,
		pendingLeft = [],
		pendingRight = [],
		onDualChange,
		onSend,
		tids: tidsOverride = {}
	}: Props = $props();

	const tids: DualPaneTids = { ...defaultTids, ...tidsOverride };

	type PaneState = {
		activeId: 'local' | 'memory' | string;
		activeKind: ConnectionKind;
		remoteDriver: ExplorerDriver | null;
		memoryDriver: ExplorerDriver | null;
		busy: boolean;
		error: string;
		showB2Form: boolean;
		showRcloneForm: boolean;
		showMonitorForm: boolean;
		explorerKey: number;
		/** Picked folder name when activeKind is disk. */
		diskName: string;
		/** Open folder + selection for copy-across */
		ctx: ExplorerContext;
		showTrash: boolean;
	};

	function emptyCtx(backend: string = 'local'): ExplorerContext {
		return { parentId: null, selectedIds: [], backend, entries: [] };
	}

	function emptyPane(kind: ConnectionKind): PaneState {
		return {
			activeId: kind === 'memory' ? 'memory' : 'local',
			activeKind: kind,
			remoteDriver: null,
			memoryDriver: null,
			busy: false,
			error: '',
			showB2Form: false,
			showRcloneForm: false,
			showMonitorForm: false,
			explorerKey: 0,
			diskName: '',
			ctx: emptyCtx(kind),
			showTrash: false
		};
	}

	let left = $state<PaneState>(emptyPane(leftDefault));
	let right = $state<PaneState>(emptyPane(rightDefault));
	let dualPane = $state(false);
	let b2Profiles = $state<B2ConnectionProfileV1[]>([]);
	let rcloneProfiles = $state<RcloneConnectionProfileV1[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	const showRclone = true;
	const showMonitor = true;
	/** Live watch status per pane (from monitor driver). */
	let monitorWatchStatus = $state<Record<string, string>>({});
	let watchPollTimer: ReturnType<typeof setInterval> | null = null;
	let copyBusy = $state(false);
	let copyError = $state('');
	/** Pane a FileExplorer row drag started in (cross-pane copy). */
	let crossDragFrom = $state<PaneId | null>(null);
	let crossOver = $state<PaneId | null>(null);
	let sendBusy = $state(false);
	let sendError = $state<{ pane: PaneId; message: string } | null>(null);
	/** Dest pane of the in-flight copy-across (pending rows land here). */
	let copyDestPane = $state<PaneId | null>(null);
	let copyItems = $state<TransferItem[]>([]);
	let dismissedCopyIds = $state<Set<string>>(new Set());
	let copyProgressUnsub: (() => void) | null = null;
	let memoryVfs: MemoryVfsService | null = null;
	let dualPhasePrompt = $state<{
		sourceLabel: string;
		destLabel: string;
		resolve: (ok: boolean) => void;
	} | null>(null);

	/** True when at least one visible pane is durable local browser storage. */
	const showLocalPersist = $derived(
		(left.activeKind === 'local' || (dualPane && right.activeKind === 'local')) &&
			!!persistenceVfs
	);

	function getMemoryDriver(): ExplorerDriver {
		if (!memoryVfs) memoryVfs = getMemoryVfs();
		return createMemoryExplorerDriver(memoryVfs, {
			capabilitiesPatch: {
				supportsDownload: true,
				supportsUpload: false
			}
		});
	}

	function installMemoryFilesHook(mem: MemoryVfsService): void {
		const hook = {
			vfs: mem,
			scope: memoryScope,
			list: (parentId: string | null) => mem.list({ parentId }),
			get: (id: string) => mem.get(id),
			readBlob: (id: string) => mem.readBlob(id),
			dangerClearAll: () => mem.dangerClearAll()
		};
		(window as unknown as { __MEMORY_VFS_FILES__?: typeof hook }).__MEMORY_VFS_FILES__ = hook;
	}

	function paneState(id: PaneId): PaneState {
		return id === 'left' ? left : right;
	}
	function setPane(id: PaneId, patch: Partial<PaneState>) {
		if (id === 'left') left = { ...left, ...patch };
		else right = { ...right, ...patch };
	}
	function activeDriver(p: PaneState, id?: PaneId): ExplorerDriver {
		if (id === 'right' && overrideRight) return overrideRight.driver;
		if (p.activeKind === 'memory') return p.memoryDriver ?? getMemoryDriver();
		if (p.activeKind !== 'local' && p.remoteDriver) return p.remoteDriver;
		return localDriver;
	}
	function releaseRemote(kind: ConnectionKind, profileId: string | null | undefined) {
		if (!profileId || profileId === 'local' || profileId === 'memory' || profileId === 'disk') return;
		if (kind === 'b2') releaseB2Driver(profileId);
		else if (kind === 'rclone') releaseRcloneDriver(profileId);
		else if (kind === 'monitor') releaseMonitorDriver(profileId);
	}

	async function reloadProfiles() {
		b2Profiles = await listB2Profiles();
		if (showRclone) rcloneProfiles = await listRcloneProfiles();
		else rcloneProfiles = [];
		if (showMonitor) monitorProfiles = await listMonitorProfiles();
		else monitorProfiles = [];
	}

	const b2Chips = $derived(
		b2Profiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: p.namePrefix ? `${p.bucketName} · ${p.namePrefix}` : p.bucketName
		}))
	);
	const rcloneChips = $derived(
		rcloneProfiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: p.rootPath ? `${p.fs} · ${p.rootPath}` : p.fs
		}))
	);
	const monitorChips = $derived(
		monitorProfiles.map((p) => ({ id: p.id, name: p.name, detail: p.rootPath }))
	);

	const rightCopyKind = $derived(
		overrideRight ? overrideRight.driver.id : right.ctx.backend || right.activeKind
	);
	const showCopyAcross = $derived(
		dualPane && canShowCopyAcross(left.ctx.backend || left.activeKind, rightCopyKind)
	);

	const visibleCopyItems = $derived(copyItems.filter((t) => !dismissedCopyIds.has(t.id)));
	const destCopyPending = $derived(
		stackTransferItems(visibleCopyItems)
			.filter((t) => !t.done)
			.map((t) => ({
				id: t.id,
				name: t.name,
				transferred: t.behind,
				size: t.size || Math.max(t.ahead, 1),
				ready: t.ahead,
				direction: 'receiving' as const
			}))
	);

	function panePending(id: PaneId) {
		const extra = id === copyDestPane ? destCopyPending : [];
		const base = id === 'left' ? pendingLeft : pendingRight;
		return extra.length ? [...base, ...extra] : base;
	}

	function dismissCopy(id: string) {
		dismissedCopyIds = new Set([...dismissedCopyIds, id]);
	}

	function dismissAllSettledCopy() {
		const next = new Set(dismissedCopyIds);
		for (const t of copyItems) {
			if (t.done || t.status === 'failed') next.add(t.id);
		}
		dismissedCopyIds = next;
	}

	onMount(() => {
		try {
			const stored = localStorage.getItem(dualPaneKey);
			dualPane = stored === null ? dualPaneDefault : stored === '1';
		} catch {
			dualPane = dualPaneDefault;
		}
		onDualChange?.(dualPane);
		void reloadProfiles();
		// Hub files memory singleton hook (separate from durable page-owned __VFS_TEST__).
		// Memory is global/shared: NOT disposed on pagehide.
		const mem = getMemoryVfs();
		memoryVfs = mem;
		void mem.ready().then(() => installMemoryFilesHook(mem));
		const pullCopy = () => {
			copyItems = listTransfers().filter((t) => t.direction === 'copying');
		};
		pullCopy();
		copyProgressUnsub = subscribeTransfers(pullCopy);
	});

	onDestroy(() => {
		copyProgressUnsub?.();
		copyProgressUnsub = null;
		if (watchPollTimer) {
			clearInterval(watchPollTimer);
			watchPollTimer = null;
		}
		// Release any held remote drivers on teardown (memory VFS is global: NOT disposed).
		for (const id of ['left', 'right'] as PaneId[]) {
			const p = paneState(id);
			dropDiskDriver(p);
			if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
				releaseRemote(p.activeKind, p.activeId);
			}
		}
	});

	function setDualPane(on: boolean) {
		dualPane = on;
		onDualChange?.(on);
		try {
			localStorage.setItem(dualPaneKey, on ? '1' : '0');
		} catch {
			/* ignore */
		}
		if (!on) {
			const r = right;
			dropDiskDriver(r);
			if (r.activeId !== 'local' && r.activeId !== 'memory' && r.activeId !== 'disk') {
				releaseRemote(r.activeKind, r.activeId);
			}
			right = emptyPane(rightDefault);
			copyError = '';
		}
	}

	async function connectB2(id: PaneId, profile: B2ConnectionProfileV1) {
		const p = paneState(id);
		const prevId = p.activeId !== 'local' && p.activeId !== 'memory' ? p.activeId : null;
		const prevKind = p.activeKind;
		dropDiskDriver(p);
		setPane(id, { busy: true, error: '', showRcloneForm: false, showMonitorForm: false });
		try {
			const driver = await acquireB2Driver(profile);
			if (prevId && !(prevKind === 'b2' && prevId === profile.id)) {
				releaseRemote(prevKind, prevId);
			}
			void setActiveB2ProfileId(profile.id);
			setPane(id, {
				remoteDriver: driver,
				memoryDriver: null,
				activeId: profile.id,
				activeKind: 'b2',
				showB2Form: false,
				showRcloneForm: false,
				showMonitorForm: false,
				explorerKey: p.explorerKey + 1,
				busy: false,
				error: '',
				ctx: emptyCtx('b2')
			});
		} catch (e) {
			const mapped = mapB2Error(e);
			setPane(id, { busy: false, error: mapped.message, showB2Form: true });
		}
	}

	async function connectRclone(id: PaneId, profile: RcloneConnectionProfileV1) {
		const p = paneState(id);
		dropDiskDriver(p);
		const prevId = p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk' ? p.activeId : null;
		const prevKind = p.activeKind;
		setPane(id, { busy: true, error: '', showB2Form: false, showMonitorForm: false });
		try {
			const driver = await acquireRcloneDriver(profile);
			if (prevId && !(prevKind === 'rclone' && prevId === profile.id)) {
				releaseRemote(prevKind, prevId);
			}
			void setActiveRcloneProfileId(profile.id);
			setPane(id, {
				remoteDriver: driver,
				memoryDriver: null,
				activeId: profile.id,
				activeKind: 'rclone',
				showB2Form: false,
				showRcloneForm: false,
				showMonitorForm: false,
				explorerKey: p.explorerKey + 1,
				busy: false,
				error: '',
				ctx: emptyCtx('rclone')
			});
		} catch (e) {
			const mapped = mapRcloneError(e);
			setPane(id, { busy: false, error: mapped.message, showRcloneForm: true });
		}
	}

	function startWatchStatusPoll() {
		if (watchPollTimer) return;
		watchPollTimer = setInterval(() => {
			const next: Record<string, string> = {};
			for (const paneId of ['left', 'right'] as PaneId[]) {
				const p = paneState(paneId);
				if (p.activeKind !== 'monitor' || !p.remoteDriver) continue;
				const d = p.remoteDriver as { getWatchStatus?: () => string };
				next[paneId] = d.getWatchStatus?.() ?? 'off';
			}
			monitorWatchStatus = next;
			// e2e probe
			(window as unknown as { __MONITOR_WATCH__?: Record<string, string> }).__MONITOR_WATCH__ =
				next;
		}, 400);
	}

	async function connectMonitor(id: PaneId, profile: MonitorConnectionProfileV1) {
		const p = paneState(id);
		dropDiskDriver(p);
		const prevId = p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk' ? p.activeId : null;
		const prevKind = p.activeKind;
		setPane(id, {
			busy: true,
			error: '',
			showB2Form: false,
			showRcloneForm: false,
			showMonitorForm: false
		});
		try {
			const driver = await acquireMonitorDriver(profile);
			if (prevId && !(prevKind === 'monitor' && prevId === profile.id)) {
				releaseRemote(prevKind, prevId);
			}
			void setActiveMonitorProfileId(profile.id);
			setPane(id, {
				remoteDriver: driver,
				memoryDriver: null,
				activeId: profile.id,
				activeKind: 'monitor',
				showB2Form: false,
				showRcloneForm: false,
				showMonitorForm: false,
				explorerKey: p.explorerKey + 1,
				busy: false,
				error: '',
				ctx: emptyCtx('monitor')
			});
			startWatchStatusPoll();
		} catch (e) {
			const mapped = mapMonitorError(e);
			setPane(id, {
				busy: false,
				error: formatMonitorErrorMessage(mapped),
				showMonitorForm: true
			});
		}
	}

	function dropDiskDriver(p: PaneState) {
		if (p.activeKind === 'disk') p.remoteDriver?.dispose?.();
	}

	async function connectDisk(id: PaneId, opts?: { replace?: boolean }) {
		const p = paneState(id);
		if (p.activeKind === 'disk' && p.remoteDriver && !opts?.replace) return;
		if (!canPickDirectory()) {
			setPane(id, {
				error: 'This browser cannot open a computer folder. Use Chrome or Edge, or upload individual files with Upload from device.'
			});
			return;
		}
		try {
			const handle = await pickDirectory();
			const driver = createDiskExplorerDriver(handle);
			await driver.ready();
			// Only drop the previous remote after the new grant is usable.
			if (p.activeKind === 'disk') p.remoteDriver?.dispose?.();
			else if (p.activeId !== 'local' && p.activeId !== 'memory') {
				releaseRemote(p.activeKind, p.activeId);
			}
			setPane(id, {
				activeId: 'disk',
				activeKind: 'disk',
				remoteDriver: driver,
				memoryDriver: null,
				diskName: handle.name || 'This computer',
				showB2Form: false,
				showRcloneForm: false,
				showMonitorForm: false,
				explorerKey: p.explorerKey + 1,
				error: '',
				ctx: emptyCtx('disk')
			});
		} catch (e) {
			const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
			if (name === 'AbortError') return;
			setPane(id, {
				error: e instanceof Error ? e.message : 'Could not open that folder'
			});
		}
	}

	function connectMemory(id: PaneId) {
		const p = paneState(id);
		dropDiskDriver(p);
		if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
			releaseRemote(p.activeKind, p.activeId);
		}
		const mem = getMemoryDriver();
		installMemoryFilesHook(memoryVfs ?? getMemoryVfs());
		setPane(id, {
			activeId: 'memory',
			activeKind: 'memory',
			remoteDriver: null,
			memoryDriver: mem,
			showB2Form: false,
			showRcloneForm: false,
			showMonitorForm: false,
			explorerKey: p.explorerKey + 1,
			error: '',
			diskName: '',
			ctx: emptyCtx('memory')
		});
	}

	async function onSelectConnection(id: PaneId, selection: 'local' | 'memory' | 'disk' | string) {
		const p = paneState(id);
		if (selection === 'local') {
			dropDiskDriver(p);
			if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
				releaseRemote(p.activeKind, p.activeId);
			}
			setPane(id, {
				activeId: 'local',
				activeKind: 'local',
				remoteDriver: null,
				memoryDriver: null,
				error: '',
				showB2Form: false,
				showRcloneForm: false,
				showMonitorForm: false,
				explorerKey: p.explorerKey + 1,
				diskName: '',
				ctx: emptyCtx('local')
			});
			return;
		}
		if (selection === 'memory') {
			connectMemory(id);
			return;
		}
		if (selection === 'disk') {
			await connectDisk(id);
			return;
		}
		if (p.activeId === selection && p.remoteDriver) return;

		const rclone = showRclone ? await getRcloneProfile(selection) : undefined;
		if (rclone) {
			await connectRclone(id, rclone);
			return;
		}
		const mon = showMonitor ? await getMonitorProfile(selection) : undefined;
		if (mon) {
			await connectMonitor(id, mon);
			return;
		}
		const b2 = await getB2Profile(selection);
		if (b2) {
			await connectB2(id, b2);
			return;
		}
		await reloadProfiles();
		setPane(id, {
			error: 'That connection was removed. Pick another or add one in settings.',
			showB2Form: true
		});
	}

	function paneShowsSwitcher(id: PaneId): boolean {
		if (hideConnectionSwitcher) return false;
		if (!switcherPanes || switcherPanes.length === 0) return true;
		return switcherPanes.includes(id);
	}

	function onPaneDragStart(id: PaneId, e: DragEvent) {
		const p = paneState(id);
		const fromDt = idsFromExplorerDataTransfer(e.dataTransfer);
		const fromRow = idsFromExplorerDragTarget(e.target);
		const selectedIds = fromDt.length
			? fromDt
			: fromRow.length
				? fromRow
				: p.ctx.selectedIds;
		if (selectedIds.length) {
			onExplorerDrag?.({
				paneId: id,
				driver: activeDriver(p, id),
				selectedIds,
				entries: p.ctx.entries
			});
		}
		if (!dualPane || !showCopyAcross) return;
		crossDragFrom = id;
		crossOver = null;
	}

	function onPaneDragOver(id: PaneId, e: DragEvent) {
		if (!dualPane || !showCopyAcross || !crossDragFrom || crossDragFrom === id) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		crossOver = id;
	}

	function onPaneDragLeave(id: PaneId, e: DragEvent) {
		const next = e.relatedTarget;
		if (next instanceof Node && (e.currentTarget as Node).contains(next)) return;
		if (crossOver === id) crossOver = null;
	}

	function onPaneDragEnd() {
		crossDragFrom = null;
		crossOver = null;
	}

	async function onPaneDrop(id: PaneId, e: DragEvent) {
		if (!dualPane || !showCopyAcross || !crossDragFrom || crossDragFrom === id) {
			onPaneDragEnd();
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const from = crossDragFrom;
		const src = paneState(from);
		const dst = paneState(id);
		const dragged = idsFromExplorerDataTransfer(e.dataTransfer);
		const selectedIds = dragged.length ? dragged : src.ctx.selectedIds;
		const destParentId = destParentFromDropEvent(e, dst.ctx.parentId);
		onPaneDragEnd();
		await runCopyAcross(from, { selectedIds, destParentId });
	}

	function copyHints(id: PaneId): {
		copyOut: ReturnType<typeof describeCopyAcrossPath> | null;
		copyIn: ReturnType<typeof describeCopyAcrossPath> | null;
		copyOtherLabel: string;
		copyIdleNote: string | null;
	} {
		if (!dualPane) {
			return {
				copyOut: null,
				copyIn: null,
				copyOtherLabel: '',
				copyIdleNote: 'Turn on dual pane to copy between locations.'
			};
		}
		const otherId: PaneId = id === 'left' ? 'right' : 'left';
		const mine = activeDriver(paneState(id), id);
		const other = activeDriver(paneState(otherId), otherId);
		const myLabel = paneConnectionLabel(id);
		const otherLabel = paneConnectionLabel(otherId);
		return {
			copyOut: describeCopyAcrossPath(mine, other, { source: myLabel, dest: otherLabel }),
			copyIn: describeCopyAcrossPath(other, mine, { source: otherLabel, dest: myLabel }),
			copyOtherLabel: otherLabel,
			copyIdleNote: null
		};
	}

	function paneConnectionLabel(id: PaneId): string {
		const p = paneState(id);
		if (id === 'right' && overrideRight) return overrideRight.label;
		if (p.activeKind === 'memory') return 'In memory';
		if (p.activeKind === 'disk') return p.diskName ? `This computer · ${p.diskName}` : 'This computer';
		if (p.activeKind === 'local') return 'Browser files';
		if (p.activeKind === 'b2') {
			const chip = b2Chips.find((c) => c.id === p.activeId);
			return chip ? `B2 · ${chip.name}` : 'B2';
		}
		if (p.activeKind === 'rclone') {
			const chip = rcloneChips.find((c) => c.id === p.activeId);
			return chip ? `rclone · ${chip.name}` : 'rclone';
		}
		if (p.activeKind === 'monitor') {
			const chip = monitorChips.find((c) => c.id === p.activeId);
			return chip ? `Monitor · ${chip.name}` : 'Monitor';
		}
		return p.activeKind;
	}

	function askDualPhase(sourceLabel: string, destLabel: string): Promise<boolean> {
		return new Promise((resolve) => {
			dualPhasePrompt = { sourceLabel, destLabel, resolve };
		});
	}

	async function runCopyAcross(
		from: PaneId,
		opts?: { selectedIds?: string[]; destParentId?: string | null }
	) {
		if (!dualPane) return;
		const src = paneState(from);
		const destId: PaneId = from === 'left' ? 'right' : 'left';
		const dst = paneState(destId);
		copyError = '';
		const sourceDriver = activeDriver(src, from);
		const destDriver = activeDriver(dst, destId);
		if (isDualPhaseCopy(sourceDriver, destDriver)) {
			const ok = await askDualPhase(paneConnectionLabel(from), paneConnectionLabel(destId));
			if (!ok) return;
		}
		copyBusy = true;
		copyDestPane = destId;
		try {
			const n = await copyAcross({
				sourceDriver: activeDriver(src, from),
				destDriver,
				selectedIds: opts?.selectedIds ?? src.ctx.selectedIds,
				sourceEntries: src.ctx.entries,
				destParentId: opts?.destParentId !== undefined ? opts.destParentId : dst.ctx.parentId
			});
			// Live drivers refresh in place. Remotes without subscribeChanges
			// remount but keep the dest open folder via initialParentId.
			if (!destDriver.subscribeChanges) {
				setPane(destId, {
					explorerKey: dst.explorerKey + 1
				});
			}
			if (n === 0) copyError = 'Nothing copied';
		} catch (e) {
			if (e instanceof CopyAcrossError) copyError = e.message;
			else copyError = e instanceof Error ? e.message : String(e);
		} finally {
			copyBusy = false;
		}
	}

	async function runSend(id: PaneId, opts?: { selectedIds?: string[]; entries?: ExplorerEntry[] }) {
		if (!onSend) return;
		const p = paneState(id);
		const selectedIds = opts?.selectedIds ?? p.ctx.selectedIds;
		const entries = opts?.entries ?? p.ctx.entries;
		if (selectedIds.length === 0) return;
		sendError = null;
		sendBusy = true;
		try {
			await onSend({
				paneId: id,
				driver: activeDriver(p, id),
				selectedIds,
				entries
			});
			// Remount so selection clears and the pane re-lists.
			setPane(id, { explorerKey: p.explorerKey + 1 });
		} catch (e) {
			sendError = { pane: id, message: e instanceof Error ? e.message : String(e) };
		} finally {
			sendBusy = false;
		}
	}

	/**
	 * Imperative refresh: remount a pane's `FileExplorer` so it re-lists. Used by
	 * host pages that mutate a backend VFS outside copy-across (e.g. CM
	 * "copy to library" writes to the durable library VFS directly).
	 */
	export function refreshPane(id: PaneId) {
		const p = paneState(id);
		setPane(id, { explorerKey: p.explorerKey + 1 });
	}
</script>

{#snippet explorerPane(id: PaneId)}
	<!-- Read $state panes directly so UI reacts (avoid stale {@const}). -->
	{@const p = id === 'left' ? left : right}
	{@const drv = activeDriver(p, id)}
	{@const hostTid = tids.explorerHost(id)}
	{@const subTid = tids.paneSub(id)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="files-pane"
		class:drop-target={crossOver === id}
		data-testid={tids.pane(id)}
		data-pane={id}
		ondragstart={(e) => onPaneDragStart(id, e)}
		ondragover={(e) => onPaneDragOver(id, e)}
		ondragleave={(e) => onPaneDragLeave(id, e)}
		ondrop={(e) => void onPaneDrop(id, e)}
		ondragend={onPaneDragEnd}
	>
		<div class="pane-chrome" data-testid={tids.paneChrome(id)}>
			{#if !hidePaneLabels && dualPane}
				<span class="pane-label" data-testid={tids.paneLabel(id)}>
					{id === 'left' ? 'Left' : 'Right'}
				</span>
			{/if}
			{#if paneShowsSwitcher(id) && !(id === 'right' && overrideRight)}
				{@const hints = copyHints(id)}
				<ConnectionSwitcher
				activeId={p.activeId}
				activeKind={p.activeKind}
				capabilities={drv.capabilities}
				copyOut={hints.copyOut}
				copyIn={hints.copyIn}
				copyOtherLabel={hints.copyOtherLabel}
				copyIdleNote={hints.copyIdleNote}
				profiles={b2Chips}
				rcloneProfiles={rcloneChips}
				monitorProfiles={monitorChips}
				showRclone={showRclone}
				showMonitor={showMonitor}
				showMemory={switcherShowMemory}
				busy={p.busy}
				onSelect={(sel) => onSelectConnection(id, sel)}
				onConfigureB2={() => {
					setPane(id, { showB2Form: true, showRcloneForm: false, showMonitorForm: false, error: '' });
				}}
				onConfigureRclone={() => {
					setPane(id, { showRcloneForm: true, showB2Form: false, showMonitorForm: false, error: '' });
				}}
				onConfigureMonitor={() => {
					setPane(id, { showMonitorForm: true, showB2Form: false, showRcloneForm: false, error: '' });
				}}
				onConfigureDisk={() => void connectDisk(id, { replace: true })}
			/>
			{/if}
			{#if drv.capabilities.supportsTrash}
				<button
					type="button"
					class="pane-trash"
					class:active={p.showTrash}
					data-testid="fe-trash-view"
					title={p.showTrash ? 'Leave trash' : 'Open trash'}
					aria-pressed={p.showTrash}
					onclick={() => {
						const next = !p.showTrash;
						setPane(id, {
							showTrash: next,
							ctx: { ...p.ctx, parentId: null, selectedIds: [] }
						});
					}}
				>
					Trash
				</button>
			{/if}
			{#if showCopyAcross}
				<button
					type="button"
					class="copy-across"
					data-testid={tids.copyAcross(id)}
					disabled={copyBusy || p.ctx.selectedIds.length === 0}
					title="Copy selected items into the other pane's open folder"
					onclick={() => runCopyAcross(id)}
				>
					{copyBusy ? 'Copying…' : 'Copy across'}
				</button>
				{#if copyError}
					<span class="copy-err" data-testid={tids.copyAcrossError} role="alert">{copyError}</span>
				{/if}
			{/if}
			{#if onSend}
				<button
					type="button"
					class="send-selected"
					data-testid={tids.send(id)}
					disabled={sendBusy || p.ctx.selectedIds.length === 0 || !drv.download}
					title="Send selected items to the other user"
					onclick={() => runSend(id)}
				>
					{sendBusy ? 'Sending…' : 'Send'}
				</button>
				{#if sendError?.pane === id}
					<span class="send-err" data-testid={tids.sendError} role="alert">{sendError.message}</span>
				{/if}
			{/if}
			{#if p.busy}
				<span
					class="busy"
					data-testid={p.activeKind === 'monitor' || p.showMonitorForm
						? `monitor-connecting-${id}`
						: p.activeKind === 'rclone' || p.showRcloneForm
							? `rclone-connecting-${id}`
							: `b2-connecting-${id}`}
				>
					Connecting…
				</span>
			{/if}
			{#if p.activeKind === 'b2'}
				<span class="remote-badge" data-testid="b2-remote-badge-{id}">Remote · open-with off</span>
			{:else if p.activeKind === 'rclone'}
				<span class="remote-badge" data-testid="rclone-remote-badge-{id}">rclone · open-with off</span>
			{:else if p.activeKind === 'monitor'}
				<span class="remote-badge" data-testid="monitor-remote-badge-{id}"
					>monitor · open-with off</span
				>
				<span
					class="remote-badge mon-watch"
					data-testid="monitor-watch-status-{id}"
					data-status={monitorWatchStatus[id] ?? 'off'}
					title="Live filesystem watch (monitor SSE)"
				>
					watch · {monitorWatchStatus[id] ?? 'off'}
				</span>
			{:else if p.activeKind === 'memory'}
				<span class="remote-badge mem" data-testid="memory-badge-{id}">In memory · tab only</span>
			{:else if p.activeKind === 'disk'}
				<span class="remote-badge" data-testid="disk-badge-{id}"
					>This computer{p.diskName ? ` · ${p.diskName}` : ''}</span
				>
			{/if}
			{#if id === 'right' && overrideRight}
				<span class="remote-badge" data-testid="peer-fs-badge">Their · {overrideRight.label}</span>
			{/if}
			{#if subTid}
				<span class="pane-sub" data-testid={subTid.testid}>{subTid.text}</span>
			{/if}
		</div>
		{#if p.error}
			<div
				class="b2-error"
				data-testid={p.activeKind === 'monitor' || p.showMonitorForm
					? `monitor-connect-error-${id}`
					: p.activeKind === 'rclone' || p.showRcloneForm
						? `rclone-connect-error-${id}`
						: `b2-connect-error-${id}`}
				role="alert"
			>
				{p.error}
			</div>
		{/if}
		{#if p.showB2Form}
			<div class="pane-form" data-testid="b2-form-wrap-{id}">
				<B2ConnectionForm
					onConnected={async (profile) => {
						await reloadProfiles();
						await connectB2(id, profile);
					}}
					onDisconnected={() => {
						const cur = id === 'left' ? left : right;
						if (cur.activeKind === 'b2' && cur.activeId !== 'local') {
							releaseB2Driver(cur.activeId);
						}
						setPane(id, {
							remoteDriver: null,
							activeId: 'local',
							activeKind: 'local',
							showB2Form: false,
					explorerKey: cur.explorerKey + 1
						});
						void reloadProfiles();
					}}
					onCancel={() => setPane(id, { showB2Form: false })}
				/>
			</div>
		{/if}
		{#if p.showRcloneForm && showRclone}
			<div class="pane-form" data-testid="rclone-form-wrap-{id}">
				<RcloneConnectionForm
					onConnected={async (profile) => {
						await reloadProfiles();
						await connectRclone(id, profile);
					}}
					onDisconnected={() => {
						const cur = id === 'left' ? left : right;
						if (cur.activeKind === 'rclone' && cur.activeId !== 'local') {
							releaseRcloneDriver(cur.activeId);
						}
						setPane(id, {
							remoteDriver: null,
							activeId: 'local',
					activeKind: 'local',
					showRcloneForm: false,
					explorerKey: cur.explorerKey + 1
						});
						void reloadProfiles();
					}}
					onCancel={() => setPane(id, { showRcloneForm: false })}
				/>
			</div>
		{/if}
		{#if p.showMonitorForm && showMonitor}
			<div class="pane-form" data-testid="monitor-form-wrap-{id}">
				<MonitorConnectionForm
					onConnected={async (profile) => {
						await reloadProfiles();
						await connectMonitor(id, profile);
					}}
					onDisconnected={() => {
						const cur = id === 'left' ? left : right;
						if (cur.activeKind === 'monitor' && cur.activeId !== 'local') {
							releaseMonitorDriver(cur.activeId);
						}
						setPane(id, {
							remoteDriver: null,
							activeId: 'local',
							activeKind: 'local',
							showMonitorForm: false,
							explorerKey: cur.explorerKey + 1
						});
						void reloadProfiles();
					}}
					onCancel={() => setPane(id, { showMonitorForm: false })}
				/>
			</div>
		{/if}
		<div class="pane-explorer" data-testid={hostTid}>
			{#key `${id}-${p.explorerKey}-${p.activeKind}-${p.activeId}-${id === 'right' && overrideRight ? `peer:${overrideRight.label}` : ''}`}
				{#if id === 'right' && overrideRight}
					<FileExplorer
						mode="manage"
						variant="panel"
						driver={overrideRight.driver}
						showPersistence={false}
						hideToolbarTrash={true}
						trashView={p.showTrash}
						onTrashViewChange={(open) => setPane(id, { showTrash: open })}
						initialParentId={p.ctx.parentId}
						pending={panePending(id)}
						onContextChange={(ctx) => {
							right = { ...right, ctx };
						}}
					/>
				{:else if p.activeKind === 'local'}
					<!-- Page header owns the persistence chip; keep FE toolbar uncluttered. -->
					<FileExplorer
						mode="manage"
						variant="panel"
						driver={localDriver}
						showPersistence={false}
						hideToolbarTrash={true}
						trashView={p.showTrash}
						onTrashViewChange={(open) => setPane(id, { showTrash: open })}
						initialParentId={p.ctx.parentId}
						onOpen={onOpen}
						onSendFile={
							onSend
								? (entry) => runSend(id, { selectedIds: [entry.id], entries: [entry] })
								: undefined
						}
						pending={panePending(id)}
						onContextChange={(ctx) => {
							// Avoid full-pane rewrite storms — only patch ctx fields
							if (id === 'left') left = { ...left, ctx };
							else right = { ...right, ctx };
						}}
					/>
				{:else}
					<FileExplorer
						mode="manage"
						variant="panel"
						driver={drv}
						showPersistence={false}
						hideToolbarTrash={true}
						trashView={p.showTrash}
						onTrashViewChange={(open) => setPane(id, { showTrash: open })}
						initialParentId={p.ctx.parentId}
						onOpen={p.activeKind === 'memory' ? onOpen : undefined}
						onSendFile={
							onSend
								? (entry) => runSend(id, { selectedIds: [entry.id], entries: [entry] })
								: undefined
						}
						pending={panePending(id)}
						onContextChange={(ctx) => {
							if (id === 'left') left = { ...left, ctx };
							else right = { ...right, ctx };
						}}
					/>
				{/if}
			{/key}
		</div>
	</div>
{/snippet}

<div class="dpe-shell" class:dual={dualPane}>
	{#if !hideToggles}
		<div class="dpe-controls">
			{#if showLocalPersist && persistenceVfs}
				<div class="persist-wrap" data-testid={tids.persist}>
					<StoragePersistenceStatus vfs={persistenceVfs} compact={false} pollMs={10_000} />
				</div>
			{/if}
			<button
				type="button"
				class="dual-toggle"
				class:active={dualPane}
				data-testid={tids.dualToggle}
				aria-pressed={dualPane}
				title={dualPane
					? 'Show a single file tree'
					: 'Two independent trees side by side. Copy across appears when at least one pane is local/memory.'}
				onclick={() => setDualPane(!dualPane)}
			>
				{dualPane ? 'Single pane' : 'Dual pane'}
			</button>
		</div>
	{/if}

	<div class="files-body" class:dual={dualPane} data-testid={tids.body}>
		{@render explorerPane('left')}
		{#if dualPane}
			{@render explorerPane('right')}
		{/if}
	</div>
	<OpProgressPopup
		items={visibleCopyItems}
		onDismiss={dismissCopy}
		onDismissAll={dismissAllSettledCopy}
	/>
	{#if dualPhasePrompt}
		<DualPhaseConfirm
			sourceLabel={dualPhasePrompt.sourceLabel}
			destLabel={dualPhasePrompt.destLabel}
			onConfirm={() => {
				const r = dualPhasePrompt?.resolve;
				dualPhasePrompt = null;
				r?.(true);
			}}
			onCancel={() => {
				const r = dualPhasePrompt?.resolve;
				dualPhasePrompt = null;
				r?.(false);
			}}
		/>
	{/if}
</div>

<style>
	.dpe-shell {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
	}
	.dpe-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.persist-wrap {
		display: inline-flex;
		align-items: center;
		margin-right: auto;
	}
	.dual-toggle,
	.copy-across,
	.send-selected {
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border, #334155);
		background: var(--surface, #1e293b);
		color: inherit;
		cursor: pointer;
		font-size: 0.9rem;
	}
	.dual-toggle.active {
		outline: 2px solid #38bdf8;
		outline-offset: 1px;
	}
	.copy-across:disabled,
	.send-selected:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.copy-err,
	.send-err {
		color: #ffb4b4;
		font-size: 0.85rem;
	}
	.busy {
		font-size: 0.8rem;
		opacity: 0.8;
	}
	.b2-error {
		margin: 0;
		padding: 0.4rem 0.65rem;
		background: #4a2020;
		color: #ffb4b4;
		border-radius: 6px;
		font-size: 0.85rem;
	}
	.remote-badge {
		font-size: 0.75rem;
		color: #7dd3fc;
		white-space: nowrap;
	}
	.remote-badge.mem {
		color: #c4b5fd;
	}
	.remote-badge.mon-watch {
		color: #86efac;
		text-transform: lowercase;
	}
	.pane-sub {
		font-size: 0.72rem;
		color: var(--text-muted, #94a3b8);
	}
	.files-body {
		min-height: 420px;
		border: 1px solid var(--border, #e2e8f0);
		border-radius: 12px;
		overflow: hidden;
		background: var(--surface, #0f172a);
		display: grid;
		grid-template-columns: 1fr;
	}
	.files-body.dual {
		grid-template-columns: 1fr 1fr;
	}
	.files-pane {
		min-width: 0;
		min-height: 420px;
		display: flex;
		flex-direction: column;
	}
	.files-pane.drop-target {
		outline: 2px solid #38bdf8;
		outline-offset: -2px;
		background: color-mix(in srgb, #38bdf8 10%, transparent);
	}
	.files-body.dual .files-pane + .files-pane {
		border-left: 1px solid var(--border, #334155);
	}
	.pane-chrome {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.65rem;
		border-bottom: 1px solid var(--border, #334155);
	}
	.pane-label {
		font-size: 0.75rem;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.7;
	}
	.pane-chrome:has(.pane-trash) :global(.conn-settings-wrap) {
		margin-left: 0;
	}
	.pane-trash {
		order: 98;
		margin-left: auto;
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border, #334155);
		background: var(--surface, #1e293b);
		color: inherit;
		cursor: pointer;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.pane-trash.active {
		outline: 2px solid #38bdf8;
		outline-offset: 1px;
	}
	.pane-form {
		padding: 0 0.65rem;
		border-bottom: 1px solid var(--border, #334155);
		max-height: 50vh;
		overflow: auto;
	}
	.pane-explorer {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.pane-explorer :global(.fe-root) {
		flex: 1;
		height: 100%;
		min-height: 360px;
		border: none;
		border-radius: 0;
	}
	@media (max-width: 800px) {
		.files-body.dual {
			grid-template-columns: 1fr;
		}
	}
</style>
