<script lang="ts">
	/**
	 * Multi-window file explorer with switchable backends (local / memory / b2 /
	 * rclone / monitor / disk) and copy-across between windows.
	 *
	 * Uses the shared AppWindows windowing system to provide dynamic splitting,
	 * top-left window management, TARGET window tracking for clipboard and system
	 * operations, and full copy-across matrix execution between any window pair.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { default as FileExplorer } from './FileExplorer.svelte';
	import type { ExplorerContext, ExplorerMode, RemoteKind } from './componentTypes.js';
	import type { FileTypeId } from '../types.js';
	import CopyProgressHeader from './CopyProgressHeader.svelte';
	import DualPhaseConfirm from './DualPhaseConfirm.svelte';
	import { stackTransferItems } from './stackProgress.js';
	import {
		abortTransfer,
		listTransfers,
		subscribeTransfers,
		upsertProgress,
		type TransferItem
	} from '../transferRegistry.js';
	import { generateId } from '../id.js';
	import {
		type ExplorerDriver,
		type ExplorerEntry,
		type ExplorerEntryId,
		type ExplorerOpenContext,
		type ExplorerOpenTarget,
		type OpenProjectContext
	} from './explorerDriver.js';
	import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
	import { type PaneId, type DualPaneTids } from './dualPaneTypes.js';
	import { portal } from './portal.js';
	import FeTipIconBtn from './FeTipIconBtn.svelte';
	import ConnectionPairInfo from './ConnectionPairInfo.svelte';
	import {
		AppWindows,
		AppWindowsButton,
		appClipboard,
		createLeaf,
		leafCount,
		listLeaves,
		portalToPaneWindowHeader,
		splitLeaf,
		type LayoutNode,
		toast
	} from '@shared-packages/ui';
	import {
		buildFileWindowRoles,
		createFileWindowRoot,
		defaultFileWindows,
		emptyFileContext,
		emptyFileWindowState,
		loadFileWindows,
		resolveTargetFilePaneId,
		saveFileWindows,
		type FileWindowState
	} from './fileWindows.js';
	import '@shared-packages/design-system/button.css';
	import '@shared-packages/design-system/tooltip.css';
	import '@shared-packages/design-system/segmented.css';
	import {
		classify,
		describeCopyAcrossPath,
		copyAcross,
		CopyAcrossError,
		destParentFromDropEvent,
		idsFromExplorerDataTransfer,
		idsFromExplorerDragTarget,
		dataTransferHasOsFiles,
		dataTransferHasExplorerIds
	} from './copyAcross.js';
	import {
		collectOsDrop,
		importOsDropToDriver,
		type OsDropFileProgress,
		type OsDropNode
	} from './osDrop.js';
	import { formatExplorerError } from './explorerError.js';
	import {
		setCrossWindowDrag,
		getCrossWindowDrag,
		clearCrossWindowDrag,
		setPointerDragActive,
		isPointerDragActive
	} from './crossWindowDnd.js';
	import {
		getMemoryVfs,
		subscribeTabChannel,
		HUB_B2_PROFILES_CHANNEL,
		HUB_MONITOR_PROFILES_CHANNEL,
		HUB_RCLONE_PROFILES_CHANNEL,
		HUB_VAULT_CHANNEL,
		type MemoryVfsService,
		type VfsService
	} from '../index.js';
	import { canPickDirectory, createDiskExplorerDriver, pickDirectory } from '../disk/index.js';
	import {
		B2ConnectionForm,
		ConnectionSwitcher,
		acquireB2Driver,
		releaseB2Driver,
		getProfile as getB2Profile,
		listProfiles as listB2Profiles,
		revealApplicationKey,
		setActiveProfileId as setActiveB2ProfileId,
		mapB2Error,
		type B2ConnectionProfileV1,
		type ConnectionKind
	} from '../b2/index.js';
	import RemoteConnectionsDialog from './RemoteConnectionsDialog.svelte';
	import {
		RcloneConnectionForm,
		acquireRcloneDriver,
		releaseRcloneDriver,
		getProfile as getRcloneProfile,
		listProfiles as listRcloneProfiles,
		revealRcPass,
		setActiveProfileId as setActiveRcloneProfileId,
		mapRcloneError,
		type RcloneConnectionProfileV1
	} from '../rclone/index.js';
	import {
		isVaultLockedError,
		isSecretUnavailableError,
		isVaultEnabled,
		isVaultUnlocked,
		subscribeVaultSession,
		syncVaultFromIdb
	} from '../vault/index.js';
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
		onOpen?: (
			entry: ExplorerOpenTarget,
			ctx?: ExplorerOpenContext | OpenProjectContext
		) => void | Promise<void>;
		onClose?: () => void;
		openRemotes?: boolean;
		accept?: FileTypeId[];
		hideIncompatible?: boolean;
		openLabel?: string;
		explorerMode?: ExplorerMode;
		onOpenProject?: (entry: ExplorerOpenTarget, ctx: OpenProjectContext) => void | Promise<void>;
		onInitProject?: (entry: ExplorerOpenTarget, ctx: OpenProjectContext) => void | Promise<void>;
		projectMarker?: import('./detectProject.js').ProjectMarker;
		onFolder?: (
			parentId: ExplorerEntryId | null,
			ctx: OpenProjectContext
		) => void | Promise<void>;
		persistenceVfs?: VfsService;
		dualPaneKey?: string;
		dualPaneDefault?: boolean;
		memoryScope?: string;
		leftDefault?: ConnectionKind;
		rightDefault?: ConnectionKind;
		hideToggles?: boolean;
		hidePaneLabels?: boolean;
		hideConnectionSwitcher?: boolean;
		switcherPanes?: PaneId[];
		monitorEnabled?: boolean;
		rcloneEnabled?: boolean;
		switcherShowMemory?: boolean;
		onExplorerDrag?: (args: {
			paneId: PaneId;
			driver: ExplorerDriver;
			selectedIds: string[];
			entries: ExplorerEntry[];
		}) => void;
		overrideRight?: { driver: ExplorerDriver; label: string } | null;
		pendingLeft?: Array<{
			id: string;
			name: string;
			transferred: number;
			size: number;
			direction?: string;
			ready?: number;
			status?: string;
			done?: boolean;
		}>;
		pendingRight?: Array<{
			id: string;
			name: string;
			transferred: number;
			size: number;
			direction?: string;
			ready?: number;
			status?: string;
			done?: boolean;
		}>;
		onDualChange?: (dual: boolean) => void;
		onSend?: (args: {
			paneId: PaneId;
			driver: ExplorerDriver;
			selectedIds: string[];
			entries: ExplorerEntry[];
		}) => void | Promise<void>;
		tids?: Partial<DualPaneTids>;
		settingsPortal?: string;
		hideSettingsGear?: boolean;
		switcherPortal?: string;
		layoutPortal?: string;
	};

	let {
		localDriver,
		onOpen,
		onClose,
		openRemotes = false,
		accept,
		hideIncompatible = false,
		openLabel,
		explorerMode = 'manage',
		onOpenProject,
		onInitProject,
		projectMarker = 'any',
		onFolder,
		persistenceVfs,
		dualPaneKey = 'fe:dualPane',
		dualPaneDefault = false,
		memoryScope = 'files',
		leftDefault = 'local',
		rightDefault = 'local',
		hideToggles = false,
		hidePaneLabels: _hidePaneLabels = false,
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
		tids: tidsOverride = {},
		settingsPortal = '',
		hideSettingsGear = false,
		switcherPortal: _switcherPortal = '',
		layoutPortal = ''
	}: Props = $props();

	const hostSettings = $derived(Boolean(settingsPortal) && !hideSettingsGear);
	const pairInfoInChrome = $derived(!hideToggles);
	let showRemoteManager = $state(false);

	function portalLayoutCluster(node: HTMLElement) {
		if (layoutPortal) {
			const res = portal(node, layoutPortal);
			if (res) return res;
		}
		return portalToPaneWindowHeader(node);
	}

	function onRemoteConnected(kind: RemoteKind, profile: object) {
		showRemoteManager = false;
		if (kind === 'b2') void connectB2(targetPaneId, profile as B2ConnectionProfileV1);
		else if (kind === 'rclone') void connectRclone(targetPaneId, profile as RcloneConnectionProfileV1);
		else void connectMonitor(targetPaneId, profile as MonitorConnectionProfileV1);
	}

	function onRemoteDisconnected(kind: RemoteKind) {
		for (const paneId of Object.keys(windows)) {
			const cur = paneState(paneId);
			if (cur.activeKind !== kind) continue;
			releaseRemote(cur.activeKind, cur.activeId);
			setPane(paneId, {
				remoteDriver: null,
				activeId: 'local',
				activeKind: 'local',
				explorerKey: cur.explorerKey + 1
			});
		}
		void reloadProfiles();
	}

	const tids: DualPaneTids = { ...defaultTids, ...tidsOverride };

	type PaneState = FileWindowState;

	function emptyCtx(backend = 'local'): ExplorerContext {
		return emptyFileContext(backend);
	}

	function emptyPane(kind: ConnectionKind): PaneState {
		return emptyFileWindowState(kind, kind);
	}

	let windowRoot = $state<LayoutNode>(createFileWindowRoot(dualPaneDefault));
	let windows = $state<Record<string, PaneState>>(defaultFileWindows(leftDefault, rightDefault));
	let focusedId = $state<string>('left');
	let targetPaneId = $state<string>('left');
	let windowEditOpen = $state<boolean>(false);

	const dualPane = $derived(listLeaves(windowRoot).length > 1);

	// Panes are registered here, not on first read.
	//
	// The window manager creates leaves; their pane state has to exist before
	// anything renders them. Filling it in lazily inside `paneState` meant the
	// template wrote state while computing, which Svelte 5 refuses outright
	// (`state_unsafe_mutation`) — so opening a third window took the whole
	// explorer down. An effect is where that write is legal, and it runs after
	// the paint that `readPane` covers with a default.
	$effect(() => {
		const missing = listLeaves(windowRoot).filter((l) => !windows[l.id]);
		if (!missing.length) return;
		const next = { ...windows };
		for (const leaf of missing) next[leaf.id] = emptyPane(leftDefault);
		windows = next;
	});

	$effect(() => {
		void windowRoot;
		void windows;
		void focusedId;
		void targetPaneId;
		saveFileWindows(dualPaneKey, {
			root: windowRoot,
			windows,
			focusedId,
			targetPaneId
		});
	});

	function paneOnOpen(kind: string) {
		if (!onOpen) return undefined;
		if (kind === 'local' || kind === 'memory' || openRemotes) return onOpen;
		return undefined;
	}

	let b2Profiles = $state<B2ConnectionProfileV1[]>([]);
	let rcloneProfiles = $state<RcloneConnectionProfileV1[]>([]);
	let monitorProfiles = $state<MonitorConnectionProfileV1[]>([]);
	const showRclone = true;
	const showMonitor = true;

	let monitorWatchStatus = $state<Record<string, string>>({});
	let watchPollTimer: ReturnType<typeof setInterval> | null = null;
	let copyBusy = $state(false);
	let copyAbort: AbortController | null = null;

	let crossDragFrom = $state<PaneId | null>(null);
	let crossOver = $state<PaneId | null>(null);
	let sendBusy = $state(false);

	let copyDestPane = $state<PaneId | null>(null);
	let copyDestDriverKey = $state<string | null>(null);
	let copyDestParentId = $state<ExplorerEntry['parentId'] | undefined>(undefined);
	let copyItems = $state<TransferItem[]>([]);
	let dismissedCopyIds = $state<Set<string>>(new Set());
	let copyProgressUnsub: (() => void) | null = null;
	let profileTabUnsub: (() => void) | null = null;
	let memoryVfs: MemoryVfsService | null = null;
	let dualPhasePrompt = $state<{
		sourceLabel: string;
		destLabel: string;
		resolve: (ok: boolean) => void;
	} | null>(null);
	let osDropPane = $state<PaneId | null>(null);
	let dualRootEl = $state<HTMLDivElement | null>(null);

	const availableRoleDefs = $derived(
		buildFileWindowRoles(b2Profiles, rcloneProfiles, monitorProfiles, {
			showMemory: switcherShowMemory,
			hasPeer: Boolean(overrideRight)
		})
	);

	function getMemoryDriver(): ExplorerDriver {
		if (!memoryVfs) memoryVfs = getMemoryVfs();
		return createMemoryExplorerDriver(memoryVfs, {
			capabilitiesPatch: {
				supportsDownload: true,
				supportsUpload: true
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

	/**
	 * A pane's state. Reading NEVER registers it.
	 *
	 * This used to fill in a missing pane on read, which is fine for the
	 * imperative callers but fatal for the many that rendering reaches: a
	 * template expression or `$derived` that touched a leaf with no entry yet
	 * was writing state while computing, which Svelte 5 refuses outright
	 * (`state_unsafe_mutation`) — it took the whole explorer down rather than
	 * degrading. Registration belongs to the effect below, which owns the one
	 * question "which leaves exist?"; a leaf's first paint reads the default
	 * this returns, and the effect has registered it by the next one.
	 */
	function paneState(id: PaneId): PaneState {
		return windows[id] ?? emptyPane(leftDefault);
	}

	function sendTargetEntries(id: PaneId, target: ExplorerOpenTarget): ExplorerEntry[] {
		const row = paneState(id).ctx.entries.find((e) => e.id === target.id);
		return [row ?? { ...target, parentId: null }];
	}

	function paneOpenProjectContext(id: PaneId): OpenProjectContext {
		if (id === 'right' && overrideRight) return { kind: 'peer' };
		const p = paneState(id);
		if (p.activeKind !== 'monitor') return { kind: p.activeKind };
		const profile = monitorProfiles.find((pr) => pr.id === p.activeId);
		return {
			kind: 'monitor',
			profileId: p.activeId,
			baseUrl: profile?.baseUrl,
			rootPath: profile?.rootPath
		};
	}

	function paneOpenProject(id: PaneId) {
		if (!onOpenProject) return undefined;
		return (entry: ExplorerOpenTarget) => onOpenProject(entry, paneOpenProjectContext(id));
	}

	function paneInitProject(id: PaneId) {
		if (!onInitProject) return undefined;
		if (paneState(id).activeKind !== 'local') return undefined;
		return (entry: ExplorerOpenTarget) => onInitProject(entry, paneOpenProjectContext(id));
	}

	function applyPaneCtx(id: PaneId, ctx: ExplorerContext) {
		const p = paneState(id);
		const folderChanged = p.ctx.parentId !== ctx.parentId || p.ctx.backend !== ctx.backend;
		setPane(id, { ctx });
		if (folderChanged) void onFolder?.(ctx.parentId, paneOpenProjectContext(id));
	}

	function paneFileOpen(id: PaneId) {
		if (!onOpen) return undefined;
		const kind = paneState(id).activeKind;
		if (kind !== 'local' && kind !== 'memory' && kind !== 'monitor') return undefined;
		return (entry: ExplorerOpenTarget) => onOpen(entry, paneOpenProjectContext(id));
	}

	function setPane(id: PaneId, patch: Partial<PaneState>) {
		const cur = paneState(id);
		windows = {
			...windows,
			[id]: { ...cur, ...patch }
		};
	}

	function showPaneError(id: PaneId, message: string, extra: Partial<PaneState> = {}) {
		setPane(id, { error: message, ...extra });
		if (message) toast.error(message);
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
			detail: [
				p.namePrefix ? `${p.bucketName} · ${p.namePrefix}` : p.bucketName,
				p.persistSecret === false ? 'this tab' : ''
			]
				.filter(Boolean)
				.join(' · ')
		}))
	);
	const rcloneChips = $derived(
		rcloneProfiles.map((p) => ({
			id: p.id,
			name: p.name,
			detail: [
				p.rootPath ? `${p.fs} · ${p.rootPath}` : p.fs,
				p.persistSecret === false ? 'this tab' : ''
			]
				.filter(Boolean)
				.join(' · ')
		}))
	);
	const monitorChips = $derived(
		monitorProfiles.map((p) => ({ id: p.id, name: p.name, detail: p.rootPath }))
	);

	type ConnDotStatus = 'connecting' | 'subscribed' | 'connected' | 'resync' | 'error' | 'off' | 'closed';
	type ConnDotInfo = {
		wrapTestId: string;
		watchTestId?: string;
		status: ConnDotStatus;
		title: string;
		lines: string[];
	};

	function paneConnDot(id: PaneId): ConnDotInfo | null {
		const p = paneState(id);
		if (id === 'right' && overrideRight) {
			return {
				wrapTestId: 'peer-fs-badge',
				status: 'connected',
				title: 'Peer filesystem',
				lines: [`Their · ${overrideRight.label}`]
			};
		}
		if (p.busy) {
			const kind =
				p.activeKind === 'monitor' || p.showMonitorForm
					? 'monitor'
					: p.activeKind === 'rclone' || p.showRcloneForm
						? 'rclone'
						: 'b2';
			const title = kind === 'monitor' ? 'Monitor' : kind === 'rclone' ? 'rclone' : 'B2';
			return {
				wrapTestId: `${kind}-connecting-${id}`,
				status: 'connecting',
				title,
				lines: ['Connecting…']
			};
		}
		if (p.activeKind === 'monitor') {
			const status = (monitorWatchStatus[id] ?? 'off') as ConnDotStatus;
			const chip = monitorChips.find((c) => c.id === p.activeId);
			return {
				wrapTestId: `monitor-remote-badge-${id}`,
				watchTestId: `monitor-watch-status-${id}`,
				status,
				title: chip?.name ? `Monitor · ${chip.name}` : 'Monitor',
				lines: ['Open-with off', `Watch · ${status}`]
			};
		}
		if (p.activeKind === 'b2') {
			const chip = b2Chips.find((c) => c.id === p.activeId);
			return {
				wrapTestId: `b2-remote-badge-${id}`,
				status: 'connected',
				title: chip?.name ? `B2 · ${chip.name}` : 'B2',
				lines: [...(chip?.detail ? [chip.detail] : []), 'Open-with off']
			};
		}
		if (p.activeKind === 'rclone') {
			const chip = rcloneChips.find((c) => c.id === p.activeId);
			return {
				wrapTestId: `rclone-remote-badge-${id}`,
				status: 'connected',
				title: chip?.name ? `rclone · ${chip.name}` : 'rclone',
				lines: [...(chip?.detail ? [chip.detail] : []), 'Open-with off']
			};
		}
		if (p.activeKind === 'disk') {
			return {
				wrapTestId: `disk-badge-${id}`,
				status: 'connected',
				title: 'This computer',
				lines: p.diskName ? [p.diskName] : []
			};
		}
		return null;
	}

	const showCopyAcross = $derived(dualPane);

	const visibleCopyItems = $derived(copyItems.filter((t) => !dismissedCopyIds.has(t.id)));
	const destCopyPending = $derived(
		stackTransferItems(visibleCopyItems)
			.filter((t) => t.hop && (!t.done || t.status === 'failed'))
			.map((t) => ({
				id: t.id,
				name: t.name,
				transferred: t.behind,
				size: t.size || Math.max(t.ahead, 1),
				ready: t.ahead,
				direction: 'receiving' as const,
				status: t.status,
				done: t.done,
				destParentId: copyDestParentId
			}))
	);

	function destDriverKey(drv: ExplorerDriver): string {
		return `${drv.id}:${drv.connectionId ?? drv.endpointKey ?? ''}`;
	}

	function markCopyDest(id: PaneId, drv: ExplorerDriver, parentId: ExplorerEntry['parentId']) {
		copyDestPane = id;
		copyDestDriverKey = destDriverKey(drv);
		copyDestParentId = parentId;
	}

	function panePending(id: PaneId) {
		const drv = activeDriver(paneState(id), id);
		const extra =
			id === copyDestPane && copyDestDriverKey != null && destDriverKey(drv) === copyDestDriverKey
				? destCopyPending
				: [];
		const base = id === 'left' ? pendingLeft : id === 'right' ? pendingRight : [];
		return extra.length ? [...base, ...extra] : base;
	}

	function dismissCopy(id: string) {
		abortTransfer(id);
		if (copyBusy) copyAbort?.abort();
		dismissedCopyIds = new Set([...dismissedCopyIds, id]);
	}

	function dismissAllSettledCopy() {
		const next = new Set(dismissedCopyIds);
		for (const t of copyItems) {
			if (t.done || t.status === 'failed' || t.status === 'cancelled') next.add(t.id);
		}
		dismissedCopyIds = next;
	}

	onMount(() => {
		const saved = loadFileWindows(dualPaneKey, leftDefault, rightDefault);
		if (saved) {
			windowRoot = saved.root;
			if (Object.keys(saved.windows).length > 0) {
				windows = saved.windows;
			}
			focusedId = saved.focusedId;
			targetPaneId = saved.targetPaneId;
		}
		onDualChange?.(dualPane);
		void reloadProfiles();
		const reloadOnTab = () => {
			void reloadProfiles();
		};
		const onVault = () => {
			void (async () => {
				await syncVaultFromIdb();
				await reloadProfiles();
				if ((await isVaultEnabled()) && !isVaultUnlocked()) {
					for (const paneId of Object.keys(windows)) {
						const cur = paneState(paneId);
						if (cur.activeKind !== 'b2' && cur.activeKind !== 'rclone') continue;
						releaseRemote(cur.activeKind, cur.activeId);
						setPane(paneId, {
							remoteDriver: null,
							activeId: 'local',
							activeKind: 'local',
							showB2Form: cur.activeKind === 'b2',
							showRcloneForm: cur.activeKind === 'rclone',
							error: 'Unlock the connection vault to use saved keys.',
							explorerKey: cur.explorerKey + 1
						});
					}
				}
			})();
		};
		const unsubs = [
			subscribeTabChannel(HUB_B2_PROFILES_CHANNEL, reloadOnTab),
			subscribeTabChannel(HUB_RCLONE_PROFILES_CHANNEL, reloadOnTab),
			subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, reloadOnTab),
			subscribeTabChannel(HUB_VAULT_CHANNEL, onVault),
			subscribeVaultSession(onVault)
		];
		profileTabUnsub = () => {
			for (const u of unsubs) u();
		};
		const mem = getMemoryVfs();
		memoryVfs = mem;
		void mem.ready().then(() => installMemoryFilesHook(mem));
		const pullCopy = () => {
			copyItems = listTransfers().filter((t) => t.direction === 'copying');
		};
		pullCopy();
		copyProgressUnsub = subscribeTransfers(pullCopy);
		window.addEventListener('pointermove', onWinPointerMove, { passive: true });
		window.addEventListener('pointerup', onWinPointerUp);
		window.addEventListener('pointercancel', onWinPointerUp);
	});

	onDestroy(() => {
		copyProgressUnsub?.();
		copyProgressUnsub = null;
		profileTabUnsub?.();
		profileTabUnsub = null;
		window.removeEventListener('pointermove', onWinPointerMove);
		window.removeEventListener('pointerup', onWinPointerUp);
		window.removeEventListener('pointercancel', onWinPointerUp);
		if (watchPollTimer) {
			clearInterval(watchPollTimer);
			watchPollTimer = null;
		}
		for (const id of Object.keys(windows)) {
			const p = paneState(id);
			dropDiskDriver(p);
			if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
				releaseRemote(p.activeKind, p.activeId);
			}
		}
	});

	function setDualPane(on: boolean) {
		onDualChange?.(on);
		try {
			localStorage.setItem(dualPaneKey, on ? '1' : '0');
		} catch {
			/* ignore */
		}
		if (on) {
			if (!windows['right']) {
				windows['right'] = emptyPane(rightDefault);
			}
			windowRoot = createFileWindowRoot(true);
		} else {
			windowRoot = createLeaf('left');
		}
	}

	async function connectB2(id: PaneId, profile: B2ConnectionProfileV1) {
		const p = paneState(id);
		const prevId = p.activeId !== 'local' && p.activeId !== 'memory' ? p.activeId : null;
		const prevKind = p.activeKind;
		dropDiskDriver(p);
		setPane(id, { busy: true, error: '', showRcloneForm: false, showMonitorForm: false });
		try {
			const applicationKey = await revealApplicationKey(profile);
			const driver = await acquireB2Driver({ ...profile, applicationKey });
			if (prevId && !(prevKind === 'b2' && prevId === profile.id)) {
				releaseRemote(prevKind, prevId);
			}
			void setActiveB2ProfileId(profile.id);
			setPane(id, {
				role: `b2:${profile.id}`,
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
			if (isVaultLockedError(e) || isSecretUnavailableError(e)) {
				showPaneError(id, formatExplorerError(e), { busy: false, showB2Form: true });
				return;
			}
			const mapped = mapB2Error(e);
			showPaneError(id, formatExplorerError(mapped), { busy: false, showB2Form: true });
		}
	}

	async function connectRclone(id: PaneId, profile: RcloneConnectionProfileV1) {
		const p = paneState(id);
		dropDiskDriver(p);
		const prevId = p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk' ? p.activeId : null;
		const prevKind = p.activeKind;
		setPane(id, { busy: true, error: '', showB2Form: false, showMonitorForm: false });
		try {
			const rcPass = await revealRcPass(profile);
			const driver = await acquireRcloneDriver({ ...profile, rcPass });
			if (prevId && !(prevKind === 'rclone' && prevId === profile.id)) {
				releaseRemote(prevKind, prevId);
			}
			void setActiveRcloneProfileId(profile.id);
			setPane(id, {
				role: `rclone:${profile.id}`,
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
			if (isVaultLockedError(e) || isSecretUnavailableError(e)) {
				showPaneError(id, formatExplorerError(e), { busy: false, showRcloneForm: true });
				return;
			}
			const mapped = mapRcloneError(e);
			showPaneError(id, formatExplorerError(mapped), { busy: false, showRcloneForm: true });
		}
	}

	function startWatchStatusPoll() {
		if (watchPollTimer) return;
		watchPollTimer = setInterval(() => {
			const next: Record<string, string> = {};
			for (const paneId of Object.keys(windows)) {
				const p = paneState(paneId);
				if (p.activeKind !== 'monitor' || !p.remoteDriver) continue;
				const d = p.remoteDriver as { getWatchStatus?: () => string };
				next[paneId] = d.getWatchStatus?.() ?? 'off';
			}
			monitorWatchStatus = next;
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
				role: `monitor:${profile.id}`,
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
			showPaneError(id, formatMonitorErrorMessage(mapped), {
				busy: false,
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
			showPaneError(
				id,
				'This browser cannot open a computer folder. Use Chrome or Edge, or upload individual files with Upload from device.'
			);
			return;
		}
		try {
			const handle = await pickDirectory();
			const driver = createDiskExplorerDriver(handle);
			await driver.ready();
			if (p.activeKind === 'disk') p.remoteDriver?.dispose?.();
			else if (p.activeId !== 'local' && p.activeId !== 'memory') {
				releaseRemote(p.activeKind, p.activeId);
			}
			setPane(id, {
				role: 'disk',
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
			showPaneError(
				id,
				e instanceof Error ? e.message : 'Could not open that folder'
			);
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
			role: 'memory',
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

	async function onSelectConnection(id: PaneId, selection: string) {
		const p = paneState(id);
		if (selection === 'local') {
			dropDiskDriver(p);
			if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
				releaseRemote(p.activeKind, p.activeId);
			}
			setPane(id, {
				role: 'local',
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
			await connectDisk(id, { replace: p.activeKind === 'disk' });
			return;
		}
		const selId = selection.startsWith('b2:')
			? selection.slice(3)
			: selection.startsWith('rclone:')
				? selection.slice(7)
				: selection.startsWith('monitor:')
					? selection.slice(8)
					: selection;

		if (p.activeId === selId && p.remoteDriver) return;

		const rclone = showRclone ? await getRcloneProfile(selId) : undefined;
		if (rclone) {
			await connectRclone(id, rclone);
			return;
		}
		const mon = showMonitor ? await getMonitorProfile(selId) : undefined;
		if (mon) {
			await connectMonitor(id, mon);
			return;
		}
		const b2 = await getB2Profile(selId);
		if (b2) {
			await connectB2(id, b2);
			return;
		}
		await reloadProfiles();
		showPaneError(id, 'That connection was removed. Pick another or add one in settings.', {
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
			setCrossWindowDrag({
				sourceDriver: activeDriver(p, id),
				sourceEntries: p.ctx.entries,
				selectedIds,
				sourceLabel: paneConnectionLabel(id)
			});
		} else {
			clearCrossWindowDrag();
		}
		if (!dualPane || !showCopyAcross) return;
		crossDragFrom = id;
		crossOver = null;
	}

	function paneCanImport(id: PaneId): boolean {
		const drv = activeDriver(paneState(id), id);
		return Boolean(drv.upload || drv.writeFile);
	}

	async function importOsDropToPane(
		id: PaneId,
		pending: Promise<OsDropNode[]>,
		destParentId?: string | null
	): Promise<void> {
		const p = paneState(id);
		const drv = activeDriver(p, id);
		if (!(drv.upload || drv.writeFile)) return;
		copyBusy = true;
		const parent = destParentId !== undefined ? destParentId : p.ctx.parentId;
		markCopyDest(id, drv, parent);
		const idByName = new Map<string, string>();
		const bump = (ev: OsDropFileProgress) => {
			let opId = idByName.get(ev.name);
			if (!opId) {
				opId = generateId('osdrop');
				idByName.set(ev.name, opId);
			}
			upsertProgress({
				id: opId,
				name: ev.name,
				size: ev.size,
				transferred: ev.transferred,
				direction: 'copying',
				done: ev.done,
				status: ev.done ? 'done' : 'active'
			});
		};
		try {
			const nodes = await pending;
			if (!nodes.length) return;
			await importOsDropToDriver(drv, parent, nodes, { onFile: bump });
			if (!drv.subscribeChanges) {
				setPane(id, { explorerKey: p.explorerKey + 1 });
			}
		} catch (e) {
			toast.error(formatExplorerError(e));
		} finally {
			copyBusy = false;
		}
	}

	function onPaneDragOver(id: PaneId, e: DragEvent) {
		if (dataTransferHasOsFiles(e.dataTransfer) && paneCanImport(id) && !crossDragFrom) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			osDropPane = id;
			return;
		}
		if (crossDragFrom && crossDragFrom !== id) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			crossOver = id;
			return;
		}
		if (
			!crossDragFrom &&
			dataTransferHasExplorerIds(e.dataTransfer) &&
			getCrossWindowDrag()
		) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			crossOver = id;
			return;
		}
	}

	function onPaneDragLeave(id: PaneId, e: DragEvent) {
		const next = e.relatedTarget;
		if (next instanceof Node && (e.currentTarget as Node).contains(next)) return;
		if (crossOver === id) crossOver = null;
		if (osDropPane === id) osDropPane = null;
	}

	function onPaneDragEnd() {
		crossDragFrom = null;
		crossOver = null;
		osDropPane = null;
		clearCrossWindowDrag();
		setPointerDragActive(false);
	}

	function onPanePointerDragBegin(id: PaneId, e: Event) {
		const detail = (e as CustomEvent<{ ids?: string[] }>).detail;
		const p = paneState(id);
		const selectedIds = detail?.ids?.length ? detail.ids : p.ctx.selectedIds;
		if (selectedIds.length) {
			onExplorerDrag?.({
				paneId: id,
				driver: activeDriver(p, id),
				selectedIds,
				entries: p.ctx.entries
			});
			setCrossWindowDrag({
				sourceDriver: activeDriver(p, id),
				sourceEntries: p.ctx.entries,
				selectedIds,
				sourceLabel: paneConnectionLabel(id)
			});
		}
		if (!dualPane || !showCopyAcross) return;
		crossDragFrom = id;
		crossOver = null;
	}

	function hitFromPoint(clientX: number, clientY: number): Element | null {
		const el =
			typeof document !== 'undefined' ? document.elementFromPoint(clientX, clientY) : null;
		return el instanceof Element ? el : null;
	}

	function paneElFromHit(hit: Element | null): HTMLElement | null {
		if (!hit) return null;
		const paneEl = hit.closest('[data-pane]');
		return paneEl instanceof HTMLElement ? paneEl : null;
	}

	function onWinPointerMove(e: PointerEvent) {
		if (!isPointerDragActive()) return;
		const paneEl = paneElFromHit(hitFromPoint(e.clientX, e.clientY));
		if (!paneEl || !dualRootEl?.contains(paneEl)) {
			if (crossOver) crossOver = null;
			return;
		}
		const id = paneEl.getAttribute('data-pane') as PaneId | null;
		if (!id) {
			crossOver = null;
			return;
		}
		if (crossDragFrom && id !== crossDragFrom) crossOver = id;
		else if (!crossDragFrom && getCrossWindowDrag()) crossOver = id;
		else crossOver = null;
	}

	async function onWinPointerUp(e: PointerEvent) {
		if (!isPointerDragActive()) return;
		const hit = hitFromPoint(e.clientX, e.clientY);
		const paneEl = paneElFromHit(hit);
		const ours = Boolean(paneEl && dualRootEl?.contains(paneEl));

		if (ours && paneEl) {
			const id = paneEl.getAttribute('data-pane') as PaneId | null;
			if (id && crossDragFrom && id !== crossDragFrom) {
				const from = crossDragFrom;
				const dst = paneState(id);
				const destParentId = destParentFromDropEvent({ target: hit }, dst.ctx.parentId);
				const selectedIds =
					getCrossWindowDrag()?.selectedIds ?? paneState(from).ctx.selectedIds;
				onPaneDragEnd();
				await runCopyAcross(from, { selectedIds, destParentId });
				return;
			}
			if (id && !crossDragFrom) {
				const crossDrag = getCrossWindowDrag();
				if (crossDrag) {
					const dst = paneState(id);
					const destParentId = destParentFromDropEvent({ target: hit }, dst.ctx.parentId);
					onPaneDragEnd();
					await runCrossInstanceCopy(
						crossDrag.sourceDriver,
						crossDrag.sourceEntries,
						crossDrag.selectedIds,
						id,
						destParentId,
						crossDrag.sourceLabel
					);
					return;
				}
			}
			onPaneDragEnd();
			return;
		}

		if (crossDragFrom) {
			const anyBody =
				typeof document !== 'undefined'
					? document.elementFromPoint(e.clientX, e.clientY)?.closest('.files-body')
					: null;
			if (anyBody && anyBody !== dualRootEl) return;
			onPaneDragEnd();
		}
	}

	async function onPaneDrop(id: PaneId, e: DragEvent) {
		if (dataTransferHasOsFiles(e.dataTransfer) && paneCanImport(id) && !crossDragFrom) {
			e.preventDefault();
			e.stopPropagation();
			const destParentId = destParentFromDropEvent(e, paneState(id).ctx.parentId);
			const pending = collectOsDrop(e.dataTransfer);
			onPaneDragEnd();
			await importOsDropToPane(id, pending, destParentId);
			return;
		}
		if (crossDragFrom && crossDragFrom !== id) {
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
			return;
		}
		const crossDrag = !crossDragFrom ? getCrossWindowDrag() : null;
		if (crossDrag && dataTransferHasExplorerIds(e.dataTransfer)) {
			e.preventDefault();
			e.stopPropagation();
			const dst = paneState(id);
			const dragged = idsFromExplorerDataTransfer(e.dataTransfer);
			const selectedIds = dragged.length ? dragged : crossDrag.selectedIds;
			const destParentId = destParentFromDropEvent(e, dst.ctx.parentId);
			onPaneDragEnd();
			await runCrossInstanceCopy(
				crossDrag.sourceDriver,
				crossDrag.sourceEntries,
				selectedIds,
				id,
				destParentId,
				crossDrag.sourceLabel
			);
			return;
		}
		onPaneDragEnd();
	}

	function copyHints(id: PaneId): {
		copyOut: ReturnType<typeof describeCopyAcrossPath> | null;
		copyIn: ReturnType<typeof describeCopyAcrossPath> | null;
		copyOtherLabel: string;
		copyIdleNote: string | null;
	} {
		const leaves = listLeaves(windowRoot);
		if (leaves.length <= 1) {
			return {
				copyOut: null,
				copyIn: null,
				copyOtherLabel: '',
				copyIdleNote: 'Open another window to copy between locations.'
			};
		}
		const otherLeaf = leaves.find((l) => l.id !== id) ?? leaves[0]!;
		const otherId: PaneId = otherLeaf.id;
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

	function pairSide(id: PaneId): {
		side: string;
		label: string;
		kind: string;
		capabilities: import('./explorerDriver.js').ExplorerCapabilities;
	} {
		const p = paneState(id);
		const drv = activeDriver(p, id);
		const kind =
			id === 'right' && overrideRight ? overrideRight.driver.id : p.activeKind;
		return {
			side: id === 'left' ? 'Left' : id === 'right' ? 'Right' : id,
			label: paneConnectionLabel(id),
			kind,
			capabilities: drv.capabilities
		};
	}

	const pairCopy = $derived.by(() => copyHints(targetPaneId));

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
		opts?: { selectedIds?: string[]; destParentId?: string | null; destId?: PaneId }
	) {
		const leaves = listLeaves(windowRoot);
		if (leaves.length <= 1) return;
		const src = paneState(from);
		let destId: PaneId = opts?.destId ?? (targetPaneId !== from ? targetPaneId : (leaves.find((l) => l.id !== from)?.id ?? 'left'));
		const dst = paneState(destId);
		const sourceDriver = activeDriver(src, from);
		const destDriver = activeDriver(dst, destId);
		const sourceLabel = paneConnectionLabel(from);
		const destLabel = paneConnectionLabel(destId);
		if (classify(sourceDriver, destDriver).kind === 'dual-phase') {
			const ok = await askDualPhase(sourceLabel, destLabel);
			if (!ok) return;
		}
		copyAbort?.abort();
		copyAbort = new AbortController();
		const signal = copyAbort.signal;
		copyBusy = true;
		const destParent = opts?.destParentId !== undefined ? opts.destParentId : dst.ctx.parentId;
		markCopyDest(destId, destDriver, destParent);
		try {
			const n = await copyAcross({
				sourceDriver: activeDriver(src, from),
				destDriver,
				selectedIds: opts?.selectedIds ?? src.ctx.selectedIds,
				sourceEntries: src.ctx.entries,
				destParentId: destParent,
				confirmDualPhase: () => askDualPhase(sourceLabel, destLabel),
				signal
			});
			if (!destDriver.subscribeChanges) {
				setPane(destId, {
					explorerKey: dst.explorerKey + 1
				});
			}
			if (n === 0) toast.info('Nothing copied');
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') toast.info('Copy cancelled');
			else if (e instanceof CopyAcrossError) toast.error(e.message);
			else toast.error(formatExplorerError(e));
			if (!destDriver.subscribeChanges) {
				setPane(destId, { explorerKey: dst.explorerKey + 1 });
			}
		} finally {
			if (copyAbort?.signal === signal) copyAbort = null;
			copyBusy = false;
		}
	}

	async function runCrossInstanceCopy(
		sourceDriver: ExplorerDriver,
		sourceEntries: ExplorerEntry[],
		selectedIds: string[],
		destId: PaneId,
		destParentId: string | null,
		sourceLabel?: string
	) {
		const dst = paneState(destId);
		const destDriver = activeDriver(dst, destId);
		const srcLabel = sourceLabel || sourceDriver.id;
		const destLabel = paneConnectionLabel(destId);
		if (classify(sourceDriver, destDriver).kind === 'dual-phase') {
			const ok = await askDualPhase(srcLabel, destLabel);
			if (!ok) return;
		}
		copyAbort?.abort();
		copyAbort = new AbortController();
		const signal = copyAbort.signal;
		copyBusy = true;
		markCopyDest(destId, destDriver, destParentId);
		try {
			const n = await copyAcross({
				sourceDriver,
				destDriver,
				selectedIds,
				sourceEntries,
				destParentId,
				confirmDualPhase: () => askDualPhase(srcLabel, destLabel),
				signal
			});
			if (!destDriver.subscribeChanges) {
				setPane(destId, {
					explorerKey: dst.explorerKey + 1
				});
			}
			if (n === 0) toast.info('Nothing copied');
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') toast.info('Copy cancelled');
			else if (e instanceof CopyAcrossError) toast.error(e.message);
			else toast.error(formatExplorerError(e));
			if (!destDriver.subscribeChanges) {
				setPane(destId, { explorerKey: dst.explorerKey + 1 });
			}
		} finally {
			if (copyAbort?.signal === signal) copyAbort = null;
			copyBusy = false;
		}
	}

	async function handleClipboardCopyAcross(
		payload: {
			mode: 'copy' | 'cut';
			sourceDriverId?: string;
			sourceConnectionId?: string;
			sourceParentId?: string | null;
			ids: string[];
			entries?: ExplorerEntry[];
		},
		destPaneId: string,
		destParentId: string | null
	) {
		const dst = paneState(destPaneId);
		const destDriver = activeDriver(dst, destPaneId);

		let srcDriver: ExplorerDriver | null = null;
		for (const [id, w] of Object.entries(windows)) {
			const drv = activeDriver(w, id);
			if (drv.id === payload.sourceDriverId && (drv.connectionId ?? '') === (payload.sourceConnectionId ?? '')) {
				srcDriver = drv;
				break;
			}
		}
		if (!srcDriver) {
			if (payload.sourceDriverId === 'memory') srcDriver = getMemoryDriver();
			else srcDriver = localDriver;
		}

		const entries: ExplorerEntry[] = payload.entries && payload.entries.length
			? payload.entries
			: payload.ids.map((id) => ({ id, name: id, kind: 'file' as const, parentId: null }));

		copyBusy = true;
		markCopyDest(destPaneId, destDriver, destParentId);
		try {
			await copyAcross({
				sourceDriver: srcDriver,
				destDriver,
				selectedIds: payload.ids,
				sourceEntries: entries,
				destParentId,
				confirmDualPhase: () => askDualPhase(srcDriver?.id ?? 'source', paneConnectionLabel(destPaneId))
			});
			if (payload.mode === 'cut' && srcDriver && srcDriver.delete) {
				for (const id of payload.ids) {
					try {
						await srcDriver.delete(id);
					} catch {
						/* ignore */
					}
				}
			}
			if (!destDriver.subscribeChanges) {
				setPane(destPaneId, { explorerKey: dst.explorerKey + 1 });
			}
			toast.success(`Pasted ${payload.ids.length} item${payload.ids.length === 1 ? '' : 's'}`);
		} catch (e) {
			toast.error(formatExplorerError(e));
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
		sendBusy = true;
		try {
			await onSend({
				paneId: id,
				driver: activeDriver(p, id),
				selectedIds,
				entries
			});
			setPane(id, { explorerKey: p.explorerKey + 1 });
		} catch (e) {
			toast.error(formatExplorerError(e));
		} finally {
			sendBusy = false;
		}
	}

	export function refreshPane(id: PaneId) {
		const p = paneState(id);
		setPane(id, { explorerKey: p.explorerKey + 1 });
	}

	function inherit(source: PaneState | undefined, role: string): PaneState {
		const kind = role.startsWith('b2:')
			? 'b2'
			: role.startsWith('rclone:')
				? 'rclone'
				: role.startsWith('monitor:')
					? 'monitor'
					: (role as ConnectionKind);
		const next = emptyFileWindowState(kind, role);
		if (role.startsWith('b2:') || role.startsWith('rclone:') || role.startsWith('monitor:')) {
			next.activeId = role.split(':')[1] || 'local';
		}
		return next;
	}

	function onSelectRole(leafId: string, role: string): boolean | void {
		void onSelectConnection(leafId, role);
	}

	function onAfterClose(leafId: string) {
		const p = paneState(leafId);
		dropDiskDriver(p);
		if (p.activeId !== 'local' && p.activeId !== 'memory' && p.activeId !== 'disk') {
			releaseRemote(p.activeKind, p.activeId);
		}
		targetPaneId = resolveTargetFilePaneId(windows, focusedId, targetPaneId);
	}

</script>

{#snippet paneSwitcher(id: PaneId)}
	{@const p = paneState(id)}
	{@const drv = activeDriver(p, id)}
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
		showSettings={!hostSettings && !hideSettingsGear}
		showInfo={!pairInfoInChrome}
		busy={p.busy}
		onSelect={(sel) => onSelectConnection(id, sel)}
		onConfigure={() => (showRemoteManager = true)}
	/>
{/snippet}

{#snippet copyAcrossAction(id: PaneId, variant: 'icon' | 'label')}
	{@const p = paneState(id)}
	{#if showCopyAcross}
		{#if variant === 'label'}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-file-preview-copy-across"
				disabled={copyBusy || p.ctx.selectedIds.length === 0}
				onclick={() => runCopyAcross(id)}
			>
				{copyBusy ? 'Copying…' : 'Copy across'}
			</button>
		{:else}
			<FeTipIconBtn
				testid={tids.copyAcross(id)}
				tip={copyBusy ? 'Copying…' : 'Copy across'}
				icon="arrow-left-right"
				disabled={copyBusy || p.ctx.selectedIds.length === 0}
				onclick={() => runCopyAcross(id)}
			/>
		{/if}
	{/if}
{/snippet}

{#snippet explorerPane(id: PaneId)}
	{@const p = paneState(id)}
	{@const drv = activeDriver(p, id)}
	{@const hostTid = tids.explorerHost(id)}
	{@const subTid = tids.paneSub(id)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="files-pane"
		class:is-target={id === targetPaneId}
		class:drop-target={crossOver === id || osDropPane === id}
		data-testid={tids.pane(id)}
		data-pane={id}
		data-fe-target={id === targetPaneId ? 'true' : 'false'}
		ondragstart={(e) => onPaneDragStart(id, e)}
		ondragover={(e) => onPaneDragOver(id, e)}
		ondragleave={(e) => onPaneDragLeave(id, e)}
		ondrop={(e) => void onPaneDrop(id, e)}
		ondragend={onPaneDragEnd}
		onfeexplorerdragbegin={(e) => onPanePointerDragBegin(id, e)}
		onfeexplorerdragend={onPaneDragEnd}
		onclick={() => {
			targetPaneId = id;
		}}
		onpointerdown={() => {
			targetPaneId = id;
		}}
	>
		{#if !hostSettings && (onSend || subTid)}
			<div class="pane-chrome" data-testid={tids.paneChrome(id)}>
				{#if onSend}
					<FeTipIconBtn
						testid={tids.send(id)}
						tip={sendBusy ? 'Sending…' : 'Send'}
						icon="send"
						disabled={sendBusy || p.ctx.selectedIds.length === 0 || !drv.download}
						onclick={() => runSend(id)}
					/>
				{/if}
				{#if subTid}
					<span class="pane-sub" data-testid={subTid.testid}>{subTid.text}</span>
				{/if}
			</div>
		{/if}
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
						const cur = paneState(id);
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
						const cur = paneState(id);
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
						const cur = paneState(id);
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
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
						{onClose}
						driver={overrideRight.driver}
						showPersistence={false}
						initialParentId={p.ctx.parentId}
						onOpen={paneOnOpen('peer')}
						onOpenProject={paneOpenProject(id)}
						pending={panePending(id)}
						isTarget={id === targetPaneId}
						onCopyAcrossFromClipboard={(payload, destParent) =>
							handleClipboardCopyAcross(payload, id, destParent)}
						onContextChange={(ctx) => applyPaneCtx(id, ctx)}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra({ variant }: { variant: 'icon' | 'label' })}
							{@render copyAcrossAction(id, variant)}
						{/snippet}
					</FileExplorer>
				{:else if p.activeKind === 'local'}
					<FileExplorer
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
						{onClose}
						driver={localDriver}
						showPersistence={false}
						initialParentId={p.ctx.parentId}
						onOpen={paneFileOpen(id)}
						onOpenProject={paneOpenProject(id)}
						onInitProject={paneInitProject(id)}
						{projectMarker}
						onSendFile={
							onSend
								? (entry) =>
										runSend(id, {
											selectedIds: [entry.id],
											entries: sendTargetEntries(id, entry)
										})
								: undefined
						}
						pending={panePending(id)}
						isTarget={id === targetPaneId}
						onCopyAcrossFromClipboard={(payload, destParent) =>
							handleClipboardCopyAcross(payload, id, destParent)}
						onContextChange={(ctx) => applyPaneCtx(id, ctx)}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra({ variant }: { variant: 'icon' | 'label' })}
							{@render copyAcrossAction(id, variant)}
						{/snippet}
					</FileExplorer>
				{:else}
					<FileExplorer
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
						{onClose}
						driver={drv}
						showPersistence={false}
						initialParentId={p.ctx.parentId}
						onOpen={paneFileOpen(id) ?? paneOnOpen(p.activeKind)}
						onOpenProject={paneOpenProject(id)}
						onSendFile={
							onSend
								? (entry) =>
										runSend(id, {
											selectedIds: [entry.id],
											entries: sendTargetEntries(id, entry)
										})
								: undefined
						}
						pending={panePending(id)}
						isTarget={id === targetPaneId}
						onCopyAcrossFromClipboard={(payload, destParent) =>
							handleClipboardCopyAcross(payload, id, destParent)}
						onContextChange={(ctx) => applyPaneCtx(id, ctx)}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra({ variant }: { variant: 'icon' | 'label' })}
							{@render copyAcrossAction(id, variant)}
						{/snippet}
					</FileExplorer>
				{/if}
			{/key}
		</div>
	</div>
{/snippet}

{#snippet paneConnStatus(id: PaneId)}
	{@const info = paneConnDot(id)}
	{#if info}
		<div
			class="conn-status"
			data-testid={info.wrapTestId}
			aria-label="{info.title}: {info.lines.join(', ')}"
		>
			{#if info.watchTestId}
				<span
					class="conn-status-dot"
					data-testid={info.watchTestId}
					data-status={info.status}
				></span>
			{:else}
				<span class="conn-status-dot" data-status={info.status}></span>
			{/if}
			<div class="conn-status-tip" role="tooltip">
				<p class="conn-status-title">{info.title}</p>
				{#each info.lines as line}
					<p>{line}</p>
				{/each}
			</div>
		</div>
	{/if}
{/snippet}

{#snippet paneConn(id: PaneId)}
	{@const showSwitcher = paneShowsSwitcher(id) && !(id === 'right' && overrideRight)}
	{@const showStatus = paneConnDot(id) != null}
	{#if showSwitcher || showStatus}
		<div
			class="dpe-pane-conn"
			data-testid="conn-switcher-{id}"
			data-pane={id}
			aria-label="{id} pane connection"
		>
			{#if showSwitcher}
				{@render paneSwitcher(id)}
			{/if}
			{#if showStatus}
				{@render paneConnStatus(id)}
			{/if}
		</div>
	{/if}
{/snippet}

{#if !hideToggles}
	<div
		class="dpe-layout-cluster"
		class:portaled={Boolean(layoutPortal)}
		use:portalLayoutCluster
	>
		<AppWindowsButton
			bind:editing={windowEditOpen}
			testid="fe-windows-btn"
		/>
		{#if pairInfoInChrome}
			<ConnectionPairInfo
				left={pairSide('left')}
				right={dualPane ? pairSide(targetPaneId !== 'left' ? targetPaneId : 'right') : null}
				copyOut={pairCopy.copyOut}
				copyIn={pairCopy.copyIn}
				idleNote={pairCopy.copyIdleNote}
			/>
		{/if}
		<CopyProgressHeader
			items={visibleCopyItems}
			onDismiss={dismissCopy}
			onDismissAll={dismissAllSettledCopy}
		/>
	</div>
{/if}

{#if hostSettings}
	<div class="dpe-host-settings-park" class:parked={Boolean(settingsPortal)}>
		<div class="dpe-host-settings" use:portal={settingsPortal}>
			<ConnectionSwitcher
				variant="settings"
				profiles={b2Chips}
				rcloneProfiles={rcloneChips}
				monitorProfiles={monitorChips}
				showRclone={showRclone}
				showMonitor={showMonitor}
				showInfo={false}
				onConfigure={() => (showRemoteManager = true)}
			/>
		</div>
	</div>
{/if}

{#if showRemoteManager}
	<RemoteConnectionsDialog
		onClose={() => (showRemoteManager = false)}
		onConnected={onRemoteConnected}
		onDisconnected={onRemoteDisconnected}
	/>
{/if}

<div class="dpe-shell" class:dual={dualPane} bind:this={dualRootEl}>
	<div class="files-body" data-testid={tids.body}>
		<AppWindows
			bind:root={windowRoot}
			bind:windows
			bind:focusedId
			bind:editing={windowEditOpen}
			layoutId="files"
			testid={tids.body}
			testidPrefix="files-window"
			hostClass="files-app-windows"
			roles={availableRoleDefs}
			fallbackRole="local"
			{inherit}
			{onSelectRole}
			onFocus={(id) => {
				targetPaneId = id;
			}}
			{onAfterClose}
			leafClass={(id) => (id === targetPaneId ? 'files-pane-slot is-target' : 'files-pane-slot')}
			leafProps={(id) => ({
				'data-fe-target': id === targetPaneId ? 'true' : 'false',
				'data-pane': id
			})}
		>
			{#snippet leafChrome({ id })}
				{#if id === targetPaneId && !windowEditOpen && leafCount(windowRoot) > 1}
					<div class="fe-target-chip" data-testid="files-window-target">Target</div>
				{/if}
			{/snippet}
			{#snippet pane({ id })}
				{@render explorerPane(id)}
			{/snippet}
		</AppWindows>
	</div>
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
	.dpe-pane-conn {
		min-width: 0;
		max-width: 100%;
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.conn-status {
		position: relative;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.45rem;
		height: 1.45rem;
		cursor: help;
	}
	.conn-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-muted);
	}
	.conn-status-dot[data-status='subscribed'],
	.conn-status-dot[data-status='connected'] {
		background: var(--accent-emerald);
	}
	.conn-status-dot[data-status='connecting'],
	.conn-status-dot[data-status='resync'] {
		background: var(--accent-amber);
	}
	.conn-status-dot[data-status='error'] {
		background: var(--danger);
	}
	.conn-status-tip {
		display: none;
		position: absolute;
		z-index: 45;
		top: calc(100% + 6px);
		left: 0;
		min-width: 10rem;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
		font-size: 0.78rem;
		line-height: 1.35;
		white-space: nowrap;
	}
	.conn-status-title {
		margin: 0 0 0.15rem;
		font-weight: 700;
		font-size: 0.82rem;
	}
	.conn-status-tip p {
		margin: 0;
	}
	.conn-status:hover .conn-status-tip,
	.conn-status:focus-within .conn-status-tip {
		display: block;
	}
	.dpe-layout-cluster {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.dpe-layout-cluster :global(.dpe-copy-chip) {
		flex: 0 1 16rem;
		min-width: 9rem;
	}
	.dpe-host-settings-park.parked {
		position: absolute;
		width: 0;
		height: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.dpe-host-settings {
		display: flex;
		align-items: center;
		margin-left: auto;
	}
	.dpe-shell {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		gap: 0;
		width: 100%;
		height: 100%;
	}
	.dpe-layout-cluster {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		visibility: hidden;
	}
	.dpe-layout-cluster:global(.in-overlay),
	.dpe-layout-cluster:global(.in-chrome),
	.dpe-layout-cluster:global(.portaled) {
		visibility: visible;
	}
	.dpe-layout-cluster:global(.in-overlay) {
		position: absolute;
		top: calc(12px + env(safe-area-inset-top, 0px));
		left: calc(12px + env(safe-area-inset-left, 0px));
		z-index: var(--z-popover, 40);
	}
	.dpe-layout-cluster:global(.in-chrome) {
		position: relative;
		z-index: 3;
		height: 100%;
		gap: 4px;
	}
	.dpe-layout-opt {
		padding: 0 0.65rem;
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.b2-error {
		margin: 0;
		padding: 0.4rem 0.65rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.85rem;
	}
	.pane-sub {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.files-body {
		flex: 1;
		min-height: 0;
		width: 100%;
		height: 100%;
		border: 0;
		border-radius: 0;
		overflow: hidden;
		background: var(--surface-1);
		display: flex;
	}
	.files-body :global(.files-app-windows) {
		flex: 1 1 0;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	.files-pane-slot {
		min-width: 0;
		min-height: 0;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.files-pane-slot.is-target :global(.fe-root) {
		border-color: var(--accent, #3b82f6);
	}
	.files-pane {
		min-width: 0;
		min-height: 0;
		flex: 1 1 0;
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.files-pane.drop-target {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		background: var(--accent-glow);
	}
	.pane-chrome {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.65rem;
		border-bottom: 1px solid var(--line-hairline);
	}
	.pane-form {
		display: contents;
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
		min-height: 0;
		max-height: none;
		border: none;
		border-radius: 0;
	}
	.fe-target-chip {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 10;
		padding: 2px 8px;
		border-radius: 0 0 0 var(--radius-sm);
		background: var(--accent-glow);
		color: var(--accent);
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		pointer-events: none;
	}
	:global(.files-app-windows:not(.editing) .aw-leaf.is-target) {
		box-shadow: inset 0 0 0 1px var(--accent);
	}
</style>
