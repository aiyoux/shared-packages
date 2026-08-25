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
	 *   - `onOpen`: optional open-file handler (hub opens skch/ob3d/vrec/kb).
	 *     DualPane forwards pane `OpenProjectContext` so monitor `.kb` can
	 *     start collab. B2/rclone stay open-with off.
	 *   - `onOpenProject`: optional "Open project" handler. DualPane wraps each
	 *     pane's FileExplorer so the handler receives the folder plus
	 *     `OpenProjectContext` (`kind` from the pane; monitor also gets
	 *     profileId / baseUrl / rootPath). Unlike `onOpen`, which is still
	 *     memory-only on the remote branch, this is forwarded to every backend.
	 *   - `persistenceVfs`: unused for UI (kept so existing callers compile).
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
	import { default as FileExplorer, type ExplorerContext, type ExplorerMode } from './FileExplorer.svelte';
	import type { FileTypeId } from '../types.js';
	import CopyProgressHeader from './CopyProgressHeader.svelte';
	import DualPhaseConfirm from './DualPhaseConfirm.svelte';
	import { stackTransferItems } from './stackProgress.js';
	import {
		listTransfers,
		subscribeTransfers,
		upsertProgress,
		type TransferItem
	} from '../transferRegistry.js';
	import { generateId } from '../id.js';
	import {
		type ExplorerDriver,
		type ExplorerEntry,
		type ExplorerOpenContext,
		type ExplorerOpenTarget,
		type OpenProjectContext
	} from './explorerDriver.js';
	import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
	// PaneId + DualPaneTids live in a .ts module so the ui barrel can re-export
	// them without the *.svelte named-export limitation.
	import { type PaneId, type DualPaneTids } from './dualPaneTypes.js';
	import { portal } from './portal.js';
	import FeTipIconBtn from './FeTipIconBtn.svelte';
	import ConnectionPairInfo from './ConnectionPairInfo.svelte';
	import { SplitHandle, toast } from '@shared-packages/ui';
	import '@shared-packages/design-system/button.css';
	import '@shared-packages/design-system/tooltip.css';
	import '@shared-packages/design-system/segmented.css';
	import {
		canShowCopyAcross,
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
	import RemoteConnectionsDialog, { type RemoteKind } from './RemoteConnectionsDialog.svelte';
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
		onOpen?: (entry: ExplorerOpenTarget, ctx?: ExplorerOpenContext) => void | Promise<void>;
		/** Forward `onOpen` to B2 / monitor / disk / rclone panes. Hub Files keeps this off. */
		openRemotes?: boolean;
		accept?: FileTypeId[];
		hideIncompatible?: boolean;
		openLabel?: string;
		explorerMode?: ExplorerMode;
		onOpenProject?: (entry: ExplorerOpenTarget, ctx: OpenProjectContext) => void | Promise<void>;
		persistenceVfs?: VfsService;
		dualPaneKey?: string;
		dualPaneDefault?: boolean;
		memoryScope?: string;
		/** Default backend for each pane on first mount. */
		leftDefault?: ConnectionKind;
		rightDefault?: ConnectionKind;
		/** Hide the dual-pane / feature toggles row (e.g. CM is always dual). */
		hideToggles?: boolean;
		/** @deprecated pane Left/Right labels are gone. Kept so existing callers compile. */
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
		/**
		 * CSS selector for a single module settings gear. When set, pane
		 * switchers hide their gears and one settings control is portaled here.
		 */
		settingsPortal?: string;
		/** Hide the connection-settings gear (workspace hosts it on the Apps overlay). */
		hideSettingsGear?: boolean;
		/**
		 * @deprecated Switchers live in each FileExplorer header. Kept so
		 * existing callers compile; ignored at runtime.
		 */
		switcherPortal?: string;
		/**
		 * CSS selector for the single/dual layout switcher. Files injects into
		 * the pane chrome (workspace) or hub topbar (fullscreen /tools/files).
		 * When empty, the switcher stays in this component's own controls row.
		 */
		layoutPortal?: string;
	};

	let {
		localDriver,
		onOpen,
		openRemotes = false,
		accept,
		hideIncompatible = false,
		openLabel,
		explorerMode = 'manage',
		onOpenProject,
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
	/** Combined (i) sits next to Single/Dual. Pane switchers hide their own (i). */
	const pairInfoInChrome = $derived(!hideToggles);
	let showRemoteManager = $state(false);

	function onRemoteConnected(kind: RemoteKind, profile: object) {
		showRemoteManager = false;
		if (kind === 'b2') void connectB2('left', profile as B2ConnectionProfileV1);
		else if (kind === 'rclone') void connectRclone('left', profile as RcloneConnectionProfileV1);
		else void connectMonitor('left', profile as MonitorConnectionProfileV1);
	}

	function onRemoteDisconnected(kind: RemoteKind) {
		for (const paneId of ['left', 'right'] as PaneId[]) {
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

	// svelte-ignore state_referenced_locally -- test-id overrides are fixed for
	// the lifetime of the component; they are not meant to react.
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
			ctx: emptyCtx(kind)
		};
	}

	// svelte-ignore state_referenced_locally -- `default` props, by contract:
	// they seed the panes once and are not meant to track later changes.
	let left = $state<PaneState>(emptyPane(leftDefault));
	// svelte-ignore state_referenced_locally
	let right = $state<PaneState>(emptyPane(rightDefault));
	let dualPane = $state(false);
	/** Left pane share of dual-mode width (same clamp as window-manager splits). */
	let dualRatio = $state(0.5);
	const dualRatioKey = $derived(`${dualPaneKey}:ratio`);
	const MIN_DUAL_RATIO = 0.15;
	const MAX_DUAL_RATIO = 0.85;

	function clampDualRatio(n: number): number {
		if (!Number.isFinite(n)) return 0.5;
		return Math.min(MAX_DUAL_RATIO, Math.max(MIN_DUAL_RATIO, n));
	}

	function persistDualRatio(n: number) {
		try {
			localStorage.setItem(dualRatioKey, String(n));
		} catch {
			/* ignore */
		}
	}

	function onDualRatioDelta(delta: number) {
		dualRatio = clampDualRatio(dualRatio + delta);
		persistDualRatio(dualRatio);
	}

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
	/** Live watch status per pane (from monitor driver). */
	let monitorWatchStatus = $state<Record<string, string>>({});
	let watchPollTimer: ReturnType<typeof setInterval> | null = null;
	let copyBusy = $state(false);
	/** Pane a FileExplorer row drag started in (cross-pane copy). */
	let crossDragFrom = $state<PaneId | null>(null);
	let crossOver = $state<PaneId | null>(null);
	let sendBusy = $state(false);
	/** Dest pane of the in-flight copy-across (pending rows land here). */
	let copyDestPane = $state<PaneId | null>(null);
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

	function paneState(id: PaneId): PaneState {
		return id === 'left' ? left : right;
	}

	/**
	 * `onSendFile` hands back an open-target, which is thinner than the list row
	 * — no `parentId`, no `contentType`. Recover the full row from the pane so
	 * `onSend` consumers get the mime type they read off it.
	 */
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
	/** FileExplorer stays `(entry) => …`; DualPane attaches pane context here. */
	function paneOpenProject(id: PaneId) {
		if (!onOpenProject) return undefined;
		return (entry: ExplorerOpenTarget) => onOpenProject(entry, paneOpenProjectContext(id));
	}
	function paneFileOpen(id: PaneId) {
		if (!onOpen) return undefined;
		const kind = paneState(id).activeKind;
		if (kind !== 'local' && kind !== 'memory' && kind !== 'monitor') return undefined;
		return (entry: ExplorerOpenTarget) => onOpen(entry, paneOpenProjectContext(id));
	}
	function setPane(id: PaneId, patch: Partial<PaneState>) {
		if (id === 'left') left = { ...left, ...patch };
		else right = { ...right, ...patch };
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
				direction: 'receiving' as const,
				status: t.status,
				done: t.done
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
		try {
			const storedRatio = localStorage.getItem(dualRatioKey);
			if (storedRatio != null) dualRatio = clampDualRatio(Number(storedRatio));
		} catch {
			/* keep default */
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
					for (const paneId of ['left', 'right'] as PaneId[]) {
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
			await connectDisk(id, { replace: p.activeKind === 'disk' });
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
			// Register a cross-instance drag session so another
			// DualPaneExplorer in a different workspace pane (same document)
			// can accept this as a copy-across drop even in single-pane mode.
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
		copyDestPane = id;
		const parent = destParentId !== undefined ? destParentId : p.ctx.parentId;
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
		// Same-instance cross-pane drag (dual-pane mode).
		if (crossDragFrom && crossDragFrom !== id) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			crossOver = id;
			return;
		}
		// Cross-instance drag: another DualPaneExplorer in a different
		// workspace pane started this drag. Accept even in single-pane mode.
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
		// HTML5 mouse drags also fire pointerup; ignore unless FileExplorer is
		// driving a touch/pen session (otherwise we steal the native drop).
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
		// Same-instance cross-pane copy (dual-pane mode).
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
		// Cross-instance copy: drag from another DualPaneExplorer in a
		// different workspace pane. Works in single-pane mode too.
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
			side: id === 'left' ? 'Left' : 'Right',
			label: paneConnectionLabel(id),
			kind,
			capabilities: drv.capabilities
		};
	}

	const pairCopy = $derived.by(() => copyHints('left'));

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
		const sourceDriver = activeDriver(src, from);
		const destDriver = activeDriver(dst, destId);
		const sourceLabel = paneConnectionLabel(from);
		const destLabel = paneConnectionLabel(destId);
		if (classify(sourceDriver, destDriver).kind === 'dual-phase') {
			const ok = await askDualPhase(sourceLabel, destLabel);
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
				destParentId: opts?.destParentId !== undefined ? opts.destParentId : dst.ctx.parentId,
				confirmDualPhase: () => askDualPhase(sourceLabel, destLabel)
			});
			// Live drivers refresh in place. Remotes without subscribeChanges
			// remount but keep the dest open folder via initialParentId.
			if (!destDriver.subscribeChanges) {
				setPane(destId, {
					explorerKey: dst.explorerKey + 1
				});
			}
			if (n === 0) toast.info('Nothing copied');
		} catch (e) {
			if (e instanceof CopyAcrossError) toast.error(e.message);
			else toast.error(formatExplorerError(e));
		} finally {
			copyBusy = false;
		}
	}

	/**
	 * Copy files from a different `<DualPaneExplorer>` instance (another workspace
	 * pane). The source driver / entries / selectedIds come from the shared
	 * cross-window drag session; the destination is a pane in this instance.
	 * Works in single-pane mode — `dualPane` need not be on.
	 */
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
		copyBusy = true;
		copyDestPane = destId;
		try {
			const n = await copyAcross({
				sourceDriver,
				destDriver,
				selectedIds,
				sourceEntries,
				destParentId,
				confirmDualPhase: () => askDualPhase(srcLabel, destLabel)
			});
			if (!destDriver.subscribeChanges) {
				setPane(destId, {
					explorerKey: dst.explorerKey + 1
				});
			}
			if (n === 0) toast.info('Nothing copied');
		} catch (e) {
			if (e instanceof CopyAcrossError) toast.error(e.message);
			else toast.error(formatExplorerError(e));
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
			// Remount so selection clears and the pane re-lists.
			setPane(id, { explorerKey: p.explorerKey + 1 });
		} catch (e) {
			toast.error(formatExplorerError(e));
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

{#snippet paneSwitcher(id: PaneId)}
	{@const p = id === 'left' ? left : right}
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

{#snippet paneBadges(id: PaneId)}
	{@const p = id === 'left' ? left : right}
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
		<span class="remote-badge" data-testid="monitor-remote-badge-{id}">monitor · open-with off</span>
		<span
			class="remote-badge mon-watch"
			data-testid="monitor-watch-status-{id}"
			data-status={monitorWatchStatus[id] ?? 'off'}
			title="Live filesystem watch (monitor SSE)"
		>
			watch · {monitorWatchStatus[id] ?? 'off'}
		</span>
	{:else if p.activeKind === 'disk'}
		<span class="remote-badge" data-testid="disk-badge-{id}"
			>This computer{p.diskName ? ` · ${p.diskName}` : ''}</span
		>
	{/if}
	{#if id === 'right' && overrideRight}
		<span class="remote-badge" data-testid="peer-fs-badge">Their · {overrideRight.label}</span>
	{/if}
{/snippet}

{#snippet copyAcrossAction(id: PaneId)}
	{@const p = id === 'left' ? left : right}
	{#if hostSettings && showCopyAcross}
		<FeTipIconBtn
			testid={tids.copyAcross(id)}
			tip={copyBusy ? 'Copying…' : 'Copy across'}
			icon="arrow-left-right"
			disabled={copyBusy || p.ctx.selectedIds.length === 0}
			onclick={() => runCopyAcross(id)}
		/>
	{/if}
{/snippet}

{#snippet explorerPane(id: PaneId)}
	<!-- Read $state panes directly so UI reacts (avoid stale {@const}). -->
	{@const p = id === 'left' ? left : right}
	{@const drv = activeDriver(p, id)}
	{@const hostTid = tids.explorerHost(id)}
	{@const subTid = tids.paneSub(id)}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="files-pane"
		class:drop-target={crossOver === id || osDropPane === id}
		data-testid={tids.pane(id)}
		data-pane={id}
		ondragstart={(e) => onPaneDragStart(id, e)}
		ondragover={(e) => onPaneDragOver(id, e)}
		ondragleave={(e) => onPaneDragLeave(id, e)}
		ondrop={(e) => void onPaneDrop(id, e)}
		ondragend={onPaneDragEnd}
		onfeexplorerdragbegin={(e) => onPanePointerDragBegin(id, e)}
		onfeexplorerdragend={onPaneDragEnd}
	>
		{#if !hostSettings}
		<div class="pane-chrome" data-testid={tids.paneChrome(id)}>
			{#if showCopyAcross}
				<FeTipIconBtn
					testid={tids.copyAcross(id)}
					tip={copyBusy ? 'Copying…' : 'Copy across'}
					icon="arrow-left-right"
					disabled={copyBusy || p.ctx.selectedIds.length === 0}
					onclick={() => runCopyAcross(id)}
				/>
			{/if}
			{#if onSend}
			<FeTipIconBtn
				testid={tids.send(id)}
				tip={sendBusy ? 'Sending…' : 'Send'}
				icon="send"
				disabled={sendBusy || p.ctx.selectedIds.length === 0 || !drv.download}
				onclick={() => runSend(id)}
			/>
		{/if}
		{@render paneBadges(id)}
		{#if subTid}
			<span class="pane-sub" data-testid={subTid.testid}>{subTid.text}</span>
		{/if}
	</div>
	{:else if p.busy || (p.activeKind !== 'local' && p.activeKind !== 'memory') || (id === 'right' && overrideRight) || subTid}
	<div class="pane-status" data-testid={tids.paneChrome(id)}>
		{@render paneBadges(id)}
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
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
						driver={overrideRight.driver}
						showPersistence={false}
						initialParentId={p.ctx.parentId}
						onOpen={paneOnOpen('peer')}
						onOpenProject={paneOpenProject(id)}
						pending={panePending(id)}
						onContextChange={(ctx) => {
							right = { ...right, ctx };
						}}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra()}
							{@render copyAcrossAction(id)}
						{/snippet}
					</FileExplorer>
				{:else if p.activeKind === 'local'}
					<!-- Page header owns the persistence chip; keep FE toolbar uncluttered. -->
					<FileExplorer
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
						driver={localDriver}
						showPersistence={false}
						initialParentId={p.ctx.parentId}
						onOpen={paneFileOpen(id)}
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
						onContextChange={(ctx) => {
							// Avoid full-pane rewrite storms — only patch ctx fields
							if (id === 'left') left = { ...left, ctx };
							else right = { ...right, ctx };
						}}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra()}
							{@render copyAcrossAction(id)}
						{/snippet}
					</FileExplorer>
				{:else}
					<FileExplorer
						mode={explorerMode}
						{accept}
						{hideIncompatible}
						{openLabel}
						variant="panel"
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
						onContextChange={(ctx) => {
							if (id === 'left') left = { ...left, ctx };
							else right = { ...right, ctx };
						}}
					>
						{#snippet headerLeading()}
							{@render paneConn(id)}
						{/snippet}
						{#snippet toolbarExtra()}
							{@render copyAcrossAction(id)}
						{/snippet}
					</FileExplorer>
				{/if}
			{/key}
		</div>
	</div>
{/snippet}

{#snippet paneConn(id: PaneId)}
	{#if paneShowsSwitcher(id) && !(id === 'right' && overrideRight)}
		<div
			class="dpe-pane-conn"
			data-testid="conn-switcher-{id}"
			data-pane={id}
			aria-label={id === 'left' ? 'Left pane connection' : 'Right pane connection'}
		>
			{@render paneSwitcher(id)}
		</div>
	{/if}
{/snippet}

{#if !hideToggles}
	<div class="dpe-layout-park" class:parked={Boolean(layoutPortal)}>
		<div
			class="dpe-layout-cluster"
			class:portaled={Boolean(layoutPortal)}
			use:portal={layoutPortal || undefined}
		>
			<CopyProgressHeader
				items={visibleCopyItems}
				onDismiss={dismissCopy}
				onDismissAll={dismissAllSettledCopy}
			/>
			<div
				class="ds-seg dpe-layout"
				class:portaled={Boolean(layoutPortal)}
				role="radiogroup"
				aria-label="File manager layout"
				data-testid={tids.dualToggle}
			>
				<button
					type="button"
					role="radio"
					class="dpe-layout-opt"
					class:active={!dualPane}
					aria-checked={!dualPane}
					data-testid="{tids.dualToggle}-single"
					title="One file tree"
					onclick={() => setDualPane(false)}
				>
					Single
				</button>
				<button
					type="button"
					role="radio"
					class="dpe-layout-opt"
					class:active={dualPane}
					aria-checked={dualPane}
					data-testid="{tids.dualToggle}-dual"
					title="Two independent trees side by side"
					onclick={() => setDualPane(true)}
				>
					Dual
				</button>
			</div>
			{#if pairInfoInChrome}
				<ConnectionPairInfo
					left={pairSide('left')}
					right={dualPane ? pairSide('right') : null}
					copyOut={pairCopy.copyOut}
					copyIn={pairCopy.copyIn}
					idleNote={pairCopy.copyIdleNote}
				/>
			{/if}
		</div>
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

<div class="dpe-shell" class:dual={dualPane}>

	<div
		class="files-body"
		class:dual={dualPane}
		bind:this={dualRootEl}
		data-testid={tids.body}
		style={dualPane
			? `grid-template-columns: minmax(0, ${dualRatio}fr) auto minmax(0, ${1 - dualRatio}fr)`
			: undefined}
	>
		<div class="files-pane-slot">
			{@render explorerPane('left')}
		</div>
		{#if dualPane}
			<SplitHandle
				axis="x"
				testid="fe-dual-split"
				ariaLabel="Resize file panes"
				onRatioDelta={onDualRatioDelta}
			/>
			<div class="files-pane-slot">
				{@render explorerPane('right')}
			</div>
		{/if}
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
	.pane-status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.65rem;
		border-bottom: 1px solid var(--line-hairline);
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
	.dpe-layout-park.parked {
		position: absolute;
		width: 0;
		height: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.dpe-layout {
		flex-wrap: nowrap;
		width: max-content;
		flex-shrink: 0;
	}
	.dpe-layout.portaled {
		height: var(--control-h-sm);
		padding: 2px;
		gap: 2px;
	}
	.dpe-layout-opt {
		padding: 0 0.65rem;
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.busy {
		font-size: 0.8rem;
		opacity: 0.8;
	}
	.b2-error {
		margin: 0;
		padding: 0.4rem 0.65rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.85rem;
	}
	.remote-badge {
		font-size: 0.75rem;
		color: var(--accent-light);
		white-space: nowrap;
	}
	.remote-badge.mem {
		color: var(--accent-violet);
	}
	.remote-badge.mon-watch {
		color: var(--accent-emerald);
		text-transform: lowercase;
	}
	.pane-sub {
		font-size: 0.72rem;
		color: var(--text-muted);
	}
	.files-body {
		flex: 1;
		min-height: 0;
		border: 0;
		border-radius: 0;
		overflow: hidden;
		background: var(--surface-1);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
	}
	.files-pane-slot {
		min-width: 0;
		min-height: 0;
		height: 100%;
		display: flex;
		flex-direction: column;
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
	@media (max-width: 800px) {
		.files-body.dual {
			grid-template-columns: minmax(0, 1fr) !important;
			grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
		}
		.files-body.dual :global([data-testid='fe-dual-split']) {
			display: none;
		}
	}
</style>
