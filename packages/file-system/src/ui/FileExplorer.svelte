<script lang="ts">
	import { onDestroy, onMount, tick, type Snippet } from 'svelte';
	import FileExplorer from './FileExplorer.svelte';
	import { getSharedVfs, isActionable, type FileTypeId, type VfsService } from '../index.js';
	import {
		readExplorerBlob,
		type ExplorerDriver,
		type ExplorerEntry,
		type ExplorerOpenTarget,
		type ExplorerOpenContext
	} from './explorerDriver.js';
	import { createLocalExplorerDriver } from './localExplorerDriver.js';
	import StoragePersistenceStatus from './StoragePersistenceStatus.svelte';
	import FeIcon from './FeIcon.svelte';
	import FeTipIconBtn from './FeTipIconBtn.svelte';
	import FeArchiveDialog from './FeArchiveDialog.svelte';
	import CopyProgressHeader from './CopyProgressHeader.svelte';
	import {
		createInnerFsSession,
		expandPackedBytes,
		looksCompressedName,
		looksPackedName,
		looksVaultName,
		readEntryBytes,
		runArchiveJob,
		type ArchiveDest,
		type ArchiveJobSpec,
		type ArchiveKind,
		type ArchiveWriteProgress,
		type InnerFsSession
	} from './archiveOps.js';
	import {
		abortTransfer,
		attachTransferAbort,
		listTransfers,
		subscribeTransfers,
		upsertProgress,
		type TransferItem
	} from '../transferRegistry.js';
	import {
		createTreeDndSession,
		canonicalizeSiblingZone,
		resolveDrop,
		zoneFromPoint,
		type DropZone
	} from './treeDnd/index.js';
	import {
		FE_EXPLORER_IDS_MIME,
		dataTransferHasOsFiles
	} from './copyAcross.js';
	import {
		setCrossWindowDrag,
		clearCrossWindowDrag,
		setPointerDragActive
	} from './crossWindowDnd.js';
	import {
		collectOsDrop,
		importOsDropToDriver,
		snapshotFiles,
		type OsDropFileProgress,
		type OsDropNode
	} from './osDrop.js';
	import {
		mergeListingWithPending,
		pendingLabel,
		pendingPercent,
		type ListingPending
	} from './listingPending.js';
	import { formatExplorerError } from './explorerError.js';
	import { generateId } from '../id.js';
	import {
		httpDownloadIsSafe,
		saveFileToDisk,
		triggerHttpDownload
	} from './saveToDisk.js';
	import {
		prefetchForDragOut,
		getDragOutFile,
		getDragOutUrl,
		formatDownloadURL,
		clearDragOutCache,
		evictDragOutFile
	} from './dragOutCache.js';
	import {
		payloadFromClipboardItems,
		payloadFromDataTransfer,
		type SystemClip
	} from './systemClipboard.js';
	import '@shared-packages/design-system/button.css';
	import '@shared-packages/design-system/tooltip.css';
	import { SplitHandle, toast } from '@shared-packages/ui';
	import FeThumbnail from './FeThumbnail.svelte';
	import FeTreeView from './FeTreeView.svelte';
	import FeFloatingPreview from './FeFloatingPreview.svelte';
	import { getPreviewKind } from './feThumbnails.js';
	import { detectProject } from './detectProject.js';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import {
		emptyTrashCopy,
		hardDeleteCopy,
		permanentDeleteCopy,
		type FeConfirmCopy
	} from './feConfirm.js';

	export type ExplorerMode = 'manage' | 'open' | 'save' | 'browse';

	export type ExplorerContext = {
		parentId: string | null;
		selectedIds: string[];
		backend: string;
		entries: ExplorerEntry[];
	};

	interface Props {
		mode?: ExplorerMode;
		accept?: FileTypeId[];
		hideIncompatible?: boolean;
		initialParentId?: string | null;
		defaultName?: string;
		multiSelect?: boolean;
		/** Preferred injection. If omitted, local driver from vfs. */
		driver?: ExplorerDriver;
		/** Legacy: used when driver omitted. */
		vfs?: VfsService;
		/**
		 * Show origin storage persistence chip (local Dexie/OPFS only).
		 * Default true when backend is local; ignored for remote drivers.
		 */
		showPersistence?: boolean;
		onOpen?: (entry: ExplorerOpenTarget, ctx?: ExplorerOpenContext) => void | Promise<void>;
		/** Preview "Open project" for folders that look like git working trees. */
		onOpenProject?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		/** Preview "Init project" for folders that are not already a git working tree. */
		onInitProject?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		/** Preview "Send this file" — Connections dual-pane send path. */
		onSendFile?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		sendLabel?: string;
		/** Override the preview Open label (string or per-entry). */
		openLabel?: string | ((entry: ExplorerOpenTarget) => string);
		onSave?: (args: {
			parentId: string | null;
			name: string;
			entry?: ExplorerOpenTarget;
		}) => void | Promise<void>;
		onClose?: () => void;
		/** Selection + open folder for dual-pane copy-across. */
		onContextChange?: (ctx: ExplorerContext) => void;
		variant?: 'panel' | 'dialog';
		class?: string;
		compatLibraryTestId?: boolean;
		compatSaveTestId?: boolean;
		/**
		 * In-progress transfers to render as semi-transparent rows at the top of
		 * the listing, each with a progress bar. Rows are non-interactive.
		 */
		pending?: Array<{
			id: string;
			name: string;
			/** Trailing leg — sent / dest write (solid fill). */
			transferred: number;
			size: number;
			direction?: string;
			/** Leading leg — downloaded / ready (translucent fill). Defaults to transferred. */
			ready?: number;
			status?: string;
			done?: boolean;
		}>;
		/** Hide the toolbar Trash button (popup listing). Default shows it when supportsTrash. */
		hideToolbarTrash?: boolean;
		/**
		 * Extra manage-toolbar / details actions (e.g. DualPane Copy across).
		 * `icon` sits in the main toolbar after Download; `label` is the details
		 * panel text button.
		 */
		toolbarExtra?: Snippet<[{ variant: 'icon' | 'label' }]>;
		/** Leading header slot (connection dropdown for DualPaneExplorer). */
		headerLeading?: Snippet;
	}

	let {
		mode = 'manage',
		accept,
		hideIncompatible = false,
		initialParentId = null,
		defaultName = '',
		multiSelect = false,
		driver: driverProp,
		vfs: vfsProp,
		showPersistence = true,
		onOpen,
		onOpenProject,
		onInitProject,
		onSendFile,
		sendLabel = 'Send this file',
		openLabel,
		onSave,
		onClose,
		pending = [],
		onContextChange,
		variant = 'panel',
		class: className = '',
		compatLibraryTestId = false,
		compatSaveTestId = false,
		hideToolbarTrash = false,
		toolbarExtra,
		headerLeading
	}: Props = $props();

	// Resolve driver once from props (local default). Re-create if prop identity changes via effect below.
	// svelte-ignore state_referenced_locally -- deliberate: resolve once, then
	// re-create via the effect below when the prop identity changes.
	let driver = $state<ExplorerDriver>(
		driverProp ?? createLocalExplorerDriver(vfsProp ?? getSharedVfs())
	);
	let caps = $derived(driver.capabilities);
	/** Local SharedVFS instance when applicable (for persistence chip + meta). */
	let localVfs = $derived(
		driver.id === 'local' ? (vfsProp ?? getSharedVfs()) : null
	);
	let showPersistChip = $derived(showPersistence && driver.id === 'local' && !!localVfs);

	$effect(() => {
		if (driverProp) {
			driver = driverProp;
		} else {
			driver = createLocalExplorerDriver(vfsProp ?? getSharedVfs());
		}
	});

	// svelte-ignore state_referenced_locally -- `initial` prop, by contract.
	let parentId = $state<string | null>(initialParentId);
	let nodes = $state<ExplorerEntry[]>([]);
	let listTruncated = $state(false);
	let breadcrumbs = $state<ExplorerEntry[]>([]);
	let selected = $state<Set<string>>(new Set());
	/** Most recently toggled-on row — Open uses this when several items are selected. */
	let lastSelectedId = $state<string | null>(null);
	/** Off: click selects one row. On: click toggles multi-select. */
	let selectMulti = $state(false);
	let previewEntry = $state<ExplorerEntry | null>(null);
	let previewBusy = $state(false);
	/** Folder preview: whether self or an ancestor has a `.git` child. `null` while detecting. */
	let previewIsProject = $state<boolean | null>(null);
	let previewDetectGen = 0;
	let previewDetectId: string | null = null;
	const hasProjectActions = $derived(Boolean(onOpenProject || onInitProject));
	let archiveKind = $state<ArchiveKind | null>(null);
	let archiveEntries = $state<ExplorerEntry[]>([]);
	let archiveDestLocked = $state<ArchiveDest | null>(null);
	let archiveDialogOpen = $state(false);
	let archiveJobRunning = $state(false);
	let archiveJobPct = $state(0);
	let archiveJobLabel = $state('');
	let archiveChipName = $state('');
	let archiveTransferId: string | null = null;
	let archiveAbort: AbortController | null = null;
	let archiveOpItems = $state<TransferItem[]>([]);
	let archiveDismissed = $state<Set<string>>(new Set());
	const visibleArchiveOps = $derived(archiveOpItems.filter((t) => !archiveDismissed.has(t.id)));
	let innerFs = $state<InnerFsSession | null>(null);
	let archiveProgressUnsub: (() => void) | null = null;
	onMount(() => {
		const pull = () => {
			archiveOpItems = listTransfers().filter((t) => t.direction === 'copying');
		};
		pull();
		archiveProgressUnsub = subscribeTransfers(pull);
		return () => {
			archiveProgressUnsub?.();
			archiveProgressUnsub = null;
		};
	});
	onDestroy(() => {
		archiveAbort?.abort();
		emptyTrashAbort?.abort();
		void innerFs?.dispose();
		clearDragOutCache();
		teardownPointerDrag();
	});
	/** off → below (horizontal split) → beside (vertical split) → off. */
	type PreviewDock = 'off' | 'bottom' | 'right';
	const PREVIEW_DOCK_KEY = 'fe:previewDock';
	let previewDock = $state<PreviewDock>(
		typeof localStorage === 'undefined'
			? 'off'
			: (() => {
					try {
						const v = localStorage.getItem(PREVIEW_DOCK_KEY);
						if (v === 'bottom' || v === 'right') return v;
					} catch {
						/* ignore */
					}
					return 'off';
				})()
	);
	/** off → left sidebar → top strip → off, like a file manager's folder tree. */
	type TreeDock = 'off' | 'left' | 'top';
	const TREE_DOCK_KEY = 'fe:treeDock';
	let treeDock = $state<TreeDock>(
		typeof localStorage === 'undefined'
			? 'off'
			: (() => {
					try {
						const v = localStorage.getItem(TREE_DOCK_KEY);
						if (v === 'left' || v === 'top') return v;
					} catch {
						/* ignore */
					}
					return 'off';
				})()
	);
	/**
	 * Bumped whenever a mutation could change folder structure (mkdir,
	 * rename, move, copy, delete, restore, or a live remote change). The
	 * tree dock re-fetches its currently-visible nodes when this changes —
	 * see FeTreeView.
	 */
	let treeVersion = $state(0);

	/** Resizable ratios for tree dock and preview dock (fraction of the body). */
	const TREE_RATIO_KEY = 'fe:treeRatio';
	const PREVIEW_RATIO_KEY = 'fe:previewRatio';
	const TREE_RATIO_DEFAULT = 0.22;
	const PREVIEW_RATIO_DEFAULT = 0.34;
	function loadRatio(key: string, fallback: number): number {
		try {
			const v = localStorage.getItem(key);
			if (v) {
				const n = Number(v);
				if (Number.isFinite(n) && n > 0.05 && n < 0.8) return n;
			}
		} catch {
			/* ignore */
		}
		return fallback;
	}
	let treeRatio = $state(loadRatio(TREE_RATIO_KEY, TREE_RATIO_DEFAULT));
	let previewRatio = $state(loadRatio(PREVIEW_RATIO_KEY, PREVIEW_RATIO_DEFAULT));
	function persistRatio(key: string, v: number) {
		try {
			localStorage.setItem(key, String(v));
		} catch {
			/* ignore */
		}
	}
	function onTreeRatioDelta(delta: number) {
		treeRatio = Math.min(0.6, Math.max(0.08, treeRatio + delta));
		persistRatio(TREE_RATIO_KEY, treeRatio);
	}
	function onPreviewRatioDelta(delta: number) {
		// Preview is on the right/bottom — dragging right/down shrinks it.
		previewRatio = Math.min(0.7, Math.max(0.1, previewRatio - delta));
		persistRatio(PREVIEW_RATIO_KEY, previewRatio);
	}
	// svelte-ignore state_referenced_locally -- `default` prop, by contract.
	let saveName = $state(defaultName);
	let error = $state('');
	/** Trash is a popup listing — never a replacement of the live folder. */
	let trashOpen = $state(false);
	let trashNodes = $state<ExplorerEntry[]>([]);
	let trashBusy = $state(false);
	let emptyTrashRunning = $state(false);
	let emptyTrashPct = $state(0);
	let emptyTrashLabel = $state('');
	let emptyTrashTransferId: string | null = null;
	let emptyTrashAbort: AbortController | null = null;
	/** Set while a "download selected" pass is triggering browser downloads. */
	let downloadBusy = $state(false);
	/** In-list progress for save-to-PC when we stream instead of a native GET. */
	let saveOps = $state<ListingPending[]>([]);
	/** OS / picker uploads into this listing (one row per file, merged by name). */
	let inboundOps = $state<ListingPending[]>([]);
	const archiveNameToId = new Map<string, string>();
	let archiveInboundIds = $state<string[]>([]);
	/** True until the first list() completes (empty shell only). */
	let initialLoad = $state(true);

	// ── View modes ────────────────────────────────────────────────
	type ViewMode = 'list' | 'icons' | 'detailed';
	const VIEW_MODE_KEY = 'fe:viewMode';
	const SHOW_PREVIEW_KEY = 'fe:showPreview';
	let viewMode = $state<ViewMode>(
		typeof localStorage === 'undefined'
			? 'list'
			: (() => {
					try {
						const v = localStorage.getItem(VIEW_MODE_KEY);
						if (v === 'icons' || v === 'detailed') return v;
					} catch {
						/* ignore */
					}
					return 'list';
				})()
	);
	let showPreview = $state(
		typeof localStorage === 'undefined'
			? false
			: (() => {
					try {
						return localStorage.getItem(SHOW_PREVIEW_KEY) === 'true';
					} catch {
						return false;
					}
				})()
	);
	let viewSwitcherOpen = $state(false);
	let floatingPreviewEntry = $state<ExplorerEntry | null>(null);

	function persistViewMode(v: ViewMode) {
		try {
			localStorage.setItem(VIEW_MODE_KEY, v);
		} catch {
			/* ignore */
		}
	}
	function persistShowPreview(v: boolean) {
		try {
			localStorage.setItem(SHOW_PREVIEW_KEY, v ? 'true' : 'false');
		} catch {
			/* ignore */
		}
	}
	function setViewMode(v: ViewMode) {
		viewMode = v;
		persistViewMode(v);
	}
	function toggleShowPreview() {
		showPreview = !showPreview;
		persistShowPreview(showPreview);
	}
	function toggleViewSwitcher() {
		viewSwitcherOpen = !viewSwitcherOpen;
	}
	function closeViewSwitcher() {
		viewSwitcherOpen = false;
	}

	function openFloatingPreview() {
		if (previewEntry && previewEntry.kind === 'file' && getPreviewKind(previewEntry)) {
			floatingPreviewEntry = previewEntry;
		}
	}
	/** True while a list/mutation refresh is in flight. */
	let listBusy = $state(false);
	/**
	 * Busy chrome. For folder/driver context changes it shows immediately.
	 * For light mutations it may wait {@link BUSY_OVERLAY_DELAY_MS} so fast ops
	 * don't flash. Overlay stays up until *new* nodes are painted (no old-list flash).
	 */
	let showBusyOverlay = $state(false);
	const BUSY_OVERLAY_DELAY_MS = 200;
	let busyOverlayTimer: ReturnType<typeof setTimeout> | null = null;
	let busyToken = 0;
	/** Ignore stale list() results when parentId/driver changes mid-flight. */
	let refreshGen = 0;
	/**
	 * Consecutive failed silent refreshes. Silent failures are swallowed to keep
	 * reconnects from flashing an error banner, so they need their own retry —
	 * otherwise a failure on the last change of a burst leaves the list stale
	 * with nothing left to trigger another attempt.
	 */
	let silentRetries = 0;
	const SILENT_RETRY_LIMIT = 2;
	const SILENT_RETRY_MS = 1_000;
	let silentRetryTimer: ReturnType<typeof setTimeout> | null = null;

	let newFolderOpen = $state(false);
	let newFolderName = $state('New Folder');
	let renamingId = $state<string | null>(null);
	let renameRootEl = $state<HTMLElement | null>(null);
	let renameBlurTimer: ReturnType<typeof setTimeout> | null = null;
	let renameBusy = false;
	let renameValue = $state('');
	let focusIndex = $state(-1);
	let clipboard = $state<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null);
	let systemClip = $state<SystemClip | null>(null);
	let uploadBusy = $state(false);
	let osDropOver = $state(false);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	/** Per-instance DnD session (dual-pane safe). */
	const dnd = createTreeDndSession();
	let dndTargetId = $state<string | null>(null);
	let dndZone = $state<DropZone | null>(null);
	/** Same-pane move: dest folder from breadcrumb / tree. `undefined` = not a nav drop. */
	let dndIntoId = $state<string | null | undefined>(undefined);
	let moveDragActive = $state(false);
	let moveDragLabel = $state('');
	/** Overlay gap inside `.fe-list` (content coords). Null = hide the line. */
	let dndLine = $state<{
		axis: 'x' | 'y';
		top: number;
		left: number;
		size: number;
	} | null>(null);
	let dndDraggingIds = $state<Set<string>>(new Set());
	let listEl = $state<HTMLDivElement | null>(null);
	/** Touch/pen drag in progress (HTML5 DnD does not fire on mobile). */
	let pointerDragActive = $state(false);
	let pointerListen = false;
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	const TOUCH_DRAG_DELAY_MS = 220;

	// Cap-gated only — do not fold listBusy into the attribute or rows flicker
	// non-draggable during refresh paint (and component tests race listBusy).
	const dndEnabled = $derived(mode === 'manage' && caps.supportsMove);

	// Broader than dndEnabled: also true when the driver only wants rows
	// draggable for external drop targets (supportsDragOut), without opting
	// into internal move/reorder (e.g. the flat memory list).
	const dragOutEnabled = $derived(
		mode === 'manage' && Boolean(caps.supportsMove || caps.supportsDragOut)
	);

	// Notify parent of selection/folder without tracking unstable callback identity
	let lastCtxKey = '';
	$effect(() => {
		const ids = [...selected].sort().join(',');
		const key = `${driver.id}|${parentId ?? ''}|${ids}|${nodes.length}`;
		if (key === lastCtxKey) return;
		lastCtxKey = key;
		onContextChange?.({
			parentId,
			selectedIds: [...selected],
			backend: driver.id,
			entries: nodes
		});
	});

	// Prefetch a download URL (preferred) or an in-memory File. Chrome starts
	// the GET only on drop when DownloadURL is set.
	$effect(() => {
		if (!caps.supportsDragOut) return;
		// Read selected so the effect re-runs on selection change.
		const ids = [...selected];
		for (const id of ids) {
			const entry = nodes.find((n) => n.id === id);
			if (entry) void prefetchForDragOut(driver, entry);
		}
	});

	$effect(() => {
		const n = previewEntry;
		const want = hasProjectActions && n?.kind === 'folder';
		if (!want || !n) {
			previewDetectId = null;
			previewDetectGen++;
			previewIsProject = null;
			return;
		}
		const folderId = n.id;
		const d = driver;
		if (previewDetectId === folderId) return;
		previewDetectId = folderId;
		const gen = ++previewDetectGen;
		previewIsProject = null;
		void detectProject(d, folderId).then(
			(ok) => {
				if (gen !== previewDetectGen) return;
				previewIsProject = ok;
			},
			() => {
				if (gen !== previewDetectGen) return;
				previewIsProject = false;
			}
		);
	});

	function errMsg(e: unknown): string {
		return formatExplorerError(e);
	}

	function reportError(e: unknown): void {
		reportMessage(errMsg(e));
	}

	function reportMessage(msg: string): void {
		error = msg;
		if (msg) toast.error(msg);
	}

	function rowSelector(id: string): string {
		const safe =
			typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
		return `[data-fe-row-id="${safe}"]`;
	}

	function rowElById(id: string): HTMLElement | null {
		const root = listEl;
		if (!root) return null;
		return root.querySelector(rowSelector(id));
	}

	function clearDndHover() {
		dndTargetId = null;
		dndZone = null;
		dndLine = null;
		dndIntoId = undefined;
	}

	function clearDndChrome() {
		clearDndHover();
		dndDraggingIds = new Set();
	}

	function updateLineTop(rowEl: HTMLElement, zone: DropZone) {
		if (zone === 'into') {
			dndLine = null;
			return;
		}
		const grid = viewMode === 'icons';
		if (grid) {
			dndLine = {
				axis: 'x',
				top: rowEl.offsetTop,
				left: zone === 'before' ? rowEl.offsetLeft : rowEl.offsetLeft + Math.max(rowEl.offsetWidth, 2) - 2,
				size: rowEl.offsetHeight
			};
			return;
		}
		dndLine = {
			axis: 'y',
			top: zone === 'before' ? rowEl.offsetTop : rowEl.offsetTop + Math.max(rowEl.offsetHeight, 2) - 2,
			left: 8,
			size: Math.max((listEl?.clientWidth ?? rowEl.offsetWidth) - 16, 8)
		};
	}

	function applyRowHover(n: ExplorerEntry, clientX: number, clientY: number, rowEl: HTMLElement) {
		if (!dnd.getState().active) return;
		const rect = rowEl.getBoundingClientRect();
		let zone = zoneFromPoint(
			{ top: rect.top, left: rect.left, height: rect.height, width: rect.width },
			{ x: clientX, y: clientY },
			{
				kind: n.kind,
				supportsSiblingOrder: caps.supportsSiblingOrder,
				layout: viewMode === 'icons' ? 'grid' : 'row'
			}
		);
		let target = n;
		let targetEl = rowEl;
		if (!caps.supportsSiblingOrder) {
			if (n.kind !== 'folder') {
				dnd.clearDropTarget();
				clearDndHover();
				return;
			}
			zone = 'into';
		} else {
			const idx = nodes.findIndex((x) => x.id === n.id);
			if (idx >= 0) {
				const canon = canonicalizeSiblingZone(idx, zone);
				if (canon.index !== idx) {
					target = nodes[canon.index]!;
					const el = rowElById(target.id);
					if (el) targetEl = el;
				}
				zone = canon.zone;
			}
		}
		dnd.setDropTarget(target.id, zone);
		dndTargetId = target.id;
		dndZone = zone;
		dndIntoId = undefined;
		updateLineTop(targetEl, zone);
	}

	function hoverNavParent(parentId: string | null) {
		if (!dnd.getState().active || !caps.supportsMove) return;
		dnd.setDropTarget(null, 'into');
		dndTargetId = null;
		dndZone = 'into';
		dndLine = null;
		dndIntoId = parentId;
	}

	function hoverGapAfterLast() {
		dndIntoId = undefined;
		if (!caps.supportsSiblingOrder || !nodes.length) {
			dnd.setDropTarget(null, 'into');
			dndTargetId = null;
			dndZone = 'into';
			dndLine = null;
			return;
		}
		const last = nodes[nodes.length - 1]!;
		const lastEl = rowElById(last.id);
		dnd.setDropTarget(last.id, 'after');
		dndTargetId = last.id;
		dndZone = 'after';
		if (lastEl) updateLineTop(lastEl, 'after');
		else dndLine = null;
	}

	function hoverFromPoint(clientX: number, clientY: number) {
		if (!dnd.getState().active) return;
		const stack =
			typeof document !== 'undefined' && document.elementsFromPoint
				? document.elementsFromPoint(clientX, clientY)
				: (() => {
						const hit =
							typeof document !== 'undefined'
								? document.elementFromPoint(clientX, clientY)
								: null;
						return hit ? [hit] : [];
					})();
		const dropHost = stack.find(
			(el) => el instanceof Element && el.closest('[data-fe-drop-parent]')
		);
		const dropEl =
			dropHost instanceof Element
				? (dropHost.closest('[data-fe-drop-parent]') as HTMLElement | null)
				: null;
		if (dropEl) {
			const raw = dropEl.getAttribute('data-fe-drop-parent');
			hoverNavParent(raw === '' || raw == null ? null : raw);
			return;
		}
		const inList = stack.find((el) => listEl?.contains(el));
		if (!inList || !listEl) {
			dnd.clearDropTarget();
			clearDndHover();
			return;
		}
		const row = stack.find((el) => el instanceof Element && el.closest('[data-fe-row-id]'));
		const rowEl =
			row instanceof Element ? (row.closest('[data-fe-row-id]') as HTMLElement | null) : null;
		if (!rowEl || !listEl.contains(rowEl)) {
			hoverGapAfterLast();
			return;
		}
		const id = rowEl.getAttribute('data-fe-row-id');
		const n = id ? nodes.find((x) => x.id === id) : undefined;
		if (!n) {
			hoverGapAfterLast();
			return;
		}
		applyRowHover(n, clientX, clientY, rowEl);
	}

	function idsForDrag(n: ExplorerEntry): string[] {
		return selected.has(n.id) && selected.size > 0 ? [...selected] : [n.id];
	}

	function selectForDrag(n: ExplorerEntry) {
		if (selected.has(n.id)) return;
		if (canToggleSelect()) {
			const next = new Set(selected);
			next.add(n.id);
			selected = next;
			lastSelectedId = n.id;
		} else {
			selectExclusive(n);
		}
	}

	function beginInternalDrag(n: ExplorerEntry): string[] {
		selectForDrag(n);
		const ids = idsForDrag(n);
		dndDraggingIds = new Set(ids);
		if (caps.supportsMove) {
			dnd.startDrag(ids, parentId);
			moveDragActive = true;
			if (ids.length === 1) {
				const name = nodes.find((x) => x.id === ids[0])?.name ?? n.name;
				moveDragLabel = `Moving item: ${name}`;
			} else {
				moveDragLabel = `Moving ${ids.length} items`;
			}
		}
		try {
			setCrossWindowDrag({
				sourceDriver: driver,
				sourceEntries: nodes,
				selectedIds: ids
			});
		} catch {
			/* ignore */
		}
		return ids;
	}

	function stopInternalDrag() {
		dnd.stopDrag();
		clearDndChrome();
		moveDragActive = false;
		moveDragLabel = '';
		pointerDragActive = false;
		setPointerDragActive(false);
	}

	function onRowDragStart(e: DragEvent, n: ExplorerEntry) {
		dragStarted = true;
		if (!dragOutEnabled) {
			e.preventDefault();
			return;
		}
		// Interactive controls (rename / buttons) must not start a row drag
		if (isRowControl(e.target)) {
			e.preventDefault();
			return;
		}
		const ids = beginInternalDrag(n);
		try {
			e.dataTransfer?.setData('text/plain', ids.join(','));
			e.dataTransfer?.setData(
				FE_EXPLORER_IDS_MIME,
				JSON.stringify({
					driverId: driver.id,
					ids,
					...(driver.connectionId ? { connectionId: driver.connectionId } : {})
				})
			);
		} catch {
			/* jsdom may lack full DataTransfer */
		}

		// OS drag-out: Chromium DownloadURL is a URL string only — Chrome GETs
		// it on drop (mouseup), so this tab does not buffer the file. Fall back
		// to a cached File for local VFS (no HTTP URL).
		if (caps.supportsDragOut && e.dataTransfer) {
			try {
				const urls = ids.map((id) => getDragOutUrl(id)).filter((u): u is NonNullable<typeof u> => u != null);
				if (urls.length === 1) {
					e.dataTransfer.setData('DownloadURL', formatDownloadURL(urls[0]!));
				} else {
					for (const id of ids) {
						const file = getDragOutFile(id);
						if (file) e.dataTransfer.items.add(file);
					}
				}
			} catch {
				/* some browsers / jsdom reject DownloadURL / items.add */
			}
		}

		// copyMove so DualPaneExplorer can accept a copy drop (move-only is rejected).
		if (e.dataTransfer) e.dataTransfer.effectAllowed = caps.supportsMove ? 'copyMove' : 'copy';
	}

	function onRowDragOver(e: DragEvent, n: ExplorerEntry) {
		if (allowOsFileDrag(e)) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			osDropOver = true;
			return;
		}
		if (!dnd.getState().active) return;
		e.preventDefault();
		applyRowHover(n, e.clientX, e.clientY, e.currentTarget as HTMLElement);
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onNavDragOver(e: DragEvent, destParentId: string | null) {
		if (allowOsFileDrag(e)) return;
		if (!dnd.getState().active || !caps.supportsMove) return;
		e.preventDefault();
		e.stopPropagation();
		hoverNavParent(destParentId);
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onNavDrop(e: DragEvent, destParentId: string | null) {
		if (allowOsFileDrag(e)) return;
		if (!dnd.getState().active) return;
		e.preventDefault();
		e.stopPropagation();
		void commitMoveInto(destParentId);
	}

	async function commitMoveInto(destParentId: string | null) {
		const st = dnd.getState();
		if (!st.active || !driver.move) {
			stopInternalDrag();
			return;
		}
		const dragIds = st.dragIds;
		try {
			for (const id of dragIds) {
				if (id === destParentId) continue;
				const node = nodes.find((x) => x.id === id);
				if (node && node.parentId === destParentId) continue;
				await driver.move(id, destParentId);
			}
			await refresh();
		} catch (err) {
			reportError(err);
		} finally {
			stopInternalDrag();
		}
	}

	async function commitDndDrop(target: ExplorerEntry | null) {
		const st = dnd.getState();
		if (!st.active || !st.primaryId) {
			stopInternalDrag();
			return;
		}
		const zone = st.zone;
		const dragIds = st.dragIds;
		try {
			if (target) {
				const resolved = resolveDrop({
					dragIds,
					target: { id: target.id, parentId: target.parentId, kind: target.kind },
					zone,
					supportsSiblingOrder: caps.supportsSiblingOrder
				});
				if (!resolved.ok) {
					// silent no-op for unsupported remote before/after
					return;
				}
				for (const id of dragIds) {
					if (resolved.mode === 'move-into') {
						if (id === resolved.newParentId) continue;
						await driver.move?.(id, resolved.newParentId);
					} else if (caps.supportsSiblingOrder && driver.reorder) {
						if (
							dragIds.length === 1 &&
							(resolved.afterId === id || resolved.beforeId === id)
						) {
							continue;
						}
						const node = nodes.find((x) => x.id === id);
						if (node && node.parentId !== resolved.newParentId) {
							await driver.move?.(id, resolved.newParentId);
						}
						await driver.reorder(id, {
							beforeId: resolved.beforeId,
							afterId: resolved.afterId
						});
					}
				}
			} else if (zone === 'into' || zone === null) {
				// drop on empty / list chrome → stay at parent (no-op) or no target
			}
			await refresh();
		} catch (err) {
			reportError(err);
		} finally {
			stopInternalDrag();
		}
	}

	function onRowDrop(e: DragEvent, n: ExplorerEntry) {
		if (allowOsFileDrag(e)) {
			e.preventDefault();
			e.stopPropagation();
			osDropOver = false;
			const dest = n.kind === 'folder' ? n.id : parentId;
			const pending = collectOsDrop(e.dataTransfer);
			void importOsNodes(pending, dest);
			return;
		}
		// Inactive session = a drag from the *other* dual pane. Let it bubble
		// so DualPaneExplorer can copy-across; do not steal the drop.
		if (!dnd.getState().active) return;
		e.preventDefault();
		e.stopPropagation();
		void commitDndDrop(
			dndTargetId ? (nodes.find((x) => x.id === dndTargetId) ?? n) : n
		);
	}

	function onRowDragEnd() {
		dragStarted = false;
		press = null;
		stopInternalDrag();
		clearCrossWindowDrag();
	}

	function attachPointerListeners() {
		if (pointerListen || typeof document === 'undefined') return;
		pointerListen = true;
		document.addEventListener('pointermove', onDocPointerMove, { capture: true, passive: false });
		document.addEventListener('pointerup', onDocPointerUp, { capture: true });
		document.addEventListener('pointercancel', onDocPointerUp, { capture: true });
	}

	function detachPointerListeners() {
		if (!pointerListen || typeof document === 'undefined') return;
		pointerListen = false;
		document.removeEventListener('pointermove', onDocPointerMove, true);
		document.removeEventListener('pointerup', onDocPointerUp, true);
		document.removeEventListener('pointercancel', onDocPointerUp, true);
	}

	function teardownPointerDrag() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		detachPointerListeners();
		pointerDragActive = false;
		setPointerDragActive(false);
	}

	function beginPointerDrag() {
		const start = press;
		if (!start || !dragOutEnabled) return;
		const n = nodes.find((x) => x.id === start.id);
		if (!n) return;
		dragStarted = true;
		pointerDragActive = true;
		setPointerDragActive(true);
		const ids = beginInternalDrag(n);
		try {
			start.rowEl?.setPointerCapture(start.pointerId);
		} catch {
			/* jsdom / lost node */
		}
		start.rowEl?.dispatchEvent(
			new CustomEvent('feexplorerdragbegin', { bubbles: true, composed: true, detail: { ids } })
		);
		try {
			navigator.vibrate?.(10);
		} catch {
			/* ignore */
		}
	}

	function onDocPointerMove(e: PointerEvent) {
		if (!press || e.pointerId !== press.pointerId) return;
		const dx = e.clientX - press.x;
		const dy = e.clientY - press.y;
		if (longPressTimer && dx * dx + dy * dy > SELECT_SLOP_PX * SELECT_SLOP_PX) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
			detachPointerListeners();
			return;
		}
		if (!pointerDragActive) return;
		e.preventDefault();
		hoverFromPoint(e.clientX, e.clientY);
	}

	function onDocPointerUp(e: PointerEvent) {
		if (press && e.pointerId !== press.pointerId) return;
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		detachPointerListeners();
		if (!pointerDragActive) return;
		e.preventDefault();
		finishPointerDrag(e);
	}

	function finishPointerDrag(e: PointerEvent) {
		pointerDragActive = false;
		dragStarted = true;
		press = null;
		hoverFromPoint(e.clientX, e.clientY);
		const el =
			typeof document !== 'undefined' ? document.elementFromPoint(e.clientX, e.clientY) : null;
		const root = listEl?.closest('.fe-root') ?? listEl;
		const inSelf = el instanceof Node && !!root?.contains(el);
		if (inSelf && dnd.getState().active) {
			setPointerDragActive(false);
			el instanceof Element &&
				el.dispatchEvent(new CustomEvent('feexplorerdragend', { bubbles: true, composed: true }));
			if (dndIntoId !== undefined) {
				void commitMoveInto(dndIntoId);
				return;
			}
			const target = dndTargetId ? (nodes.find((x) => x.id === dndTargetId) ?? null) : null;
			void commitDndDrop(target);
			return;
		}
		// Foreign drop (other pane / window): DualPaneExplorer handles copy-across.
		dnd.stopDrag();
		clearDndChrome();
	}

	function beginListBusy(opts?: { immediate?: boolean }) {
		const token = ++busyToken;
		listBusy = true;
		if (opts?.immediate) {
			if (busyOverlayTimer) {
				clearTimeout(busyOverlayTimer);
				busyOverlayTimer = null;
			}
			showBusyOverlay = true;
			return;
		}
		// Keep overlay if already up (chained refreshes)
		if (showBusyOverlay) return;
		if (busyOverlayTimer) clearTimeout(busyOverlayTimer);
		busyOverlayTimer = setTimeout(() => {
			if (token === busyToken && listBusy) {
				showBusyOverlay = true;
			}
		}, BUSY_OVERLAY_DELAY_MS);
	}

	/**
	 * Drop busy chrome only after the current list paint is committed, so the
	 * user never sees: spinner off → old rows → new rows.
	 */
	async function endListBusyAfterPaint() {
		const hadOverlay = showBusyOverlay;
		if (hadOverlay) {
			// Let Svelte commit `nodes` under the still-visible overlay
			await tick();
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
		}
		busyToken += 1;
		if (busyOverlayTimer) {
			clearTimeout(busyOverlayTimer);
			busyOverlayTimer = null;
		}
		listBusy = false;
		showBusyOverlay = false;
	}

	function clearSilentRetry() {
		if (silentRetryTimer) {
			clearTimeout(silentRetryTimer);
			silentRetryTimer = null;
		}
	}

	function scheduleSilentRetry() {
		clearSilentRetry();
		silentRetryTimer = setTimeout(() => {
			silentRetryTimer = null;
			void refresh(true, 'delay', true);
		}, SILENT_RETRY_MS);
	}

	/**
	 * Reload list + breadcrumbs.
	 * @param manageBusy - when false, caller owns begin/endListBusy (e.g. delete).
	 * @param busyMode - `immediate` covers folder/driver switches; `delay` for light ops.
	 * @param silent - background refresh driven by a live backend, not by the user.
	 *   Paints no busy chrome and skips the `ready()` probe: rows are keyed by id,
	 *   so an unchanged list re-commits to the same DOM and the user sees nothing.
	 *   Without this every watch event dimmed the list (`cursor: wait`, rows
	 *   `pointer-events: none`, toolbar disabled) for the length of three round
	 *   trips, which is what read as flicker under a stream of file changes.
	 */
	async function refresh(
		manageBusy = true,
		busyMode: 'delay' | 'immediate' = 'delay',
		silent = false
	) {
		const gen = ++refreshGen;
		// Any newer refresh subsumes a queued retry.
		clearSilentRetry();
		if (manageBusy && !silent) beginListBusy({ immediate: busyMode === 'immediate' });
		// A background refresh must not clear an error the user hasn't addressed.
		if (!silent) error = '';
		try {
			// The SSE stream arriving *is* the liveness probe for a silent refresh.
			if (!silent) await driver.ready();
			if (gen !== refreshGen) return;

			const result = await driver.list({ parentId });
			const nextNodesRaw = result.entries;
			const nextTruncated = result.truncated;
			const nextCrumbs = parentId ? await driver.getPath(parentId) : [];
			let nextNodes = nextNodesRaw;
			if (gen !== refreshGen) return;

			if (hideIncompatible && accept?.length) {
				nextNodes = nextNodes.filter(
					(n) => n.kind === 'folder' || isActionable(n as never, accept)
				);
			}
			// Commit data while overlay still covers the list (when shown)
			nodes = nextNodes;
			listTruncated = nextTruncated;
			breadcrumbs = nextCrumbs;
			if (focusIndex >= nodes.length) focusIndex = nodes.length ? nodes.length - 1 : -1;
			silentRetries = 0;
			// Folder structure may have changed (mkdir/rename/move/delete/restore,
			// or a live remote change) — let the tree dock know to re-fetch.
			treeVersion += 1;
		} catch (e) {
			if (gen !== refreshGen) return;
			if (!silent) {
				reportError(e);
			} else if (silentRetries < SILENT_RETRY_LIMIT) {
				// A failed background poll keeps the last good list rather than
				// flashing red on every reconnect — but a silent failure is also how
				// the list goes stale without saying so. If this was the last change
				// in a burst, nothing else will retry, so retry here.
				silentRetries += 1;
				scheduleSilentRetry();
			} else {
				// Persistently failing: staleness the user cannot see is worse than
				// an error they can act on.
				silentRetries = 0;
				reportError(e);
			}
		} finally {
			// Only the latest refresh may clear busy
			if (gen === refreshGen) {
				initialLoad = false;
				// A silent refresh raises no chrome — but if it superseded one that
				// did, that refresh bailed at this same guard, so clearing up is now
				// this one's job or the overlay sticks.
				if (manageBusy && (!silent || listBusy)) await endListBusyAfterPaint();
			}
		}
	}

	$effect(() => {
		void parentId;
		void mode;
		void driver;
		// A new folder does not inherit the last one's failure streak.
		silentRetries = 0;
		// Folder / backend context change: cover list immediately
		void refresh(true, 'immediate');
	});

	/**
	 * Live backends (monitor watch, local Dexie liveQuery): re-list the open
	 * folder when the driver signals a change.
	 *
	 * Re-subscribes on navigation so the backend can watch just this folder —
	 * each mounted explorer holds its own subscription, which is what lets a
	 * dual pane or a tree watch several folders over one connection.
	 */
	$effect(() => {
		const d = driver;
		const scopeId = parentId;
		if (!d.subscribeChanges) return;
		const unsub = d.subscribeChanges(
			() => {
				// Empty trash owns its list until it finishes — live ticks were the flash.
				if (emptyTrashRunning) return;
				// Silent — keeps selection, and paints no busy chrome for a change the
				// user did not initiate.
				void refresh(true, 'delay', true);
				if (trashOpen) void refreshTrash();
			},
			{ parentId: scopeId }
		);
		return () => {
			unsub();
			clearSilentRetry();
		};
	});

	function rowActionable(n: ExplorerEntry): boolean {
		return isActionable(n as never, accept);
	}

	async function refreshTrash() {
		if (!caps.supportsTrash) {
			trashNodes = [];
			return;
		}
		trashBusy = true;
		try {
			const result = await driver.list({ parentId: null, trashOnly: true });
			trashNodes = result.entries;
		} catch (e) {
			reportError(e);
		} finally {
			trashBusy = false;
		}
	}

	async function toggleTrashPopup() {
		const next = !trashOpen;
		trashOpen = next;
		if (next) await refreshTrash();
	}

	function focusedNode(): ExplorerEntry | null {
		if (focusIndex < 0 || focusIndex >= nodes.length) return null;
		return nodes[focusIndex] ?? null;
	}

	async function enterFolder(n: ExplorerEntry) {
		if (n.kind !== 'folder') return;
		trashOpen = false;
		parentId = n.id;
		selected = new Set();
		lastSelectedId = null;
		focusIndex = -1;
	}

	async function goCrumb(id: string | null) {
		trashOpen = false;
		parentId = id;
		selected = new Set();
		lastSelectedId = null;
		focusIndex = -1;
	}

	async function goUp() {
		if (trashOpen) {
			trashOpen = false;
			return;
		}
		if (!parentId) return;
		const path = await driver.getPath(parentId);
		const parent = path.length >= 2 ? path[path.length - 2] : null;
		await goCrumb(parent?.id ?? null);
	}

	async function confirmSave() {
		if (!onSave) return;
		let name = saveName.trim();
		if (!name) {
			error = 'Name required';
			return;
		}
		if (accept?.[0]) {
			const { forceExtension } = await import('../registry.js');
			name = forceExtension(name, accept[0]);
		}
		try {
			await onSave({ parentId, name });
		} catch (e) {
			reportError(e);
		}
	}

	async function createFolder() {
		if (!driver.mkdir || !caps.supportsMkdir) return;
		try {
			await driver.mkdir(parentId, newFolderName || 'New Folder');
			newFolderOpen = false;
			newFolderName = 'New Folder';
			await refresh();
		} catch (e) {
			reportError(e);
		}
	}

	let confirmPrompt = $state<{
		copy: FeConfirmCopy;
		resolve: (ok: boolean) => void;
	} | null>(null);

	function askConfirm(copy: FeConfirmCopy): Promise<boolean> {
		return new Promise((resolve) => {
			confirmPrompt = { copy, resolve };
		});
	}

	function closeConfirm(ok: boolean) {
		const r = confirmPrompt?.resolve;
		confirmPrompt = null;
		r?.(ok);
	}

	async function confirmHardDelete(ids: string[], names: string[]): Promise<boolean> {
		if (caps.supportsSoftDelete) return true;
		const folderCount = ids.filter((id) => nodes.find((n) => n.id === id)?.kind === 'folder').length;
		return askConfirm(
			hardDeleteCopy({
				driverId: driver.id,
				count: ids.length,
				folderCount,
				name: names[0] ?? 'item'
			})
		);
	}

	async function deleteIds(ids: string[]) {
		if (!ids.length) return;
		const names = ids.map((id) => nodes.find((n) => n.id === id)?.name ?? id);
		if (!(await confirmHardDelete(ids, names))) return;
		// Optimistic remove so the row doesn't sit there through a slow remote delete
		const idSet = new Set(ids);
		const snapshot = nodes;
		nodes = nodes.filter((n) => !idSet.has(n.id));
		selected = new Set();
		lastSelectedId = null;
		previewEntry = null;
		focusIndex = -1;

		const failures: string[] = [];
		// Single busy span for delete + reconcile (avoids overlay flash off/on)
		beginListBusy();
		try {
			for (const id of ids) {
				try {
					await driver.delete(id);
				} catch (e) {
					failures.push(`${errMsg(e)}: ${names[ids.indexOf(id)] ?? id}`);
				}
			}
			// Reconcile with server while still covered; apply new list under busy chrome
			await refresh(false);
		} finally {
			await endListBusyAfterPaint();
		}
		if (failures.length) {
			// Put failed items back if still missing after reconcile
			const have = new Set(nodes.map((n) => n.id));
			const restored = snapshot.filter((n) => idSet.has(n.id) && !have.has(n.id));
			if (restored.length) nodes = [...nodes, ...restored];
			reportMessage(
				failures.length === 1
					? failures[0]!
					: `${failures[0]} (and ${failures.length - 1} other errors)`
			);
		}
	}

	async function trashSelected() {
		await deleteIds([...selected]);
	}

	async function trashFocusedOrSelected() {
		if (trashOpen || mode === 'browse') return;
		const ids =
			selected.size > 0
				? [...selected]
				: focusedNode()
					? [focusedNode()!.id]
					: [];
		await deleteIds(ids);
	}

	async function restoreNode(n: ExplorerEntry) {
		if (!driver.restore) return;
		await driver.restore(n.id);
		await Promise.all([refreshTrash(), refresh()]);
	}

	async function permanentNode(n: ExplorerEntry) {
		if (!driver.permanentDelete) return;
		if (!(await askConfirm(permanentDeleteCopy(n.name)))) return;
		await driver.permanentDelete(n.id);
		await refreshTrash();
	}

	function bumpEmptyTrashProgress(done: number, total: number, name?: string) {
		emptyTrashPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
		emptyTrashLabel = name ? `Deleting ${name}` : 'Emptying trash…';
		if (!emptyTrashTransferId) return;
		upsertProgress({
			id: emptyTrashTransferId,
			name: 'Trash',
			size: 100,
			transferred: emptyTrashPct,
			direction: 'copying',
			done: false,
			status: 'active',
			hopNote: 'Emptying trash…'
		});
	}

	function abortEmptyTrash() {
		emptyTrashAbort?.abort();
		if (emptyTrashTransferId) abortTransfer(emptyTrashTransferId);
	}

	async function emptyTrash() {
		if (!driver.emptyTrash || emptyTrashRunning) return;
		if (!(await askConfirm(emptyTrashCopy()))) return;
		emptyTrashAbort?.abort();
		const ac = new AbortController();
		emptyTrashAbort = ac;
		const id = generateId('empty-trash');
		emptyTrashTransferId = id;
		emptyTrashRunning = true;
		emptyTrashPct = 0;
		emptyTrashLabel = 'Emptying trash…';
		attachTransferAbort(id, ac);
		upsertProgress({
			id,
			name: 'Trash',
			size: 100,
			transferred: 0,
			direction: 'copying',
			done: false,
			status: 'active',
			hopNote: 'Emptying trash…'
		});
		try {
			await driver.emptyTrash({
				signal: ac.signal,
				onProgress: (ev) => bumpEmptyTrashProgress(ev.done, ev.total, ev.name)
			});
			upsertProgress({
				id,
				name: 'Trash',
				size: 100,
				transferred: 100,
				direction: 'copying',
				done: true,
				status: 'done',
				hopNote: 'Done'
			});
		} catch (e) {
			const cancelled = e instanceof Error && e.name === 'AbortError';
			upsertProgress({
				id,
				name: 'Trash',
				size: 100,
				transferred: emptyTrashPct,
				direction: 'copying',
				done: true,
				status: 'failed',
				error: cancelled ? 'Cancelled' : formatExplorerError(e),
				hopNote: cancelled ? 'Cancelled' : 'Failed'
			});
			if (cancelled) toast.info('Cancelled');
			else toast.error(formatExplorerError(e));
		} finally {
			emptyTrashRunning = false;
			if (emptyTrashAbort === ac) emptyTrashAbort = null;
			if (emptyTrashTransferId === id) emptyTrashTransferId = null;
			await refreshTrash();
			await refresh(true, 'delay', true);
		}
	}

	function clearRenameBlur() {
		if (renameBlurTimer != null) {
			clearTimeout(renameBlurTimer);
			renameBlurTimer = null;
		}
	}

	function cancelRename() {
		clearRenameBlur();
		renamingId = null;
	}

	async function commitRename(n: ExplorerEntry) {
		if (renamingId !== n.id || renameBusy) return;
		clearRenameBlur();
		const next = renameValue.trim();
		if (!next || next === n.name) {
			renamingId = null;
			return;
		}
		if (!driver.rename || !caps.supportsRename) return;
		renameBusy = true;
		try {
			await driver.rename(n.id, next);
			renamingId = null;
			error = '';
			await refresh();
		} catch (e) {
			reportError(e);
		} finally {
			renameBusy = false;
		}
	}

	function scheduleCommitRename(n: ExplorerEntry) {
		clearRenameBlur();
		renameBlurTimer = setTimeout(() => {
			renameBlurTimer = null;
			if (renamingId === n.id) void commitRename(n);
		}, 0);
	}

	function startRename(n: ExplorerEntry) {
		if (mode !== 'manage' || !caps.supportsRename) return;
		renamingId = n.id;
		renameValue = n.name;
	}

	$effect(() => {
		if (!renamingId) return;
		const id = renamingId;
		const onPointerDown = (e: PointerEvent) => {
			const root = renameRootEl;
			if (root && e.target instanceof Node && root.contains(e.target)) return;
			const n = nodes.find((x) => x.id === id);
			if (n) void commitRename(n);
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	});

	$effect(() => {
		if (!renamingId || !renameRootEl) return;
		const input = renameRootEl.querySelector('input');
		if (!(input instanceof HTMLInputElement)) return;
		input.focus();
		const v = input.value;
		const dot = v.lastIndexOf('.');
		if (dot > 0) input.setSelectionRange(0, dot);
		else input.select();
	});

	function canToggleSelect(): boolean {
		return selectMulti && (multiSelect || mode === 'manage' || mode === 'open');
	}

	function setSelectMulti(on: boolean) {
		selectMulti = on;
		if (on) {
			previewEntry = null;
			return;
		}
		selected = new Set();
		lastSelectedId = null;
		previewEntry = null;
		focusIndex = -1;
	}

	function selectExclusive(n: ExplorerEntry) {
		selected = new Set([n.id]);
		lastSelectedId = n.id;
		if (previewEntry && previewEntry.id !== n.id) previewEntry = null;
	}

	function selectedPrimary(): ExplorerEntry | null {
		if (lastSelectedId) {
			const last = nodes.find((n) => n.id === lastSelectedId && selected.has(n.id));
			if (last) return last;
		}
		return selectedEntries[0] ?? null;
	}

	function openSelectedDetails() {
		const n = selectedPrimary();
		if (!n) return;
		previewEntry = n;
	}

	function startArchive(kind: ArchiveKind, targets: ExplorerEntry[], destLocked: ArchiveDest | null = null) {
		if (!targets.length) return;
		archiveKind = kind;
		archiveEntries = targets;
		archiveDestLocked = destLocked;
		archiveDialogOpen = true;
	}

	function closeArchive() {
		archiveDialogOpen = false;
		archiveKind = null;
		archiveEntries = [];
		archiveDestLocked = null;
	}

	function hideArchiveDialog() {
		archiveDialogOpen = false;
	}

	function bumpArchiveProgress(ev: ArchiveWriteProgress) {
		if (ev.job) {
			if (ev.size > 0) {
				const pct = Math.min(100, Math.round((ev.transferred / ev.size) * 100));
				archiveJobPct = Math.max(archiveJobPct, pct);
			}
			if (archiveTransferId) {
				upsertProgress({
					id: archiveTransferId,
					name: archiveChipName || ev.name || 'Archive',
					size: 100,
					transferred: archiveJobPct,
					direction: 'copying',
					done: false,
					status: 'active',
					hopNote: archiveJobLabel || 'Working…'
				});
			}
			return;
		}
		let id = archiveNameToId.get(ev.name);
		if (!id) {
			id = generateId('archive');
			archiveNameToId.set(ev.name, id);
			archiveInboundIds = [...archiveInboundIds, id];
		}
		const row: ListingPending = {
			id,
			name: ev.name,
			transferred: ev.transferred,
			size: ev.size,
			direction: 'receiving',
			done: ev.done,
			destParentId: ev.parentId
		};
		inboundOps = inboundOps.some((o) => o.id === id)
			? inboundOps.map((o) => (o.id === id ? row : o))
			: [...inboundOps, row];
	}

	function abortArchiveJob() {
		archiveAbort?.abort();
		if (archiveTransferId) abortTransfer(archiveTransferId);
	}

	async function launchArchive(spec: ArchiveJobSpec) {
		archiveAbort?.abort();
		const ac = new AbortController();
		archiveAbort = ac;
		const id = generateId('archive');
		archiveTransferId = id;
		archiveJobRunning = true;
		archiveJobPct = 0;
		archiveChipName = spec.title;
		archiveJobLabel =
			spec.kind === 'compress'
				? 'Compressing…'
				: spec.kind === 'encrypt'
					? 'Encrypting…'
					: spec.kind === 'decompress'
						? 'Decompressing…'
						: 'Decrypting…';
		attachTransferAbort(id, ac);
		upsertProgress({
			id,
			name: spec.title,
			size: 100,
			transferred: 0,
			direction: 'copying',
			done: false,
			status: 'active',
			hopNote: archiveJobLabel
		});
		try {
			const result = await runArchiveJob({
				...spec,
				signal: ac.signal,
				onProgress: bumpArchiveProgress
			});
			upsertProgress({
				id,
				name: spec.title,
				size: 100,
				transferred: 100,
				direction: 'copying',
				done: true,
				status: 'done',
				hopNote: 'Done'
			});
			await finishArchive(result);
		} catch (e) {
			const cancelled = e instanceof Error && e.name === 'AbortError';
			upsertProgress({
				id,
				name: spec.title,
				size: 100,
				transferred: archiveJobPct,
				direction: 'copying',
				done: true,
				status: 'failed',
				error: cancelled ? 'Cancelled' : formatExplorerError(e),
				hopNote: cancelled ? 'Cancelled' : 'Failed'
			});
			if (cancelled) toast.info('Cancelled');
			else toast.error(formatExplorerError(e));
			const ids = archiveInboundIds;
			archiveNameToId.clear();
			archiveInboundIds = [];
			inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
			hideArchiveDialog();
			closeArchive();
		} finally {
			archiveJobRunning = false;
			if (archiveAbort === ac) archiveAbort = null;
			if (archiveTransferId === id) archiveTransferId = null;
		}
	}

	async function finishArchive(result?: { inner?: import('./archiveOps.js').PackedPath[]; title: string }) {
		const ids = archiveInboundIds;
		archiveNameToId.clear();
		archiveInboundIds = [];
		hideArchiveDialog();
		closeArchive();
		if (result?.inner?.length) {
			inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
			try {
				innerFs = await createInnerFsSession(result.title, result.inner);
			} catch (e) {
				reportError(e);
			}
			return;
		}
		await refresh();
		inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
	}

	async function closeInnerFs() {
		const session = innerFs;
		innerFs = null;
		await tick();
		await session?.dispose();
	}

	async function openPackedEntry(entry: ExplorerEntry): Promise<boolean> {
		if (entry.kind !== 'file' || !looksPackedName(entry.name)) return false;
		if (looksVaultName(entry.name)) {
			startArchive('decrypt', [entry], 'popup');
			return true;
		}
		previewBusy = true;
		error = '';
		try {
			const bytes = await readEntryBytes(driver, entry);
			const files = await expandPackedBytes(bytes, entry.name);
			innerFs = await createInnerFsSession(entry.name, files);
			previewEntry = null;
			return true;
		} catch (e) {
			reportError(e);
			startArchive('decompress', [entry]);
			return true;
		} finally {
			previewBusy = false;
		}
	}

	function persistPreviewDock(next: PreviewDock) {
		try {
			if (next === 'off') localStorage.removeItem(PREVIEW_DOCK_KEY);
			else localStorage.setItem(PREVIEW_DOCK_KEY, next);
		} catch {
			/* ignore */
		}
	}

	function cyclePreviewDock() {
		const next: PreviewDock =
			previewDock === 'off' ? 'bottom' : previewDock === 'bottom' ? 'right' : 'off';
		previewDock = next;
		persistPreviewDock(next);
		if (next === 'off') previewEntry = null;
	}

	function persistTreeDock(next: TreeDock) {
		try {
			if (next === 'off') localStorage.removeItem(TREE_DOCK_KEY);
			else localStorage.setItem(TREE_DOCK_KEY, next);
		} catch {
			/* ignore */
		}
	}

	function cycleTreeDock() {
		const next: TreeDock = treeDock === 'off' ? 'left' : treeDock === 'left' ? 'top' : 'off';
		treeDock = next;
		persistTreeDock(next);
	}

	$effect(() => {
		if (previewDock !== 'off') {
			previewEntry = selectedPrimary();
			return;
		}
		if (!previewEntry) return;
		if (selected.size === 0) {
			previewEntry = null;
			return;
		}
		const primary = selectedPrimary();
		if (primary && (selected.size === 1 || !selected.has(previewEntry.id))) {
			previewEntry = primary;
		}
	});

	function formatBytes(n: number | undefined): string {
		if (n == null) return 'Unknown size';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function selectionSizeLabel(entries: ExplorerEntry[]): string {
		let known = 0;
		let unknown = 0;
		let bytes = 0;
		for (const e of entries) {
			if (e.size == null) unknown += 1;
			else {
				known += 1;
				bytes += e.size;
			}
		}
		if (known === 0) return 'Unknown size';
		if (unknown === 0) return formatBytes(bytes);
		return `${formatBytes(bytes)} + ${unknown} unknown`;
	}

	function formatWhen(ts: number | undefined): string {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '';
		}
	}

	function defaultOpenLabel(entry: ExplorerOpenTarget): string {
		if (typeof openLabel === 'function') return openLabel(entry);
		if (typeof openLabel === 'string' && openLabel) return openLabel;
		if (looksVaultName(entry.name)) return 'Open vault';
		if (looksCompressedName(entry.name)) return 'Open archive';
		if (entry.fileType === 'skch') return 'Open in sketcher';
		if (entry.fileType === 'ob3d') return 'Open in 3D';
		if (entry.fileType === 'cari') return 'Open in Caricature';
		if (entry.fileType === 'igfx') return 'Open in Infographic';
		if (entry.fileType === 'kb') return 'Open in Knowledge Base';
		if (entry.fileType === 'anim') return 'Open in Animations';
		if (entry.fileType === 'vrec') return 'Open in voice';
		if (entry.fileType === 'image') return 'Open in Images';
		if (entry.fileType === 'video') return 'Open in Video';
		if (entry.fileType === 'audio') return 'Open in Audio';
		if (entry.fileType === 'pdf') return 'Open PDF';
		return 'Open';
	}

	function previewShowsOpen(entry: ExplorerEntry): boolean {
		if (entry.kind === 'folder') return mode !== 'browse';
		if (mode !== 'open' && mode !== 'manage') return false;
		if (mode === 'manage' && looksPackedName(entry.name)) return true;
		return Boolean(onOpen && rowActionable(entry));
	}

	function readOpenTarget(entry: ExplorerOpenTarget): Promise<Blob> {
		return readExplorerBlob(driver, entry.id);
	}

	function emitOpen(entry: ExplorerOpenTarget) {
		return onOpen?.(entry, { read: () => readOpenTarget(entry) });
	}

	async function confirmPreviewOpen() {
		const n = previewEntry;
		if (!n) return;
		if (n.kind === 'folder') {
			previewEntry = null;
			await enterFolder(n);
			return;
		}
		if (await openPackedEntry(n)) return;
		if (!onOpen) return;
		previewBusy = true;
		try {
			await emitOpen(n);
			previewEntry = null;
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	async function confirmOpenProject() {
		const n = previewEntry;
		if (!n || n.kind !== 'folder' || !onOpenProject) return;
		previewBusy = true;
		try {
			const ok = await detectProject(driver, n.id);
			previewIsProject = ok;
			if (!ok) {
				reportMessage('Not a git project');
				return;
			}
			error = '';
			await onOpenProject(n);
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	async function confirmInitProject() {
		const n = previewEntry;
		if (!n || n.kind !== 'folder' || !onInitProject) return;
		previewBusy = true;
		try {
			const already = await detectProject(driver, n.id);
			if (already) {
				previewIsProject = true;
				if (onOpenProject) {
					error = '';
					await onOpenProject(n);
				} else {
					reportMessage('Already a git project');
				}
				return;
			}
			error = '';
			await onInitProject(n);
			previewIsProject = true;
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	function renamePreviewItem() {
		const n = previewEntry;
		if (!n) return;
		previewEntry = null;
		startRename(n);
	}

	async function copyPreviewItem() {
		const n = previewEntry;
		if (!n) return;
		await copyNode(n);
		previewEntry = null;
	}

	async function deletePreviewItem() {
		const n = previewEntry;
		if (!n) return;
		previewEntry = null;
		await deleteIds([n.id]);
	}

	function renameSelectedItem() {
		if (selectedEntries.length !== 1) return;
		startRename(selectedEntries[0]!);
	}

	async function confirmPreviewSend() {
		const n = previewEntry;
		if (!n || !onSendFile) return;
		previewBusy = true;
		try {
			await onSendFile(n);
			previewEntry = null;
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	function isRowControl(t: EventTarget | null): boolean {
		return t instanceof Element && !!t.closest('input, button, a, [contenteditable="true"]');
	}

	function toggleSelect(id: string, e?: Event) {
		if (!canToggleSelect()) return;
		e?.stopPropagation();
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
		lastSelectedId = next.has(id) ? id : next.size ? [...next][next.size - 1]! : null;
	}

	/**
	 * Rows are native-draggable. Chrome often swallows the following `click`
	 * after mousedown on a draggable node, so selection is committed on
	 * pointerup when the pointer didn't travel (and on click as a fallback
	 * for tests / non-draggable rows).
	 */
	const SELECT_SLOP_PX = 6;
	let press:
		| {
				id: string;
				x: number;
				y: number;
				index: number;
				pointerId: number;
				rowEl: HTMLElement | null;
		  }
		| null = null;
	let dragStarted = false;
	let selectedOnPointerUp = false;
	/** Skip the second pointerup of a double-click so multi-select doesn't toggle off. */
	let lastRowActivate: { id: string; at: number } | null = null;
	const DBLCLICK_MS = 500;

	function onRowPointerDown(e: PointerEvent, n: ExplorerEntry, i: number) {
		if (e.button != null && e.button !== 0) return;
		if (isRowControl(e.target)) return;
		press = {
			id: n.id,
			x: e.clientX,
			y: e.clientY,
			index: i,
			pointerId: e.pointerId,
			rowEl: e.currentTarget instanceof HTMLElement ? e.currentTarget : null
		};
		dragStarted = false;
		selectedOnPointerUp = false;
		const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
		if (isTouch && dragOutEnabled && renamingId !== n.id) {
			if (longPressTimer) clearTimeout(longPressTimer);
			attachPointerListeners();
			longPressTimer = setTimeout(() => {
				longPressTimer = null;
				beginPointerDrag();
			}, TOUCH_DRAG_DELAY_MS);
		}
	}

	function onRowPointerUp(e: PointerEvent, n: ExplorerEntry) {
		if (!press || press.id !== n.id) return;
		const start = press;
		press = null;
		if (dragStarted || isRowControl(e.target)) return;
		const dx = e.clientX - start.x;
		const dy = e.clientY - start.y;
		if (dx * dx + dy * dy > SELECT_SLOP_PX * SELECT_SLOP_PX) return;
		focusIndex = start.index;
		selectedOnPointerUp = true;
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		if (lastRowActivate && lastRowActivate.id === n.id && now - lastRowActivate.at < DBLCLICK_MS) {
			return;
		}
		lastRowActivate = { id: n.id, at: now };
		void applyRowActivate(n, e);
	}

	function onRowClick(e: MouseEvent, n: ExplorerEntry, i: number) {
		if (isRowControl(e.target)) return;
		if (e.detail > 1) return;
		if (selectedOnPointerUp) {
			selectedOnPointerUp = false;
			return;
		}
		focusIndex = i;
		void applyRowActivate(n, e);
	}

	function onRowDblClick(e: MouseEvent, n: ExplorerEntry, i: number) {
		if (isRowControl(e.target)) return;
		if (renamingId === n.id) return;
		e.preventDefault();
		e.stopPropagation();
		focusIndex = i;
		selectExclusive(n);
		void openRow(n);
	}

	async function openRow(n: ExplorerEntry) {
		if (n.kind === 'folder') {
			await enterFolder(n);
			return;
		}
		if (await openPackedEntry(n)) return;
		if (!rowActionable(n)) return;
		if (onOpen && (mode === 'open' || mode === 'manage')) {
			await emitOpen(n);
			return;
		}
		if (mode === 'save') saveName = n.name;
	}

	async function applyRowActivate(n: ExplorerEntry, e?: Event) {
		if (canToggleSelect()) {
			toggleSelect(n.id, e);
			return;
		}
		if (n.kind === 'folder' && mode === 'save') {
			await enterFolder(n);
			return;
		}
		if (mode === 'save' && n.kind === 'file') {
			saveName = n.name;
		}
		selectExclusive(n);
	}

	const selectedEntries = $derived(
		[...selected]
			.map((id) => nodes.find((n) => n.id === id))
			.filter((n): n is ExplorerEntry => !!n)
	);

	/** Toolbar download button: shown when this driver can hand out blobs. */
	const supportsDownload = $derived(
		Boolean((driver.download || driver.downloadUrl) && caps.supportsDownload)
	);
	const listPending = $derived([...pending, ...saveOps, ...inboundOps]);
	const listingRows = $derived(mergeListingWithPending(nodes, listPending, parentId));
	/** Enabled only when at least one selected row is a downloadable file. */
	const canDownloadSelection = $derived(selectedEntries.some((e) => e.kind === 'file'));

	/** Open appears once something is selected that we can enter or hand off. */
	const canOpenSelection = $derived.by(() => {
		if (selectedEntries.length === 0) return false;
		if (selectedEntries.some((e) => e.kind === 'folder')) return true;
		if (mode === 'manage' && selectedEntries.some((e) => e.kind === 'file' && looksPackedName(e.name))) {
			return true;
		}
		if (
			onOpen &&
			(mode === 'open' || mode === 'manage') &&
			selectedEntries.some((e) => e.kind === 'file' && rowActionable(e))
		) {
			return true;
		}
		if (mode === 'save' && selectedEntries.some((e) => e.kind === 'file')) return true;
		return false;
	});

	const canDecompressSelection = $derived(
		selectedEntries.length > 0 && selectedEntries.every((e) => e.kind === 'file' && looksCompressedName(e.name))
	);
	const canDecryptSelection = $derived(
		selectedEntries.length > 0 && selectedEntries.every((e) => e.kind === 'file' && looksVaultName(e.name))
	);

	async function openSelected() {
		if (!selectedEntries.length) return;
		const last = lastSelectedId
			? selectedEntries.find((e) => e.id === lastSelectedId)
			: undefined;
		const files = selectedEntries.filter((e) => e.kind === 'file' && rowActionable(e));
		const folders = selectedEntries.filter((e) => e.kind === 'folder');
		const packedFile =
			last?.kind === 'file' && looksPackedName(last.name)
				? last
				: (selectedEntries.find((e) => e.kind === 'file' && looksPackedName(e.name)) ?? null);
		if (packedFile && mode === 'manage') {
			await openPackedEntry(packedFile);
			return;
		}
		const primaryFile =
			last?.kind === 'file' && rowActionable(last) ? last : (files[0] ?? null);
		const primaryFolder = last?.kind === 'folder' ? last : (folders[0] ?? null);
		if (primaryFile && onOpen && (mode === 'open' || mode === 'manage')) {
			await emitOpen(primaryFile);
			return;
		}
		if (primaryFolder) {
			await enterFolder(primaryFolder);
			return;
		}
		if (mode === 'save' && primaryFile) {
			saveName = primaryFile.name;
		}
	}

	function idsForClipboard(): string[] {
		if (selected.size > 0) return [...selected];
		const n = focusedNode();
		return n ? [n.id] : [];
	}

	function cutSelection() {
		if (mode !== 'manage' || !caps.supportsMove) return;
		const ids = idsForClipboard();
		if (!ids.length) return;
		clipboard = { mode: 'cut', ids };
	}

	function copySelection() {
		if (mode !== 'manage' || !caps.supportsCopy) return;
		const ids = idsForClipboard();
		if (!ids.length) return;
		clipboard = { mode: 'copy', ids };
	}

	async function pasteClipboard() {
		if (mode !== 'manage' || !clipboard?.ids.length) return;
		error = '';
		try {
			for (const id of clipboard.ids) {
				if (clipboard.mode === 'cut') {
					if (!driver.move || !caps.supportsMove) throw new Error('MOVE_UNSUPPORTED');
					await driver.move(id, parentId);
				} else {
					if (!driver.copy || !caps.supportsCopy) throw new Error('COPY_UNSUPPORTED');
					await driver.copy(id, parentId);
				}
			}
			if (clipboard.mode === 'cut') clipboard = null;
			selected = new Set();
			await refresh();
		} catch (e) {
			reportError(e);
		}
	}

	async function copyNode(n: ExplorerEntry) {
		if (mode !== 'manage' || !driver.copy || !caps.supportsCopy) return;
		try {
			await driver.copy(n.id, parentId);
			await refresh();
		} catch (e) {
			reportError(e);
		}
	}

	async function downloadNode(n: ExplorerEntry) {
		if (!caps.supportsDownload || n.kind !== 'file') return;
		try {
			if (driver.downloadUrl) {
				const loc = await driver.downloadUrl(n.id);
				if (loc && httpDownloadIsSafe(loc.url)) {
					// Chrome's download manager GETs the URL → real shelf progress.
					triggerHttpDownload(loc.url, loc.filename);
					return;
				}
			}
			if (!driver.download) return;
			const opId = generateId('dl');
			saveOps = [
				...saveOps,
				{
					id: opId,
					name: n.name,
					transferred: 0,
					size: n.size ?? 0,
					direction: 'receiving'
				}
			];
			try {
				await saveFileToDisk({
					filename: n.name,
					download: (opts) => driver.download!(n.id, opts),
					onProgress: (transferred, total) => {
						saveOps = saveOps.map((o) =>
							o.id === opId
								? { ...o, transferred, size: total ?? o.size }
								: o
						);
					}
				});
			} finally {
				saveOps = saveOps.filter((o) => o.id !== opId);
			}
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') return;
			reportError(e);
		}
	}

	/** Download every selected file to the PC. Folders are left in place. */
	async function downloadSelected() {
		const files = selectedEntries.filter((e) => e.kind === 'file');
		if (files.length === 0) return;
		downloadBusy = true;
		try {
			// Sequential so each is its own browser download; a failed blob
			// (downloadNode catches per-file) doesn't stop the rest.
			for (const n of files) {
				await downloadNode(n);
			}
		} finally {
			downloadBusy = false;
		}
	}

	const canImportFromDevice = $derived(Boolean(driver.upload || driver.writeFile));
	/** File-picker chrome is local writeFile only; remotes import via drop / copy-across. */
	const showDeviceFilePicker = $derived(Boolean(driver.writeFile));

	async function refreshSystemClipboard() {
		if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return;
		try {
			const items = await navigator.clipboard.read();
			const next = await payloadFromClipboardItems(items);
			if (next) systemClip = next;
		} catch {
			/* permission / unsupported — keep last snapshot from paste */
		}
	}

	async function pasteSystemClipboard() {
		if (mode !== 'manage' || !canImportFromDevice) return;
		let payload = systemClip;
		if (!payload?.files.length) {
			await refreshSystemClipboard();
			payload = systemClip;
		}
		if (!payload?.files.length) {
			reportMessage('Clipboard is empty or not readable');
			return;
		}
		await importDeviceFiles(payload.files, parentId);
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		if (mode !== 'manage') return;
		const onPaste = (e: ClipboardEvent) => {
			const next = payloadFromDataTransfer(e.clipboardData);
			if (next) systemClip = next;
		};
		const onFocus = () => void refreshSystemClipboard();
		const onVis = () => {
			if (document.visibilityState === 'visible') void refreshSystemClipboard();
		};
		document.addEventListener('paste', onPaste, true);
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVis);
		document.addEventListener('clipboardchange', onFocus);
		void refreshSystemClipboard();
		return () => {
			document.removeEventListener('paste', onPaste, true);
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVis);
			document.removeEventListener('clipboardchange', onFocus);
		};
	});

	async function importOsNodes(
		dropNodes: Promise<OsDropNode[]>,
		destParentId: string | null = parentId
	) {
		if (!(driver.upload || driver.writeFile)) return;
		uploadBusy = true;
		error = '';
		const ids: string[] = [];
		const idByName = new Map<string, string>();
		const bump = (ev: OsDropFileProgress) => {
			let id = idByName.get(ev.name);
			if (!id) {
				id = generateId('osdrop');
				idByName.set(ev.name, id);
				ids.push(id);
			}
			const row: ListingPending = {
				id,
				name: ev.name,
				transferred: ev.transferred,
				size: ev.size,
				direction: 'receiving',
				done: ev.done
			};
			inboundOps = inboundOps.some((o) => o.id === id)
				? inboundOps.map((o) => (o.id === id ? row : o))
				: [...inboundOps, row];
		};
		try {
			const incoming = await dropNodes;
			if (!incoming.length) return;
			await importOsDropToDriver(driver, destParentId, incoming, { onFile: bump });
			await refresh();
		} catch (e) {
			reportError(e);
		} finally {
			inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
			uploadBusy = false;
		}
	}

	async function importDeviceFiles(files: File[], destParentId: string | null = parentId) {
		if (!files.length) return;
		await importOsNodes(snapshotFiles(files), destParentId);
	}

	function allowOsFileDrag(e: DragEvent): boolean {
		if (mode !== 'manage' || !canImportFromDevice) return false;
		if (dnd.getState().active) return false;
		return dataTransferHasOsFiles(e.dataTransfer);
	}

	function onListDragOver(e: DragEvent) {
		if (allowOsFileDrag(e)) {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			osDropOver = true;
			return;
		}
		if (!dnd.getState().active) return;
		// empty list / padding → drop into current parent
		if ((e.target as HTMLElement).closest?.('.fe-row')) return;
		e.preventDefault();
		hoverGapAfterLast();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onListDragLeave(e: DragEvent) {
		const next = e.relatedTarget;
		if (next instanceof Node && (e.currentTarget as Node).contains(next)) return;
		osDropOver = false;
	}

	function onListDrop(e: DragEvent) {
		if (allowOsFileDrag(e)) {
			e.preventDefault();
			e.stopPropagation();
			osDropOver = false;
			// Capture entries/files now — directory File objects die after this handler.
			const pending = collectOsDrop(e.dataTransfer);
			void importOsNodes(pending, parentId);
			return;
		}
		if (!dnd.getState().active) return;
		e.preventDefault();
		e.stopPropagation();
		const target = dndTargetId ? (nodes.find((x) => x.id === dndTargetId) ?? null) : null;
		void commitDndDrop(target);
	}

	function onListKeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (innerFs && variant !== 'dialog') {
				void closeInnerFs();
				return;
			}
			if (archiveDialogOpen) {
				hideArchiveDialog();
				return;
			}
			if (trashOpen) {
				trashOpen = false;
				return;
			}
			if (previewEntry) {
				previewEntry = null;
				return;
			}
			if (selected.size > 0) {
				selected = new Set();
				lastSelectedId = null;
				focusIndex = -1;
				return;
			}
			if (variant === 'dialog' && onClose) onClose();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!nodes.length) return;
			focusIndex = Math.min(nodes.length - 1, Math.max(0, focusIndex) + 1);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (!nodes.length) return;
			focusIndex = Math.max(0, (focusIndex < 0 ? 0 : focusIndex) - 1);
			return;
		}
		if (e.key === 'Enter') {
			if (previewEntry) {
				e.preventDefault();
				if (previewEntry.kind === 'folder' || onOpen) void confirmPreviewOpen();
				return;
			}
			if (canOpenSelection) {
				e.preventDefault();
				void openSelected();
				return;
			}
			const focused = focusedNode();
			if (focused) {
				e.preventDefault();
				selectExclusive(focused);
			}
			return;
		}
		if (e.key === ' ' || e.key === 'Spacebar') {
			const n = focusedNode();
			if (n) {
				e.preventDefault();
				if (canToggleSelect()) toggleSelect(n.id);
				else selectExclusive(n);
			}
			return;
		}
		if (e.key === 'F2') {
			const n = focusedNode();
			if (n && mode === 'manage' && !trashOpen && caps.supportsRename) {
				e.preventDefault();
				startRename(n);
			}
			return;
		}
		if (e.key === 'Escape' && trashOpen) {
			e.preventDefault();
			trashOpen = false;
			return;
		}
		if (e.key === 'Delete') {
			if (mode === 'manage' && !trashOpen) {
				e.preventDefault();
				void trashFocusedOrSelected();
			}
			return;
		}
		if (e.key === 'Backspace') {
			e.preventDefault();
			if ((e.metaKey || e.ctrlKey) && mode === 'manage' && !trashOpen) {
				void trashFocusedOrSelected();
			} else {
				void goUp();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
			if (mode === 'manage' && caps.supportsCopy) {
				e.preventDefault();
				copySelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
			if (mode === 'manage' && caps.supportsMove) {
				e.preventDefault();
				cutSelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
			if (mode !== 'manage') return;
			if (clipboard?.ids.length && (caps.supportsMove || caps.supportsCopy)) {
				e.preventDefault();
				void pasteClipboard();
				return;
			}
			if (canImportFromDevice) {
				e.preventDefault();
				void pasteSystemClipboard();
			}
		}
	}

	// $derived, not const: these are props, so a plain const froze the testid at
	// the initial value if a caller ever toggled variant.
	const rootTestId = $derived(
		compatLibraryTestId ? 'library-modal' : compatSaveTestId ? 'save-modal' : 'file-explorer'
	);
	const renameTip = $derived(selected.size === 1 ? 'Rename' : 'Select one item to rename');
	const deleteTip = $derived(selected.size ? 'Delete' : 'Select an item to delete');
	const cutTip = $derived(selected.size && caps.supportsMove ? 'Cut' : 'Select an item to cut');
	const copyTip = $derived(selected.size && caps.supportsCopy ? 'Copy' : 'Select an item to copy');
	const detailsTip = $derived(selected.size ? 'Details' : 'Select an item for details');
	const uploadTip = $derived(uploadBusy ? 'Uploading…' : 'Select file');
	const previewTip = $derived(
		previewDock === 'off'
			? 'Show preview below the list'
			: previewDock === 'bottom'
				? 'Move preview beside the list'
				: 'Hide preview'
	);
	const treeTip = $derived(
		treeDock === 'off'
			? 'Show folder tree on the left'
			: treeDock === 'left'
				? 'Move folder tree above the list'
				: 'Hide folder tree'
	);
	const pasteTip = $derived(
		clipboard?.mode === 'cut' ? 'Paste (move)' : clipboard ? 'Paste (copy)' : 'Paste'
	);
	const systemPasteTip = $derived(
		systemClip?.label ?? 'Paste from clipboard (file, image, or text)'
	);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fe-root {variant} {className}"
	class:preview-bottom={previewDock === 'bottom'}
	class:preview-right={previewDock === 'right'}
	data-testid={rootTestId}
	data-fe-backend={driver.id}
	data-fe-mode={mode}
	data-fe-select-multi={selectMulti ? 'on' : 'off'}
	data-fe-preview-dock={previewDock}
	data-fe-tree-dock={treeDock}
	data-fe-view-mode={viewMode}
	data-fe-show-preview={showPreview ? 'on' : 'off'}
	style="--preview-ratio: {previewRatio * 100}%"
	role={variant === 'dialog' ? 'dialog' : 'group'}
	aria-label="File explorer"
	tabindex="0"
	onkeydown={onListKeydown}
	onclick={() => { if (viewSwitcherOpen) closeViewSwitcher(); }}
>
	<header class="fe-header" data-testid="fe-header">
		<div class="fe-header-left">
			{#if headerLeading}
				<div class="fe-header-leading" data-testid="fe-header-leading">
					{@render headerLeading()}
				</div>
			{/if}
			{#if driver.id !== 'memory'}
				<nav
					class="fe-pathbar"
					class:drop-ready={moveDragActive}
					data-testid="fe-breadcrumbs"
					aria-label="Current folder"
				>
					<button
						type="button"
						class="fe-crumb"
						class:drop-target={moveDragActive && dndIntoId === null}
						data-testid="fe-crumb-root"
						data-fe-drop-parent=""
						onclick={() => goCrumb(null)}
						ondragover={(e) => onNavDragOver(e, null)}
						ondrop={(e) => onNavDrop(e, null)}
					>
						Root
					</button>
					{#each breadcrumbs as crumb (crumb.id)}
						<span class="fe-sep">/</span>
						<button
							type="button"
							class="fe-crumb"
							class:drop-target={moveDragActive && dndIntoId === crumb.id}
							data-testid="fe-crumb"
							data-id={crumb.id}
							data-fe-drop-parent={crumb.id}
							onclick={() => goCrumb(crumb.id)}
							ondragover={(e) => onNavDragOver(e, crumb.id)}
							ondrop={(e) => onNavDrop(e, crumb.id)}
						>
							{crumb.name}
						</button>
					{/each}
				</nav>
			{/if}
		</div>
		{#if moveDragActive}
			<div class="fe-move-banner" data-testid="fe-move-banner" role="status" aria-live="polite">
				{moveDragLabel}
			</div>
		{/if}
		{#if !headerLeading}
			<CopyProgressHeader
				items={visibleArchiveOps}
				onDismiss={(id) => {
					abortTransfer(id);
					if (id === archiveTransferId) abortArchiveJob();
					archiveDismissed = new Set([...archiveDismissed, id]);
				}}
				onDismissAll={() => {
					const next = new Set(archiveDismissed);
					for (const t of visibleArchiveOps) {
						if (t.done || t.status === 'failed') next.add(t.id);
					}
					archiveDismissed = next;
				}}
			/>
		{/if}
		<div class="fe-toolbar" data-testid="fe-toolbar">
			<div class="fe-toolbar-row">
				{#if mode === 'manage' || mode === 'open'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						class="fe-view-switcher-wrap"
						data-testid="fe-view-switcher"
						onclick={(e) => e.stopPropagation()}
					>
						<FeTipIconBtn
							testid="fe-view-switcher-btn"
							tip="View options"
							icon={viewMode === 'icons' ? 'layout-grid' : viewMode === 'detailed' ? 'table' : 'list'}
							active={viewSwitcherOpen}
							pressed={viewSwitcherOpen}
							haspopup
							onclick={toggleViewSwitcher}
						/>
						{#if viewSwitcherOpen}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="fe-view-popup" data-testid="fe-view-popup" onclick={(e) => e.stopPropagation()}>
								<button type="button" class="fe-view-option" class:active={viewMode === 'list'} data-testid="fe-view-list" onclick={() => setViewMode('list')}>
									<FeIcon name="list" size={16} />
									<span>List</span>
								</button>
								<button type="button" class="fe-view-option" class:active={viewMode === 'icons'} data-testid="fe-view-icons" onclick={() => setViewMode('icons')}>
									<FeIcon name="layout-grid" size={16} />
									<span>Icons</span>
								</button>
								<button type="button" class="fe-view-option" class:active={viewMode === 'detailed'} data-testid="fe-view-detailed" onclick={() => setViewMode('detailed')}>
									<FeIcon name="table" size={16} />
									<span>Detailed</span>
								</button>
								<div class="fe-view-divider"></div>
								<button type="button" class="fe-view-option fe-view-checkbox" class:active={showPreview} data-testid="fe-view-show-preview" onclick={toggleShowPreview}>
									<FeIcon name="eye" size={16} />
									<span>Show preview</span>
									<span class="fe-view-check">{showPreview ? '✓' : ''}</span>
								</button>
							</div>
						{/if}
					</span>
				{/if}
				{#if showPersistChip && localVfs}
					<StoragePersistenceStatus vfs={localVfs} compact class="fe-persist-slot" />
				{/if}
				{#if mode === 'manage' && canImportFromDevice}
					<FeTipIconBtn
						testid="fe-system-paste"
						tip={systemPasteTip}
						icon="clipboard-paste"
						disabled={!systemClip?.files.length || uploadBusy}
						active={Boolean(systemClip?.files.length)}
						onclick={() => void pasteSystemClipboard()}
					/>
				{/if}
				{#if mode === 'manage' || mode === 'open'}
					<FeTipIconBtn
						testid="fe-select-multi"
						tip="Select multiple items"
						icon="check-square"
						active={selectMulti}
						pressed={selectMulti}
						onclick={() => setSelectMulti(!selectMulti)}
					/>
					<FeTipIconBtn
						testid="fe-item-details"
						tip={detailsTip}
						icon="info"
						disabled={selected.size === 0}
						onclick={() => openSelectedDetails()}
					/>
					{#if driver.id !== 'memory'}
						<FeTipIconBtn
							testid="fe-tree-dock"
							tip={treeTip}
							icon="panel-left"
							active={treeDock !== 'off'}
							pressed={treeDock !== 'off'}
							onclick={cycleTreeDock}
						/>
					{/if}
					<FeTipIconBtn
						testid="fe-preview-layout"
						tip={previewTip}
						icon="layout"
						active={previewDock !== 'off'}
						pressed={previewDock !== 'off'}
						onclick={cyclePreviewDock}
					/>
				{/if}
				{#if canOpenSelection}
					<FeTipIconBtn
						testid="fe-open-selected"
						tip="Open"
						icon="folder-open"
						onclick={() => void openSelected()}
					/>
				{/if}
				{#if mode === 'manage'}
					{#if caps.supportsMkdir}
						<FeTipIconBtn
							testid="fe-new-folder"
							tip="New folder"
							icon="folder-plus"
							onclick={() => (newFolderOpen = true)}
						/>
					{/if}
					{#if showDeviceFilePicker}
						<FeTipIconBtn
							testid="fe-upload"
							tip={uploadTip}
							icon="upload"
							disabled={uploadBusy}
							onclick={() => fileInputEl?.click()}
						/>
						<input
							bind:this={fileInputEl}
							type="file"
							multiple
							hidden
							data-testid="fe-upload-input"
							onchange={(e) => {
								const list = (e.currentTarget as HTMLInputElement).files;
								if (!list?.length) return;
								const el = e.currentTarget;
								void importDeviceFiles(Array.from(list), parentId).finally(() => {
									el.value = '';
								});
							}}
						/>
					{/if}
					{#if caps.supportsTrash && !hideToolbarTrash}
						<FeTipIconBtn
							testid="fe-trash-view"
							tip="Open trash"
							icon="archive"
							active={trashOpen}
							pressed={trashOpen}
							haspopup
							onclick={() => void toggleTrashPopup()}
						/>
					{/if}
					{#if supportsDownload}
						<FeTipIconBtn
							testid="fe-download-selected"
							tip="Download selected to PC"
							icon="download"
							disabled={downloadBusy || !canDownloadSelection}
							onclick={() => void downloadSelected()}
						/>
					{/if}
					{#if toolbarExtra}
						{@render toolbarExtra({ variant: 'icon' })}
					{/if}
					{#if clipboard?.ids.length && (caps.supportsMove || caps.supportsCopy)}
						<FeTipIconBtn
							testid="fe-paste"
							tip={pasteTip}
							icon="clipboard"
							onclick={() => pasteClipboard()}
						/>
					{/if}
				{/if}
				{#if onClose}
					<FeTipIconBtn testid="fe-close" tip="Close" icon="x" onclick={onClose} />
				{/if}
			</div>
			{#if mode === 'manage'}
				<div
					class="fe-toolbar-row fe-selection-actions"
					data-testid="fe-selection-actions"
					aria-label="Selection actions"
				>
					<FeTipIconBtn
						testid="fe-rename-btn"
						tip={renameTip}
						icon="pencil"
						disabled={listBusy || selected.size !== 1 || !caps.supportsRename}
						onclick={renameSelectedItem}
					/>
					<FeTipIconBtn
						testid="fe-trash-selected"
						tip={deleteTip}
						icon="trash"
						disabled={selected.size === 0}
						onclick={trashSelected}
					/>
					<FeTipIconBtn
						testid="fe-cut"
						tip={cutTip}
						icon="scissors"
						disabled={selected.size === 0 || !caps.supportsMove}
						onclick={cutSelection}
					/>
					<FeTipIconBtn
						testid="fe-copy"
						tip={copyTip}
						icon="copy"
						disabled={selected.size === 0 || !caps.supportsCopy}
						onclick={copySelection}
					/>
					<FeTipIconBtn
						testid="fe-compress-selected"
						tip="Compress"
						icon="file-archive"
						disabled={selected.size === 0}
						onclick={() => startArchive('compress', selectedEntries)}
					/>
					<FeTipIconBtn
						testid="fe-encrypt-selected"
						tip="Encrypt"
						icon="lock"
						disabled={selected.size === 0}
						onclick={() => startArchive('encrypt', selectedEntries)}
					/>
					<FeTipIconBtn
						testid="fe-decompress-selected"
						tip="Decompress"
						icon="package-open"
						disabled={!canDecompressSelection}
						onclick={() => startArchive('decompress', selectedEntries)}
					/>
					<FeTipIconBtn
						testid="fe-decrypt-selected"
						tip="Decrypt"
						icon="unlock"
						disabled={!canDecryptSelection}
						onclick={() => startArchive('decrypt', selectedEntries)}
					/>
				</div>
			{/if}
		</div>
	</header>

	{#if error}
		<div class="fe-error" data-testid="fe-error" role="alert">{error}</div>
	{/if}

	{#if listTruncated}
		<div class="fe-truncated" data-testid="fe-list-truncated" role="status">
			Showing first 2000 items
		</div>
	{/if}

	{#if newFolderOpen && caps.supportsMkdir}
		<div class="fe-inline-form" data-testid="fe-new-folder-form">
			<input data-testid="fe-new-folder-input" bind:value={newFolderName} />
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="fe-new-folder-confirm"
				onclick={createFolder}>Create</button
			>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				onclick={() => (newFolderOpen = false)}>Cancel</button
			>
		</div>
	{/if}

	<div class="fe-body" data-fe-tree-dock={treeDock !== 'off' && driver.id !== 'memory' ? treeDock : 'off'}>
	{#if treeDock !== 'off' && driver.id !== 'memory'}
		<aside
			class="fe-tree-dock"
			data-testid="fe-tree-dock"
			data-placement={treeDock}
			aria-label="Folder tree"
			style="flex: 0 0 {treeRatio * 100}%"
		>
			<FeTreeView
				{driver}
				activeId={parentId}
				{treeVersion}
				onNavigate={goCrumb}
				dropActive={moveDragActive}
				dropTargetId={dndIntoId}
				onDragOverInto={hoverNavParent}
				onDropInto={(id) => void commitMoveInto(id)}
			/>
		</aside>
		<SplitHandle
			axis={treeDock === 'left' ? 'x' : 'y'}
			testid="fe-tree-split"
			ariaLabel="Resize folder tree"
			onRatioDelta={onTreeRatioDelta}
		/>
	{/if}
	<div class="fe-split">
	<div
		class="fe-list"
		class:fe-list-icons={viewMode === 'icons'}
		class:fe-list-detailed={viewMode === 'detailed'}
		tabindex="0"
		class:fe-list-busy={listBusy}
		class:fe-list-covered={showBusyOverlay}
		class:fe-list-pointer-dnd={pointerDragActive}
		data-testid="fe-list"
		role="listbox"
		aria-busy={listBusy ? 'true' : undefined}
		class:os-drop={osDropOver}
		bind:this={listEl}
		ondragover={onListDragOver}
		ondragleave={onListDragLeave}
		ondrop={onListDrop}
	>
		{#snippet pendingChrome(p: ListingPending, onIcon: boolean = false)}
			{@const behindPct = pendingPercent(p)}
			{@const aheadN = p.ready ?? p.transferred}
			{@const aheadPct = Math.min(100, Math.round(p.size ? (aheadN / p.size) * 100 : behindPct))}
			{@const stacked = aheadPct !== behindPct}
			<div
				class="fe-pending-bar"
				class:on-icon={onIcon}
				data-testid="fe-pending-bar"
				role="progressbar"
				aria-valuenow={behindPct}
				aria-valuemin="0"
				aria-valuemax="100"
				aria-label={`${p.name}: ${pendingLabel(p)}`}
			>
				<div class="fe-pending-fill ahead" style="width: {aheadPct}%"></div>
				<div class="fe-pending-fill behind" class:behind={stacked} style="width: {behindPct}%"></div>
			</div>
			<span class="fe-pending-pct" class:on-icon={onIcon}>{pendingLabel(p)}</span>
		{/snippet}
		{#if initialLoad && nodes.length === 0 && listingRows.length === 0}
			<div class="fe-empty" data-testid="fe-loading">Loading…</div>
		{:else if listingRows.length === 0}
			<div class="fe-empty" data-testid="fe-empty">
				No files here
			</div>
		{:else}
			{#each listingRows as row (row.key)}
				{@const n = row.node}
				{@const i = row.nodeIndex ?? -1}
				{@const p = row.pending}
				{@const actionable = !row.placeholder && rowActionable(n)}
				{@const showInto =
					!row.placeholder &&
					dndEnabled &&
					dndTargetId === n.id &&
					dndZone === 'into' &&
					n.kind === 'folder'}
				{@const previewKind = !row.placeholder && showPreview ? getPreviewKind(n) : null}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="fe-row"
					class:folder={n.kind === 'folder'}
					class:file={n.kind === 'file'}
					class:incompatible={!actionable && n.kind === 'file'}
					class:selected={!row.placeholder && selected.has(n.id)}
					class:previewed={!row.placeholder && previewEntry?.id === n.id}
					class:focused={!row.placeholder && i === focusIndex}
					class:fe-dnd-into={showInto}
					class:fe-dnd-dragging={!row.placeholder && dndDraggingIds.has(n.id)}
					class:fe-row-icon={viewMode === 'icons'}
					class:fe-row-detailed={viewMode === 'detailed'}
					class:renaming={!row.placeholder && renamingId === n.id}
					class:fe-pending={Boolean(p)}
					data-testid={row.placeholder
						? 'fe-pending-row'
						: n.kind === 'folder'
							? 'fe-folder-row'
							: 'fe-file-row'}
					data-pending-name={p?.name ?? undefined}
					data-fe-row-id={row.placeholder ? undefined : n.id}
					data-fe-parent-id={n.parentId ?? ''}
					data-fe-kind={n.kind}
					data-fe-sort-order={n.sortOrder ?? ''}
					data-file-type={n.fileType ?? ''}
					data-id={row.placeholder ? undefined : n.id}
					data-name={n.name}
					draggable={!row.placeholder && dragOutEnabled}
					aria-disabled={row.placeholder || (!actionable && n.kind === 'file') ? 'true' : undefined}
					aria-selected={!row.placeholder && selected.has(n.id)}
					role="option"
					tabindex="-1"
					ondragstart={row.placeholder ? undefined : (e) => onRowDragStart(e, n)}
					ondragover={row.placeholder ? undefined : (e) => onRowDragOver(e, n)}
					ondrop={row.placeholder ? undefined : (e) => onRowDrop(e, n)}
					ondragend={row.placeholder ? undefined : onRowDragEnd}
					onpointerdown={row.placeholder || i < 0 ? undefined : (e) => onRowPointerDown(e, n, i)}
					onpointerup={row.placeholder ? undefined : (e) => onRowPointerUp(e, n)}
					onpointercancel={() => {
						press = null;
						if (longPressTimer) {
							clearTimeout(longPressTimer);
							longPressTimer = null;
						}
					}}
					oncontextmenu={(e) => {
						if (pointerDragActive || longPressTimer) e.preventDefault();
					}}
					onclick={row.placeholder || i < 0 ? undefined : (e) => onRowClick(e, n, i)}
					ondblclick={row.placeholder || i < 0 ? undefined : (e) => onRowDblClick(e, n, i)}
				>
					{#if viewMode === 'icons'}
						<span class="fe-row-icon-thumb">
							{#if previewKind}
								<FeThumbnail entry={n} {driver} maxDim={120} enabled={showPreview} />
							{:else}
								<span class="fe-row-icon-fallback">
									<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={48} />
								</span>
							{/if}
							{#if p}
								{@render pendingChrome(p, true)}
							{/if}
						</span>
						<span class="fe-row-icon-name" title={n.name}>{#if renamingId === n.id}{@render renameEditor(n)}{:else}{n.name}{/if}</span>
					{:else if viewMode === 'detailed'}
						<span class="fe-row-main">
							<span class="fe-icon">
								{#if previewKind}
									<FeThumbnail entry={n} {driver} maxDim={32} enabled={showPreview} />
								{:else}
									<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={16} />
								{/if}
							</span>
							{#if renamingId === n.id}
								{@render renameEditor(n)}
							{:else}
								<span class="fe-name" title={!actionable && n.kind === 'file' ? 'Wrong type for this app' : n.name}
									>{n.name}</span
								>
							{/if}
						</span>
						<span class="fe-row-col fe-row-size">{n.size != null ? formatBytes(n.size) : '—'}</span>
						<span class="fe-row-col fe-row-type">{n.fileType ?? (n.kind === 'folder' ? 'Folder' : 'File')}</span>
						<span class="fe-row-col fe-row-modified">{n.updatedAt ? formatWhen(n.updatedAt) : '—'}</span>
					{:else}
						<span class="fe-row-main">
							<span class="fe-icon">
								{#if previewKind}
									<FeThumbnail entry={n} {driver} maxDim={32} enabled={showPreview} />
								{:else}
									<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={16} />
								{/if}
							</span>
							{#if renamingId === n.id}
								{@render renameEditor(n)}
							{:else}
								<span class="fe-name" title={!actionable && n.kind === 'file' ? 'Wrong type for this app' : n.name}
									>{n.name}</span
								>
							{/if}
						</span>
					{/if}
					{#if p && viewMode !== 'icons'}
						{@render pendingChrome(p, false)}
					{/if}
				</div>
			{/each}
			{#if dndEnabled && caps.supportsSiblingOrder && dndLine && (dndZone === 'before' || dndZone === 'after')}
				<div
					class="fe-dnd-line"
					class:vertical={dndLine.axis === 'x'}
					data-testid="fe-dnd-line"
					data-fe-dnd-zone={dndZone}
					data-fe-dnd-axis={dndLine.axis}
					style={dndLine.axis === 'y'
						? `top: ${dndLine.top}px; left: ${dndLine.left}px; width: ${dndLine.size}px`
						: `top: ${dndLine.top}px; left: ${dndLine.left}px; height: ${dndLine.size}px`}
					aria-hidden="true"
				></div>
			{/if}
		{/if}

		{#if showBusyOverlay}
			<div class="fe-busy-overlay" data-testid="fe-busy-overlay" aria-live="polite" aria-label="Updating file list">
				<div class="fe-spinner" aria-hidden="true"></div>
			</div>
		{/if}
	</div>
	{#if previewDock !== 'off'}
		<SplitHandle
			axis={previewDock === 'right' ? 'x' : 'y'}
			testid="fe-preview-split"
			ariaLabel="Resize preview pane"
			onRatioDelta={onPreviewRatioDelta}
		/>
		<aside
			class="fe-preview-dock"
			data-testid="fe-preview-dock"
			data-placement={previewDock}
			data-multi={selected.size > 1 ? 'true' : undefined}
			aria-label="File preview"
		>
			{#if selected.size > 1}
				{@render multiDetails(false)}
			{:else if previewEntry}
				{@render singleDetails(previewEntry, previewDock === 'right' ? 240 : 160, false)}
			{:else}
				<p class="fe-preview-empty">Select a file or folder</p>
			{/if}
		</aside>
	{/if}
	</div>
	</div>

	{#if mode === 'save'}
		<footer class="fe-save-bar" data-testid="fe-save-bar">
			<label>
				Name
				<input id="save-name" data-testid="fe-name-input" bind:value={saveName} />
			</label>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="fe-save-confirm"
				onclick={confirmSave}>Save</button
			>
		</footer>
	{/if}

	{#if previewEntry && previewDock === 'off'}
		<div
			class="fe-preview-backdrop"
			data-testid="fe-file-preview"
			data-multi={selected.size > 1 ? 'true' : undefined}
			role="dialog"
			aria-modal="true"
			aria-label={selected.size > 1 ? `${selected.size} items selected` : previewEntry.name}
		>
			<button
				type="button"
				class="fe-preview-scrim"
				aria-label="Close preview"
				onclick={() => (previewEntry = null)}
			></button>
			<div class="fe-preview-card" class:fe-preview-card-multi={selected.size > 1}>
				{#if selected.size > 1}
					{@render multiDetails(true)}
				{:else}
					{@render singleDetails(previewEntry, 200, true)}
				{/if}
			</div>
		</div>
	{/if}

	{#if trashOpen && caps.supportsTrash}
		<div
			class="fe-preview-backdrop"
			data-testid="fe-trash-popup"
			role="dialog"
			aria-modal="true"
			aria-label="Trash"
		>
			<button
				type="button"
				class="fe-preview-scrim"
				aria-label="Close trash"
				onclick={() => (trashOpen = false)}
			></button>
			<div class="fe-trash-card" data-emptying={emptyTrashRunning ? 'true' : undefined}>
				<div class="fe-trash-head">
					<h2 class="fe-preview-name">Trash</h2>
					{#if emptyTrashRunning}
						<button
							type="button"
							class="ds-btn ds-btn--sm ds-btn--ghost"
							data-testid="fe-empty-trash-abort"
							onclick={() => abortEmptyTrash()}
						>
							Cancel
						</button>
					{:else if trashNodes.length}
						<button
							type="button"
							class="ds-btn ds-btn--sm ds-btn--danger"
							data-testid="fe-empty-trash"
							disabled={trashBusy}
							onclick={() => void emptyTrash()}
						>
							Empty trash
						</button>
					{/if}
				</div>
				{#if emptyTrashRunning}
					<div class="fe-trash-progress" data-testid="fe-empty-trash-progress">
						<div
							class="fe-trash-progress-bar"
							role="progressbar"
							aria-valuemin="0"
							aria-valuemax="100"
							aria-valuenow={emptyTrashPct}
						>
							<div class="fe-trash-progress-fill" style="width: {emptyTrashPct}%"></div>
						</div>
						<span class="fe-trash-progress-label">{emptyTrashLabel} {emptyTrashPct}%</span>
					</div>
				{/if}
				{#if trashBusy && trashNodes.length === 0 && !emptyTrashRunning}
					<div class="fe-empty">Loading…</div>
				{:else if trashNodes.length === 0}
					<div class="fe-empty" data-testid="fe-trash-empty">Trash is empty</div>
				{:else}
					<div class="fe-trash-list">
						{#each trashNodes as n (n.id)}
							<div
								class="fe-row"
								class:folder={n.kind === 'folder'}
								class:file={n.kind === 'file'}
								data-testid={n.kind === 'folder' ? 'fe-folder-row' : 'fe-file-row'}
								data-id={n.id}
								data-name={n.name}
							>
								<span class="fe-row-main">
									<span class="fe-icon">
										<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={16} />
									</span>
									<span class="fe-name" title={n.name}>{n.name}</span>
								</span>
								<span class="fe-row-actions">
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--secondary"
										data-testid="fe-restore"
										disabled={trashBusy || emptyTrashRunning}
										onclick={() => void restoreNode(n)}>Restore</button
									>
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--danger"
										data-testid="fe-permanent-delete"
										disabled={trashBusy || emptyTrashRunning}
										onclick={() => void permanentNode(n)}>Delete forever</button
									>
								</span>
							</div>
						{/each}
					</div>
				{/if}
				<div class="fe-trash-foot">
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-trash-close"
						onclick={() => (trashOpen = false)}
					>
						Close
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if confirmPrompt}
		<FeConfirmDialog
			copy={confirmPrompt.copy}
			onConfirm={() => closeConfirm(true)}
			onCancel={() => closeConfirm(false)}
		/>
	{/if}

	{#if archiveDialogOpen && archiveKind && archiveEntries.length}
		<FeArchiveDialog
			kind={archiveKind}
			entries={archiveEntries}
			{driver}
			destLocked={archiveDestLocked}
			jobRunning={archiveJobRunning}
			jobPct={archiveJobPct}
			jobLabel={archiveJobLabel}
			onLaunch={(spec) => void launchArchive(spec)}
			onHide={hideArchiveDialog}
			onAbort={abortArchiveJob}
			onCancel={closeArchive}
		/>
	{/if}

	{#if innerFs}
		<div
			class="fe-inner-fs"
			data-testid="fe-inner-fs-dialog"
			role="dialog"
			aria-modal="true"
			aria-label={innerFs.title}
		>
			<button
				type="button"
				class="fe-inner-fs-scrim"
				aria-label="Close inner filesystem"
				onclick={() => void closeInnerFs()}
			></button>
			<div class="fe-inner-fs-card">
				<div class="fe-inner-fs-head">
					<h2 class="fe-preview-name">{innerFs.title}</h2>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-inner-fs-close"
						onclick={() => void closeInnerFs()}
					>
						Close
					</button>
				</div>
				<div class="fe-inner-fs-body">
					<FileExplorer
						driver={innerFs.driver}
						mode="manage"
						variant="dialog"
						showPersistence={false}
						hideToolbarTrash
						onClose={() => void closeInnerFs()}
					/>
				</div>
			</div>
		</div>
	{/if}

	{#if floatingPreviewEntry}
		<FeFloatingPreview
			entry={floatingPreviewEntry}
			{driver}
			onClose={() => (floatingPreviewEntry = null)}
		/>
	{/if}
</div>

{#snippet renameEditor(n: ExplorerEntry)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		class="fe-rename"
		bind:this={renameRootEl}
		onclick={(e) => e.stopPropagation()}
		onpointerdown={(e) => e.stopPropagation()}
	>
		<input
			data-testid="fe-rename-input"
			bind:value={renameValue}
			aria-label="Rename"
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					void commitRename(n);
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					cancelRename();
				}
			}}
			onblur={() => scheduleCommitRename(n)}
		/>
		<button
			type="button"
			class="fe-rename-action"
			data-testid="fe-rename-ok"
			aria-label="Save name"
			onpointerdown={(e) => {
				e.preventDefault();
				clearRenameBlur();
			}}
			onclick={() => void commitRename(n)}
		>
			<FeIcon name="check" size={14} />
		</button>
		<button
			type="button"
			class="fe-rename-action fe-rename-cancel"
			data-testid="fe-rename-cancel"
			aria-label="Cancel rename"
			onpointerdown={(e) => {
				e.preventDefault();
				clearRenameBlur();
			}}
			onclick={cancelRename}
		>
			<FeIcon name="x" size={14} />
		</button>
	</span>
{/snippet}

{#snippet archiveButtons(entry: ExplorerEntry)}
	<button
		type="button"
		class="ds-btn ds-btn--sm ds-btn--secondary"
		data-testid="fe-file-preview-compress"
		onclick={() => startArchive('compress', [entry])}
	>
		Compress
	</button>
	<button
		type="button"
		class="ds-btn ds-btn--sm ds-btn--secondary"
		data-testid="fe-file-preview-encrypt"
		onclick={() => startArchive('encrypt', [entry])}
	>
		Encrypt
	</button>
	{#if entry.kind === 'file' && looksCompressedName(entry.name)}
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="fe-file-preview-decompress"
			onclick={() => startArchive('decompress', [entry])}
		>
			Decompress
		</button>
	{/if}
	{#if entry.kind === 'file' && looksVaultName(entry.name)}
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="fe-file-preview-decrypt"
			onclick={() => startArchive('decrypt', [entry])}
		>
			Decrypt
		</button>
	{/if}
	{#if entry.kind === 'file' && looksPackedName(entry.name)}
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="fe-file-preview-open-archive"
			onclick={() => void openPackedEntry(entry)}
		>
			{looksVaultName(entry.name) ? 'Open vault' : 'Open archive'}
		</button>
	{/if}
{/snippet}

{#snippet detailsCopyAcross()}
	{#if toolbarExtra}
		{@render toolbarExtra({ variant: 'label' })}
	{/if}
{/snippet}

{#snippet singleDetails(entry: ExplorerEntry, maxDim: number, showClose: boolean)}
	<h2 class="fe-preview-name" data-testid="fe-file-preview-name">{entry.name}</h2>
	{#if showPreview && entry.kind === 'file' && getPreviewKind(entry)}
		<div class="fe-preview-thumb" data-testid="fe-preview-thumb">
			<FeThumbnail {entry} {driver} {maxDim} enabled={true} />
		</div>
	{/if}
	<dl class="fe-preview-meta">
		<div>
			<dt>Size</dt>
			<dd data-testid="fe-file-preview-size">{formatBytes(entry.size)}</dd>
		</div>
		{#if entry.fileType}
			<div>
				<dt>Type</dt>
				<dd data-testid="fe-file-preview-type">{entry.fileType}</dd>
			</div>
		{/if}
		{#if entry.contentType}
			<div>
				<dt>MIME</dt>
				<dd>{entry.contentType}</dd>
			</div>
		{/if}
		{#if entry.updatedAt}
			<div>
				<dt>Updated</dt>
				<dd>{formatWhen(entry.updatedAt)}</dd>
			</div>
		{/if}
	</dl>
	<div
		class="fe-preview-actions"
		data-fe-is-project={
			entry.kind === 'folder' && previewIsProject != null
				? previewIsProject
					? 'true'
					: 'false'
				: undefined
		}
	>
		{#if entry.kind === 'file' && getPreviewKind(entry)}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-file-preview-float"
				onclick={openFloatingPreview}
			>
				<FeIcon name="maximize-2" size={14} />
				Preview
			</button>
		{/if}
		{#if previewShowsOpen(entry)}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="fe-file-preview-open"
				disabled={previewBusy}
				onclick={() => void confirmPreviewOpen()}
			>
				{entry.kind === 'folder' ? 'Open' : defaultOpenLabel(entry)}
			</button>
		{/if}
		{#if onOpenProject && entry.kind === 'folder' && previewIsProject !== false}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-open-project"
				disabled={previewBusy}
				onclick={() => void confirmOpenProject()}
			>
				Open project
			</button>
		{/if}
		{#if onInitProject && entry.kind === 'folder' && previewIsProject !== true}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-init-project"
				disabled={previewBusy}
				onclick={() => void confirmInitProject()}
			>
				Init project
			</button>
		{/if}
		{#if onSendFile && entry.kind === 'file'}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="fe-file-preview-send"
				disabled={previewBusy}
				onclick={() => void confirmPreviewSend()}
			>
				{sendLabel}
			</button>
		{/if}
		{#if mode === 'manage'}
			{#if caps.supportsRename}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-rename-btn"
					disabled={listBusy}
					onclick={renamePreviewItem}
				>
					Rename
				</button>
			{/if}
			{#if caps.supportsCopy && entry.kind === 'file'}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-row-copy"
					disabled={listBusy}
					onclick={() => void copyPreviewItem()}
				>
					Copy
				</button>
			{/if}
			{#if caps.supportsDownload && entry.kind === 'file'}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-row-download"
					disabled={listBusy}
					onclick={() => void downloadNode(entry)}
				>
					Download
				</button>
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--danger"
				data-testid="fe-row-trash"
				disabled={listBusy}
				onclick={() => void deletePreviewItem()}
			>
				Delete
			</button>
			{@render archiveButtons(entry)}
			{@render detailsCopyAcross()}
		{/if}
		{#if showClose}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="fe-file-preview-close"
				onclick={() => (previewEntry = null)}
			>
				Close
			</button>
		{/if}
	</div>
{/snippet}

{#snippet multiDetails(showClose: boolean)}
	<h2 class="fe-preview-name" data-testid="fe-file-preview-name">
		{selected.size} items selected
	</h2>
	<ul class="fe-preview-items" data-testid="fe-file-preview-items">
		{#each selectedEntries as n (n.id)}
			<li data-testid="fe-file-preview-item" data-name={n.name} data-kind={n.kind}>
				<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={14} />
				<span class="fe-preview-item-name">{n.name}</span>
				{#if n.size != null}
					<span class="fe-preview-item-size">{formatBytes(n.size)}</span>
				{/if}
			</li>
		{/each}
	</ul>
	<dl class="fe-preview-meta">
		<div>
			<dt>Items</dt>
			<dd data-testid="fe-file-preview-count">{selected.size}</dd>
		</div>
		<div>
			<dt>Size</dt>
			<dd data-testid="fe-file-preview-size">{selectionSizeLabel(selectedEntries)}</dd>
		</div>
	</dl>
	<div class="fe-preview-actions">
		{#if mode === 'manage'}
			{#if caps.supportsCopy}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-row-copy"
					disabled={listBusy}
					onclick={copySelection}
				>
					Copy
				</button>
			{/if}
			{#if caps.supportsMove}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-cut"
					disabled={listBusy}
					onclick={cutSelection}
				>
					Cut
				</button>
			{/if}
			{#if supportsDownload && canDownloadSelection}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-row-download"
					disabled={listBusy || downloadBusy}
					onclick={() => void downloadSelected()}
				>
					Download
				</button>
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--danger"
				data-testid="fe-row-trash"
				disabled={listBusy}
				onclick={() => void trashSelected()}
			>
				Delete
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-file-preview-compress"
				onclick={() => startArchive('compress', selectedEntries)}
			>
				Compress
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				data-testid="fe-file-preview-encrypt"
				onclick={() => startArchive('encrypt', selectedEntries)}
			>
				Encrypt
			</button>
			{#if canDecompressSelection}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-file-preview-decompress"
					onclick={() => startArchive('decompress', selectedEntries)}
				>
					Decompress
				</button>
			{/if}
			{#if canDecryptSelection}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--secondary"
					data-testid="fe-file-preview-decrypt"
					onclick={() => startArchive('decrypt', selectedEntries)}
				>
					Decrypt
				</button>
			{/if}
			{@render detailsCopyAcross()}
		{/if}
		{#if showClose}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="fe-file-preview-close"
				onclick={() => (previewEntry = null)}
			>
				Close
			</button>
		{/if}
	</div>
{/snippet}

<style>
	.fe-root {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		max-height: none;
		background: var(--surface-1);
		color: var(--text-primary);
		border: 1px solid var(--line-hairline);
		border-radius: 0;
		overflow: hidden;
		font-family: var(--font-sans);
		font-size: var(--text-md);
	}
	.fe-root.dialog {
		min-height: 280px;
		max-height: 70vh;
		height: auto;
	}
	.fe-header {
		position: relative;
		z-index: 9;
		display: flex;
		justify-content: flex-end;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--line-hairline);
		flex-wrap: nowrap;
	}
	.fe-move-banner {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		z-index: 2;
		pointer-events: none;
		max-width: min(48%, 28rem);
		padding: 0.2rem 0.65rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-2, #1e293b) 88%, var(--accent, #38bdf8));
		border: 1px solid var(--accent, #38bdf8);
		color: var(--text-primary, #e2e8f0);
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		box-shadow: 0 4px 16px rgb(var(--scrim-rgb, 0 0 0) / 0.25);
	}
	.fe-header-left {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 4px;
		margin-right: auto;
		align-self: stretch;
	}
	.fe-header-leading {
		min-width: 0;
		display: flex;
		align-items: center;
	}
	.fe-pathbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 0 2px;
		min-height: var(--control-h-sm, 1.75rem);
	}
	.fe-crumb {
		background: none;
		border: none;
		color: var(--accent-light);
		cursor: pointer;
		padding: 2px var(--space-1);
		font: inherit;
		border-radius: var(--radius-sm, 3px);
	}
	.fe-pathbar.drop-ready .fe-crumb {
		outline: 1px dashed color-mix(in srgb, var(--accent, #38bdf8) 55%, transparent);
		outline-offset: 1px;
	}
	.fe-crumb.drop-target {
		outline: 1px solid var(--accent, #38bdf8);
		background: rgb(var(--accent-rgb, 56 189 248) / 0.16);
		color: var(--text-primary);
	}
	.fe-crumb.active {
		color: var(--text-primary);
		cursor: default;
	}
	.fe-toolbar {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		flex-shrink: 0;
	}
	.fe-toolbar-row {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: nowrap;
		justify-content: flex-end;
	}
	.fe-toolbar :global(.ds-btn--icon) {
		width: var(--control-h-sm);
		height: var(--control-h-sm);
	}
	.fe-toolbar :global(.ds-btn:disabled) {
		opacity: 0.35;
	}
	.fe-toolbar :global(.ds-btn.active),
	.fe-toolbar :global(.ds-btn[aria-pressed='true']) {
		background: rgb(var(--accent-rgb) / 0.08);
		border-color: var(--accent);
		color: var(--text-primary);
	}
	.fe-body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: row;
	}
	.fe-body[data-fe-tree-dock='top'] {
		flex-direction: column;
	}
	.fe-body > .fe-split {
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.fe-tree-dock {
		flex: none;
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: 6px 4px;
		background: var(--surface-2);
	}
	.fe-split {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: grid;
		grid-template-columns: 1fr;
		grid-template-rows: 1fr;
	}
	.fe-root.preview-bottom .fe-split {
		grid-template-rows: 1fr auto minmax(8rem, var(--preview-ratio, 34%));
	}
	.fe-root.preview-right .fe-split {
		grid-template-columns: 1fr auto minmax(12rem, var(--preview-ratio, 34%));
	}
	.fe-split > .fe-list {
		min-height: 0;
		min-width: 0;
	}
	.fe-preview-dock {
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: 12px 14px;
		background: var(--surface-2);
	}
	.fe-preview-empty {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}
	.fe-list {
		position: relative;
		flex: 1;
		overflow: auto;
		padding: 6px;
		min-height: 0;
	}
	.fe-list.os-drop {
		outline: 2px dashed var(--accent);
		outline-offset: -4px;
		background: var(--accent-glow);
	}
	.fe-list-busy {
		/* Soft cue even before delayed overlay appears */
		cursor: wait;
	}
	.fe-busy-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Opaque enough that the previous list is not readable underneath */
		background: color-mix(in srgb, var(--surface-1) 92%, transparent);
		backdrop-filter: blur(2px);
		animation: fe-busy-fade var(--dur-fast) var(--ease);
		pointer-events: all;
	}
	/* Hide previous list under the spinner so only the post-load list is seen */
	.fe-list-covered > :not(.fe-busy-overlay) {
		visibility: hidden;
	}
	.fe-list-busy .fe-row {
		pointer-events: none;
	}
	.fe-spinner {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 3px solid rgb(var(--overlay-rgb) / 0.18);
		border-top-color: var(--accent);
		animation: fe-spin 0.7s linear infinite;
	}
	@keyframes fe-busy-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes fe-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.fe-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 0;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-touch-callout: none;
		user-select: none;
	}
	.fe-row-main {
		flex: 1 1 0;
		min-width: 3.5rem;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 1.75rem;
		overflow: hidden;
	}
	.fe-row.renaming .fe-row-main {
		overflow: visible;
	}
	.fe-row-actions {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 4px;
	}
	.fe-row button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.fe-row:hover {
		background: var(--surface-3);
	}
	.fe-pending-list {
		display: flex;
		flex-direction: column;
	}
	.fe-row.fe-pending {
		opacity: 0.65;
		cursor: default;
	}
	.fe-row.fe-pending:hover {
		background: transparent;
	}
	.fe-pending-bar {
		position: relative;
		flex: 1 1 72px;
		min-width: 56px;
		max-width: 140px;
		height: 6px;
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 14%, transparent);
		border-radius: 999px;
		overflow: hidden;
	}
	.fe-pending-bar.on-icon {
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 6px;
		flex: 0 0 4px;
		flex-grow: 0;
		flex-shrink: 0;
		width: auto;
		min-width: 0;
		max-width: none;
		height: 4px;
		min-height: 4px;
		max-height: 4px;
	}
	.fe-pending-fill {
		height: 100%;
		background: var(--accent, #38bdf8);
		border-radius: 999px;
		transition: width 150ms ease;
	}
	.fe-pending-fill.ahead,
	.fe-pending-fill.behind {
		position: absolute;
		inset: 0 auto 0 0;
	}
	.fe-pending-fill.ahead {
		background: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
	}
	.fe-pending-fill.behind {
		background: var(--accent, #38bdf8);
	}
	.fe-pending-pct {
		font-size: 0.72rem;
		color: var(--text-muted);
		min-width: 34px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.fe-pending-pct.on-icon {
		position: absolute;
		left: 4px;
		right: 4px;
		bottom: 12px;
		min-width: 0;
		text-align: center;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--text-primary, #e2e8f0);
		text-shadow: 0 1px 2px rgb(0 0 0 / 0.7);
	}
	.fe-row.incompatible {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.fe-row.selected {
		background: rgb(var(--accent-rgb) / 0.12);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.fe-row.previewed {
		background: rgb(var(--accent-rgb) / 0.08);
		outline: 1px dashed var(--accent-light);
		outline-offset: -1px;
	}
	.fe-preview-backdrop {
		position: absolute;
		inset: 0;
		/* Above .fe-header (9) and the view-switcher popup (20). On a short
		   pane the details card overlaps the toolbar; 8 left those mini icons
		   painting over the dialog. Archive (60) / confirm (80) stay on top. */
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-preview-scrim {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
		cursor: pointer;
	}
	.fe-preview-card {
		position: relative;
		z-index: 1;
		min-width: min(280px, 90%);
		max-width: 360px;
		padding: 16px 18px;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: 0;
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.4);
	}
	.fe-preview-card-multi {
		max-width: 440px;
	}
	.fe-preview-items {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
		max-height: 180px;
		overflow: auto;
		display: grid;
		gap: 4px;
	}
	.fe-preview-items li {
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		font-size: 0.85rem;
	}
	.fe-preview-item-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-preview-item-size {
		opacity: 0.65;
		font-variant-numeric: tabular-nums;
	}
	.fe-preview-name {
		margin: 0 0 12px;
		font-size: 1rem;
		font-weight: 650;
		word-break: break-word;
	}
	.fe-preview-meta {
		margin: 0 0 14px;
		display: grid;
		gap: 6px;
	}
	.fe-preview-meta div {
		display: grid;
		grid-template-columns: 72px 1fr;
		gap: 8px;
		font-size: 0.85rem;
	}
	.fe-preview-meta dt {
		margin: 0;
		opacity: 0.65;
	}
	.fe-preview-meta dd {
		margin: 0;
	}
	.fe-preview-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.fe-preview-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.fe-trash-card {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(440px, 94%);
		max-height: min(420px, 80%);
		padding: 14px 16px 12px;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: 0;
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.4);
	}
	.fe-inner-fs {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-inner-fs-scrim {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
		cursor: pointer;
	}
	.fe-inner-fs-card {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		width: min(720px, calc(100vw - 2rem));
		height: min(80vh, 640px);
		padding: 12px 14px 10px;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.4);
	}
	.fe-inner-fs-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}
	.fe-inner-fs-head .fe-preview-name {
		margin: 0;
	}
	.fe-inner-fs-body {
		flex: 1 1 0;
		min-height: 0;
	}
	.fe-inner-fs-body :global(.fe-root) {
		height: 100%;
	}
	.fe-trash-head,
	.fe-trash-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.fe-trash-head .fe-preview-name {
		margin: 0;
	}
	.fe-trash-head button:disabled,
	.fe-trash-list button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.fe-trash-list {
		flex: 1;
		min-height: 0;
		overflow: auto;
		margin: 10px 0;
	}
	.fe-trash-progress {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 8px 0 0;
	}
	.fe-trash-progress-bar {
		height: 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 14%, transparent);
		overflow: hidden;
	}
	.fe-trash-progress-fill {
		height: 100%;
		background: var(--accent, #38bdf8);
	}
	.fe-trash-progress-label {
		font-size: 0.78rem;
		color: var(--text-muted, inherit);
		opacity: 0.85;
	}
	.fe-trash-foot {
		justify-content: flex-end;
		padding-top: 4px;
	}
	.fe-dnd-line {
		position: absolute;
		height: 2px;
		margin: 0;
		background: var(--accent);
		border-radius: 1px;
		pointer-events: none;
		z-index: 4;
	}
	.fe-dnd-line.vertical {
		width: 2px;
		right: auto;
	}
	.fe-row.fe-dnd-into {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.fe-row.fe-dnd-dragging {
		opacity: 0.45;
	}
	.fe-list-pointer-dnd,
	.fe-list-pointer-dnd .fe-row {
		touch-action: none;
	}
	.fe-row.focused {
		outline: 1px solid var(--accent-light);
		outline-offset: -1px;
	}
	.fe-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		flex-shrink: 0;
		width: 16px;
		height: 16px;
		overflow: hidden;
	}
	.fe-icon :global(.fe-thumb),
	.fe-icon :global(.fe-thumb-img),
	.fe-icon :global(.fe-thumb-loading),
	.fe-icon :global(.fe-thumb-fallback) {
		width: 16px;
		height: 16px;
	}
	.fe-row.folder .fe-icon {
		color: var(--accent-light);
	}
	.fe-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-empty {
		padding: 24px;
		text-align: center;
		opacity: 0.7;
	}
	.fe-error {
		padding: 8px 12px;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
	}
	.fe-truncated {
		padding: 6px 12px;
		background: var(--warning-bg);
		color: var(--accent-amber);
		font-size: var(--text-sm);
	}
	.fe-save-bar,
	.fe-inline-form {
		display: flex;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid var(--line-hairline);
		align-items: center;
	}
	.fe-save-bar input,
	.fe-inline-form input {
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: inherit;
		border-radius: var(--radius-md);
		padding: 4px 8px;
		font: inherit;
	}
	.fe-rename {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1 1 auto;
		min-width: 0;
		width: 100%;
	}
	.fe-rename input {
		flex: 1 1 auto;
		min-width: 8rem;
		width: 100%;
		background: var(--surface-2);
		border: 1px solid var(--accent);
		color: inherit;
		border-radius: var(--radius-md);
		padding: 4px 8px;
		font: inherit;
	}
	.fe-rename-action {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		color: var(--text-primary);
		cursor: pointer;
	}
	.fe-rename-action:hover {
		background: var(--surface-3);
		border-color: var(--accent);
	}
	.fe-rename-cancel:hover {
		border-color: var(--danger);
		color: var(--cat-red-soft);
	}
	.fe-row-icon-name .fe-rename {
		white-space: nowrap;
		-webkit-line-clamp: unset;
		display: flex;
	}

	/* ── View switcher popup ──────────────────────────────────── */
	.fe-view-switcher-wrap {
		position: relative;
		display: inline-flex;
	}
	.fe-view-popup {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 20;
		min-width: 160px;
		padding: 4px;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md, 4px);
		box-shadow: 0 8px 24px rgb(var(--scrim-rgb, 0 0 0) / 0.3);
	}
	.fe-view-option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		background: none;
		border: none;
		color: var(--text-primary);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		border-radius: 3px;
		text-align: left;
	}
	.fe-view-option:hover {
		background: var(--surface-3);
	}
	.fe-view-option.active {
		background: rgb(var(--accent-rgb) / 0.12);
		color: var(--accent);
	}
	.fe-view-option span {
		flex: 1;
	}
	.fe-view-checkbox .fe-view-check {
		flex: 0;
		min-width: 16px;
		text-align: right;
		font-weight: 700;
	}
	.fe-view-divider {
		height: 1px;
		margin: 4px 0;
		background: var(--line-hairline);
	}

	/* ── Icon view ────────────────────────────────────────────── */
	.fe-list-icons {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
		gap: 4px;
		align-content: start;
		align-items: start;
		padding: 8px;
	}
	.fe-row.fe-row-icon {
		flex-direction: column;
		flex: none;
		padding: 6px;
		gap: 4px;
		align-items: center;
		align-self: start;
		text-align: center;
		border: 1px solid transparent;
	}
	.fe-row.fe-row-icon:hover {
		border-color: var(--line-hairline);
	}
	.fe-row.fe-row-icon.selected {
		border-color: var(--accent);
	}
	.fe-row-icon-thumb {
		position: relative;
		width: 96px;
		height: 96px;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 4px;
		background: var(--surface-3);
	}
	.fe-row-icon-fallback {
		color: var(--text-muted);
	}
	.fe-row-icon-name {
		width: 100%;
		font-size: 0.78rem;
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		word-break: break-word;
		white-space: normal;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	/* ── Detailed view ────────────────────────────────────────── */
	.fe-list-detailed .fe-row.fe-row-detailed {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.fe-row-detailed .fe-row-main {
		flex: 1 1 0;
		min-width: 0;
	}
	.fe-row-col {
		flex: 0 0 auto;
		font-size: 0.8rem;
		color: var(--text-muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.fe-row-size {
		min-width: 5rem;
		text-align: right;
	}
	.fe-row-type {
		min-width: 4.5rem;
		text-transform: capitalize;
	}
	.fe-row-modified {
		min-width: 8rem;
	}
	.fe-list-detailed .fe-icon,
	.fe-list-detailed .fe-icon :global(.fe-thumb),
	.fe-list-detailed .fe-icon :global(.fe-thumb-img) {
		width: 16px;
		height: 16px;
	}

	/* ── Preview thumbnail in dock/popup ──────────────────────── */
	.fe-preview-thumb {
		width: 100%;
		min-height: 80px;
		max-height: 240px;
		margin-bottom: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-3);
		border: 1px solid var(--line-hairline);
		border-radius: 4px;
		overflow: hidden;
	}
	.fe-preview-thumb :global(.fe-thumb-img) {
		max-height: 240px;
	}
</style>
