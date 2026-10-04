<script lang="ts">
 import { ownerLabel } from '../services/owner.js';
 import { serviceContextId } from '../leaseOwner.js';
 let ownerCtx = $state('');

 import { beginArchiveOp, reportFileOp as upsertProgress, attachFileOpAbort as attachTransferAbort, abortFileOp as abortTransfer } from '../services/fileOps.js';
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	import FileExplorer from './FileExplorer.svelte';
	import {
		getSharedVfs,
		inferFileTypeFromName,
		isActionable,
		type FileTypeId,
		type VfsService
	} from '../index.js';
	import { fileTypeMime, persistKv } from '@shared-packages/ui';
	import { formatBytes as formatSize } from '@shared-packages/ui/files';
	import {
		canReadExplorerBlob,
		readExplorerBlob,
		type MediaMetaTarget,
		explorerThumbsAreEager,
		type ExplorerDriver,
		type ExplorerEntry,
		type ExplorerEntryId,
		type ExplorerOpenTarget,
		type ExplorerOpenContext,
		type QuickEditVideoContext,
		type QuickEditAudioContext,
		type QuickEditImageContext,
		type QuickConvertSvgContext
	} from './explorerDriver.js';
	import { createLocalExplorerDriver } from './localExplorerDriver.js';
	import { portalModal } from './portal.js';
	import StoragePersistenceStatus from './StoragePersistenceStatus.svelte';
	import FeStorageDialog from './FeStorageDialog.svelte';
	import FeProjectStorageDialog from './FeProjectStorageDialog.svelte';
	import { packBadges } from './storageInspect.js';
	import { deleteFromProject } from '../projectPack.js';
	import { getVfsWorkerClient, vfsWorkerUnavailableReason } from '../worker/client.js';
	import FeIcon from './FeIcon.svelte';
	import { folderIconName, folderMarkClass, type FeIconName } from './feIcons.js';
	import FeTipIconBtn from './FeTipIconBtn.svelte';
	import FeArchiveDialog from './FeArchiveDialog.svelte';
	import OpProgressChip from './OpProgressChip.svelte';
	import { registerArchiveDialogShow, requestArchiveDialogShow } from './archiveReshow.js';
	import {
		createInnerFsSession,
		expandPackedBytes,
		prewarmExpandEngines,
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
		createTreeDndSession,
		canonicalizeSiblingZone,
		resolveDrop,
		zoneFromPoint,
		type DropZone
	} from './treeDnd/index.js';
	import {
		FE_EXPLORER_IDS_MIME,
		dataTransferHasOsFiles,
		dataTransferHasExplorerIds
	} from './copyAcross.js';
	import {
		setCrossWindowDrag,
		clearCrossWindowDrag,
		setPointerDragActive,
		getCrossWindowDrag,
		isPointerDragActive,
		subscribeCrossWindowDrag
	} from './crossWindowDnd.js';
	import {
		collectOsDrop,
		createDeviceImportReporter,
		importOsDropToDriver,
		nodesFromFiles,
		snapshotFiles,
		type OsDropFileProgress,
		type OsDropNode
	} from './osDrop.js';
	import {
		mergeListingWithPending,
		pendingLabel,
		pendingPercent,
		sortListingRows,
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
		payloadFromText,
		type SystemClip
	} from './systemClipboard.js';
	import {
		FILE_CLIPBOARD_TYPE, fileClipboardPayload, fileClipboardFromText, fileClipboardFromItems, fileClipboardForPastedImage,
		fileClipboardFromHtml, fileClipboardFromOwnedText, fileClipboardText, fileClipboardHasFolders, copyFilesToSystem,
		fileClipboardLabel, clipboardEntries, sameClipboardSource, rememberClipboardSource, clipboardSource, markClipboardFileMoved,
		type FileClipboardPayload
	} from './fileClipboard.js';
	import { copyImageToSystem } from './imageClipboard.js';
	import '@shared-packages/design-system/button.css';
	import '@shared-packages/design-system/tooltip.css';
	import { SplitHandle, toast, appClipboard } from '@shared-packages/ui';
	import FeThumbnail from './FeThumbnail.svelte';
	import FeTypeMark from './FeTypeMark.svelte';
	import FeFolderStack from './FeFolderStack.svelte';
	import FeTreeView from './FeTreeView.svelte';
	import FeFloatingPreview from './FeFloatingPreview.svelte';
	import {
		canQuickConvertSvg,
		canQuickEditRaster,
		fileTypeIcon,
		getPreviewKind,
		hasRasterThumbnail
	} from './feThumbnails.js';
	import { classifyFolder, detectProject, findProjectRoot, type FolderMark } from './detectProject.js';
	import FeConfirmDialog from './FeConfirmDialog.svelte';
	import {
		emptyTrashCopy,
		hardDeleteCopy,
		overwriteSaveCopy,
		permanentDeleteCopy,
		type FeConfirmCopy
	} from './feConfirm.js';
	import type {
		ExplorerMode,
		ExplorerContext,
		ExplorerViewSettings,
		ExplorerNewMenuItem,
		ExplorerPresenceDot,
		ExplorerPerson,
		ExplorerArrivalPolicy,
		ExplorerSplitBrain,
		ExplorerSplitBrainChoice,
		ProjectHistoryStats,
		ExplorerCombineResult,
		ExplorerRoomActionResult,
		ExplorerUnlinkDrain
	} from './componentTypes.js';
	import { readProjectMeta, roomsFromMeta, type ProjectRoom } from '../projectMeta.js';

	interface Props {
		mode?: ExplorerMode;
		accept?: FileTypeId[];
		hideIncompatible?: boolean;
		initialParentId?: string | null;
		initialViewSettings?: ExplorerViewSettings;
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
		/** What counts as 'already a project'. The Git app passes 'git' so a
		 * packed/.project folder without a repo still offers Init. */
		projectMarker?: import('./detectProject.js').ProjectMarker;
		/** Header "Dependency map" — current project root (Files). */
		onProjectMap?: (rootId: ExplorerEntryId | null) => void;
		/** Header "Git enabled" — nearest git working tree (Files). */
		onGitEnabled?: (rootId: ExplorerEntryId | null) => void;
		/** Toolbar New menu — create a project under the open folder (Files). */
		onNewProject?: (parentId: ExplorerEntryId | null) => void;
		/** Extra New-menu actions (sketch, animation, recording, …). */
		newMenuItems?: ExplorerNewMenuItem[];
		onNewMenuItem?: (id: string, parentId: ExplorerEntryId | null) => void;
		/** Preview "Send this file" — Connections dual-pane send path. */
		onSendFile?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		sendLabel?: string;
		/** Preview "Quick edit" for video files — host opens the trimmer. */
		onQuickEditVideo?: (entry: ExplorerEntry, ctx: QuickEditVideoContext) => void;
		/** Preview "Quick edit" for audio files — host opens the trimmer. */
		onQuickEditAudio?: (entry: ExplorerEntry, ctx: QuickEditAudioContext) => void;
		/**
		 * Metadata panel for media the host can probe (video / GIF). Rendered
		 * inside the file preview when the user asks for metadata.
		 */
		mediaMeta?: Snippet<[MediaMetaTarget]>;
		/** Preview "Quick edit" for raster images — host opens Image Edit. */
		onQuickEditImage?: (entry: ExplorerEntry, ctx: QuickEditImageContext) => void;
		/** Preview "Convert to SVG" for bitmaps — host opens Images to SVG. */
		onQuickConvertSvg?: (entry: ExplorerEntry, ctx: QuickConvertSvgContext) => void;
		/** Override the preview Open label (string or per-entry). */
		openLabel?: string | ((entry: ExplorerOpenTarget) => string);
		onSave?: (args: {
			parentId: string | null;
			name: string;
			entry?: ExplorerOpenTarget;
			/** Set by the dialog when the user confirmed overwriting an existing file. */
			overwrite?: boolean;
		}) => void | Promise<void>;
		onClose?: () => void;
		/** Selection + open folder for dual-pane copy-across. */
		onContextChange?: (ctx: ExplorerContext) => void;
		/** Connection-scoped folder shortcuts supplied by DualPaneExplorer. */
		onToggleFolderFavourite?: (entry: ExplorerEntry) => void;
		isFolderFavourite?: (folderId: string) => boolean;
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
		/** Extra manage-toolbar / details actions (e.g. DualPane Copy across). */
		toolbarExtra?: Snippet<[{ variant: 'icon' | 'label' | 'menu' }]>;
		/** Leading header slot (connection dropdown for DualPaneExplorer). */
		headerLeading?: Snippet;
		/**
		 * Hub window this explorer belongs to. Ops it starts are stamped with
		 * this id, and the header bar shows only those. A pane, not the tab.
		 * Empty means this explorer is its own window.
		 */
		opWindowId?: string;
		/** Whether this explorer instance is the active TARGET window. */
		isTarget?: boolean;
		/** Handle cross-driver copy across from app clipboard. */
		onCopyAcrossFromClipboard?: (
			payload: FileClipboardPayload,
			destParentId: string | null,
			onMoved?: (id: string) => Promise<void>
		) => Promise<void>;
		/** Who is in which file — Documents `placePresence` marks keyed by fileId. */
		presenceByFileId?: ReadonlyMap<string, readonly ExplorerPresenceDot[]>;
		/**
		 * Switch the checked-out room. Return `dirty` when unsaved work must be
		 * saved first — FileExplorer then shows Save and switch / Stay.
		 */
		onSwitchRoom?: (args: {
			rootId: ExplorerEntryId;
			roomId: string;
			save: boolean;
		}) => Promise<ExplorerRoomActionResult>;
		onNewRoom?: (args: {
			rootId: ExplorerEntryId;
			label: string;
			save: boolean;
		}) => Promise<ExplorerRoomActionResult>;
		onRoomContext?: (args: {
			rootId: ExplorerEntryId | null;
			roomId: string | null;
		}) => void;
		/**
		 * Bring another room's work into this one. Disabled during a live
		 * session: a merge never blocks on a human mid-stroke.
		 */
		onCombineRoom?: (args: {
			rootId: ExplorerEntryId;
			fromRoomId: string;
			save: boolean;
		}) => Promise<ExplorerCombineResult>;
		/** Someone is editing, so Combine is offered at a quiet moment instead. */
		combineBusy?: boolean;
		/** Open the review surface for a path the combine could not merge. */
		onReviewConflict?: (args: {
			rootId: ExplorerEntryId;
			fromRoomId: string;
			path: string;
		}) => void | Promise<void>;
		/** Keep locally: opt in to another of this person's rooms (§11.6). */
		onKeepRoom?: (args: {
			pairingId: string;
			roomId: string;
			keep: boolean;
		}) => void | Promise<void>;
		/**
		 * Another group is live in this room. Never resolved automatically:
		 * the only honest answers are to wait, to branch off, or to not join.
		 */
		splitBrain?: ExplorerSplitBrain | null;
		onSplitBrainChoice?: (choice: ExplorerSplitBrainChoice) => void | Promise<void>;
		/** Git history sizes for the Project storage panel. */
		projectHistory?: ProjectHistoryStats | null;
		onPackHistory?: () => Promise<void>;
		/** Standing answer to what happens when this person's work arrives. */
		onArrivalPolicy?: (args: {
			pairingId: string;
			policy: ExplorerArrivalPolicy;
		}) => void | Promise<void>;
		/** Linked + this-session people. Chip/sheet only inside a project. */
		people?: readonly ExplorerPerson[];
		onInvitePeople?: () => void;
		onRenamePerson?: (pairingId: string, label: string) => void | Promise<void>;
		onRevokePerson?: (pairingId: string) => void | Promise<void>;
		onUnlinkPerson?: (
			pairingId: string,
			drain: ExplorerUnlinkDrain
		) => void | Promise<void>;
	}

	let {
		mode = 'manage',
		accept,
		hideIncompatible = false,
		initialParentId = null,
		initialViewSettings,
		defaultName = '',
		multiSelect = false,
		driver: driverProp,
		vfs: vfsProp,
		showPersistence = true,
		onOpen,
		onOpenProject,
		projectMarker = 'any',
		onInitProject,
		onProjectMap,
		onGitEnabled,
		onNewProject,
		newMenuItems = [],
		onNewMenuItem,
		onSendFile,
		sendLabel = 'Send this file',
		onQuickEditVideo,
		onQuickEditAudio,
		onQuickEditImage,
		mediaMeta,
		onQuickConvertSvg,
		openLabel,
		onSave,
		onClose,
		pending = [],
		onContextChange,
		onToggleFolderFavourite,
		isFolderFavourite,
		variant = 'panel',
		class: className = '',
		compatLibraryTestId = false,
		compatSaveTestId = false,
		hideToolbarTrash = false,
		toolbarExtra,
		headerLeading,
		opWindowId = '',
		isTarget = false,
		onCopyAcrossFromClipboard,
		presenceByFileId,
		onSwitchRoom,
		onNewRoom,
		onCombineRoom,
		combineBusy = false,
		onReviewConflict,
		onKeepRoom,
		onArrivalPolicy,
		projectHistory = null,
		onPackHistory,
		splitBrain = null,
		onSplitBrainChoice,
		onRoomContext,
		people,
		onInvitePeople,
		onRenamePerson,
		onRevokePerson,
		onUnlinkPerson
	}: Props = $props();

	const ownOpWindowId = crypto.randomUUID();
	const originWindowId = $derived(opWindowId || ownOpWindowId);

	// Initial snapshots seed independent state; later edits stay local to this panel.
	const initialView = untrack(() => initialViewSettings);

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
	/**
	 * The storage map reads OPFS state, so it needs the local VFS. The Files
	 * window header owns the persistence pill; pane explorers suppress it.
	 * Popups that hide that header turn the pill back on.
	 */
	let showStorageBtn = $derived(mode === 'manage' && driver.id === 'local' && !!localVfs);
	/** Storage inspector + integrity check. Local only — it reads OPFS state. */
	let storageDialogOpen = $state(false);
	/**
	 * Which visible files live inside a shared pack. Surfaced on the row because
	 * a packed file behaves differently on delete: its space only returns once
	 * every member of its pack is gone.
	 */
	let packedRows = $state<Map<string, { packed: boolean; packPath?: string }>>(new Map());
	/** Per-row folder icon: project / git / both. This folder only, not ancestors. */
	let folderMarks = $state<Map<string, FolderMark>>(new Map());

	function entryIcon(n: ExplorerEntry, open = false): FeIconName {
		if (n.kind !== 'folder') return 'file';
		return folderIconName(folderMarks.get(n.id) ?? 'plain', open);
	}
	function entryMarkClass(n: ExplorerEntry): string {
		return n.kind === 'folder' ? folderMarkClass(folderMarks.get(n.id)) : '';
	}
	function entryMark(n: ExplorerEntry): FolderMark | undefined {
		return n.kind === 'folder' ? (folderMarks.get(n.id) ?? 'plain') : undefined;
	}

	$effect(() => {
		if (driverProp) {
			driver = driverProp;
		} else {
			driver = createLocalExplorerDriver(vfsProp ?? getSharedVfs());
		}
	});

	// svelte-ignore state_referenced_locally -- `initial` prop, by contract.
	let parentId = $state<string | null>(initialParentId);
	/** Folder row we navigated into, so the preview can name it before breadcrumbs land. */
	let navigatedFolder = $state<ExplorerEntry | null>(null);
	/** Preview identity for the driver root, which has no folder row. */
	const OPEN_ROOT_PREVIEW_ID = 'fe:open-root';
	const openFolderEntry = $derived.by((): ExplorerEntry => {
		if (!parentId) {
			const name = driver.diskRoot?.name?.trim() || 'Root';
			return { id: OPEN_ROOT_PREVIEW_ID, kind: 'folder', name, parentId: null };
		}
		const live = breadcrumbs.find((folder) => folder.id === parentId);
		if (live) return live;
		if (navigatedFolder?.id === parentId) return navigatedFolder;
		return { id: parentId, kind: 'folder', name: 'Folder', parentId: null };
	});
	let nodes = $state<ExplorerEntry[]>([]);
	let listTruncated = $state(false);
	let breadcrumbs = $state<ExplorerEntry[]>([]);
	const currentFavouriteFolder = $derived(breadcrumbs.find((folder) => folder.id === parentId));
	let favouriteMenu = $state<{ entry: ExplorerEntry; x: number; y: number } | null>(null);
	let favouriteMenuEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!favouriteMenu) return;
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && favouriteMenuEl?.contains(event.target)) return;
			favouriteMenu = null;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			favouriteMenu = null;
		};
		document.addEventListener('pointerdown', dismiss);
		document.addEventListener('keydown', escape, true);
		favouriteMenuEl?.querySelector<HTMLButtonElement>('button')?.focus();
		return () => {
			document.removeEventListener('pointerdown', dismiss);
			document.removeEventListener('keydown', escape, true);
		};
	});
	let selected = $state<Set<string>>(new Set());
	/** Most recently toggled-on row — Open uses this when several items are selected. */
	let lastSelectedId = $state<string | null>(null);
	/** Off: click selects one row. On: click toggles multi-select. */
	let selectMulti = $state(initialView?.selectMulti ?? false);
	let previewEntry = $state<ExplorerEntry | null>(null);
	let mediaMetaOpenId = $state<string | null>(null);
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
	let innerFs = $state<InnerFsSession | null>(null);
	onMount(() => {
		void serviceContextId().then((ctx) => { ownerCtx = ctx; }).catch(() => {});
		const unsubReshow = registerArchiveDialogShow(showHiddenArchiveDialog);
		const unsubDrag = subscribeCrossWindowDrag(() => {
			if (getCrossWindowDrag() || isPointerDragActive()) return;
			copyHoverActive = false;
			if (!dnd.getState().active) clearDndHover();
		});
		const el = rootEl;
		let ro: ResizeObserver | undefined;
		if (el && typeof ResizeObserver !== 'undefined') {
			ro = new ResizeObserver((entries) => {
				const w = entries[0]?.contentRect.width ?? 0;
				const next = w > 0 && w < COMPACT_TOOLBAR_PX;
				if (next !== compactToolbar) compactToolbar = next;
				if (!next) toolbarMoreOpen = false;
			});
			ro.observe(el);
		}
		return () => {
			unsubReshow();
			unsubDrag();
			ro?.disconnect();
		};
	});
	onDestroy(() => {
		archiveAbort?.abort();
		emptyTrashAbort?.abort();
		void innerFs?.dispose();
		clearDragOutCache();
		teardownPointerDrag();
		stopMarquee();
	});
	/** off → below (horizontal split) → beside (vertical split) → off. */
	type PreviewDock = 'off' | 'bottom' | 'right';
	const PREVIEW_DOCK_KEY = 'fe:previewDock';
	let previewDock = $state<PreviewDock>(
		initialView?.previewDock ?? (() => {
			const v = persistKv.getItem(PREVIEW_DOCK_KEY);
			if (v === 'bottom' || v === 'right') return v;
			return 'off';
		})()
	);
	/** off → left sidebar → top strip → off, like a file manager's folder tree. */
	type TreeDock = 'off' | 'left' | 'top';
	const TREE_DOCK_KEY = 'fe:treeDock';
	let treeDock = $state<TreeDock>(
		initialView?.treeDock ?? (() => {
			const v = persistKv.getItem(TREE_DOCK_KEY);
			if (v === 'left' || v === 'top') return v;
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
		const v = persistKv.getItem(key);
		if (v) {
			const n = Number(v);
			if (Number.isFinite(n) && n > 0.05 && n < 0.8) return n;
		}
		return fallback;
	}
	let treeRatio = $state(initialView?.treeRatio ?? loadRatio(TREE_RATIO_KEY, TREE_RATIO_DEFAULT));
	let previewRatio = $state(initialView?.previewRatio ?? loadRatio(PREVIEW_RATIO_KEY, PREVIEW_RATIO_DEFAULT));
	function persistRatio(key: string, v: number) {
		persistKv.setItem(key, String(v));
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
		initialView?.viewMode ?? (() => {
			const v = persistKv.getItem(VIEW_MODE_KEY);
			if (v === 'icons' || v === 'detailed') return v;
			return 'list';
		})()
	);
	let showPreview = $state(initialView?.showPreview ?? (persistKv.getItem(SHOW_PREVIEW_KEY) === 'true'));
	const ICON_SIZE_KEY = 'fe:iconSize';
	const ICON_SIZE_MIN = 56;
	const ICON_SIZE_MAX = 240;
	const ICON_SIZE_DEFAULT = 96;
	let iconSize = $state(
		initialView?.iconSize ?? (() => {
			const raw = Number(persistKv.getItem(ICON_SIZE_KEY));
			if (Number.isFinite(raw) && raw > 0)
				return Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, Math.round(raw)));
			return ICON_SIZE_DEFAULT;
		})()
	);
	/** Thumbnail fetch resolution — quantised so sliding never refetches per tick. */
	const thumbFetchDim = $derived(Math.max(128, Math.ceil(iconSize / 64) * 64));
	/** List/detailed rows carry the same thumbnail knob, scaled into a band a
	 * row can hold (16px at the slider's minimum, 64px at its maximum). */
	const rowIconPx = $derived(
		Math.round(16 + ((iconSize - ICON_SIZE_MIN) / (ICON_SIZE_MAX - ICON_SIZE_MIN)) * 48)
	);
	/** Fetch buckets for list/detailed thumbs — coarse so sliding never refetches per tick. */
	const rowThumbDim = $derived(rowIconPx > 48 ? 128 : rowIconPx > 32 ? 64 : 32);
	function setIconSize(v: number) {
		if (!Number.isFinite(v)) return;
		iconSize = Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, Math.round(v)));
		persistKv.setItem(ICON_SIZE_KEY, String(iconSize));
	}

	// ── Detailed view: sortable headings + configurable columns ──
	type DetailCol = 'size' | 'type' | 'modified';
	type SortCol = 'name' | DetailCol;
	type SortDir = 'asc' | 'desc';
	/** Labels double as the sort-chip text; tracks are shared header/data cell widths. */
	const DETAIL_COL_META: Record<SortCol, { label: string; track: string }> = {
		name: { label: 'File name', track: 'minmax(0, 1fr)' },
		size: { label: 'Size', track: '5rem' },
		type: { label: 'Type', track: '4.5rem' },
		modified: { label: 'Modified', track: '8rem' }
	};
	const DETAIL_COL_IDS = ['size', 'type', 'modified'] as const;
	/** "Name" stays first and cannot be hidden — it hosts icon, rename, dots. */
	const DEFAULT_DETAIL_ORDER: DetailCol[] = ['size', 'type', 'modified'];
	const COLS_KEY = 'fe:columns';
	const SORT_KEY = 'fe:sort';
	const FOLDERS_FIRST_KEY = 'fe:foldersFirst';
	function isDetailCol(v: unknown): v is DetailCol {
		return typeof v === 'string' && (DETAIL_COL_IDS as readonly string[]).includes(v);
	}
	function loadColumns(): { order: DetailCol[]; hidden: DetailCol[] } {
		try {
			const raw = persistKv.getItem(COLS_KEY);
			if (typeof raw === 'string') {
				const parsed = JSON.parse(raw) as { order?: unknown[]; hidden?: unknown[] };
				const order: DetailCol[] = [];
				if (Array.isArray(parsed.order))
					for (const id of parsed.order) if (isDetailCol(id) && !order.includes(id)) order.push(id);
				const hidden: DetailCol[] = [];
				if (Array.isArray(parsed.hidden))
					for (const id of parsed.hidden) if (isDetailCol(id) && !hidden.includes(id)) hidden.push(id);
				// Every known column appears exactly once across the two sets.
				for (const id of DETAIL_COL_IDS) if (!order.includes(id) && !hidden.includes(id)) order.push(id);
				if (order.length > 0) return { order, hidden };
			}
		} catch {
			/* malformed or absent — defaults below */
		}
		return { order: [...DEFAULT_DETAIL_ORDER], hidden: [] };
	}
	function loadSort(): { col: SortCol; dir: SortDir } | null {
		try {
			const raw = persistKv.getItem(SORT_KEY);
			if (typeof raw === 'string') {
				const parsed = JSON.parse(raw) as { col?: unknown; dir?: unknown };
				if (parsed.col === 'name' || isDetailCol(parsed.col)) {
					return { col: parsed.col as SortCol, dir: parsed.dir === 'desc' ? 'desc' : 'asc' };
				}
			}
		} catch {
			/* fall through */
		}
		return null;
	}
	let detailColOrder = $state<DetailCol[]>(initialView ? [...initialView.detailColOrder] : loadColumns().order);
	let hiddenCols = $state<DetailCol[]>(initialView ? [...initialView.hiddenCols] : loadColumns().hidden);
	/** Columns shown in the detailed header, in display order. */
	const detailCols = $derived(detailColOrder.filter((c) => !hiddenCols.includes(c)));
	/** Fixed cell widths shared by the header buttons and the data cells. */
	const detailTracks = $derived(detailCols.map((c) => DETAIL_COL_META[c].track).join(' '));
	function persistColumns() {
		persistKv.setItem(COLS_KEY, JSON.stringify({ order: detailColOrder, hidden: hiddenCols }));
	}
	function toggleDetailCol(c: DetailCol) {
		if (hiddenCols.includes(c)) {
			hiddenCols = hiddenCols.filter((h) => h !== c);
		} else {
			if (detailCols.length <= 1) return; // at least one data column stays visible
			hiddenCols = [...hiddenCols, c];
		}
		persistColumns();
	}
	function moveDetailCol(c: DetailCol, delta: -1 | 1) {
		const i = detailColOrder.indexOf(c);
		const j = i + delta;
		if (i < 0 || j < 0 || j >= detailColOrder.length) return;
		const next = [...detailColOrder];
		next[j] = detailColOrder[i]!;
		next[i] = detailColOrder[j]!;
		detailColOrder = next;
		persistColumns();
	}
	let foldersFirst = $state(initialView?.foldersFirst ?? (persistKv.getItem(FOLDERS_FIRST_KEY) !== 'false'));
	function setFoldersFirst(v: boolean) {
		foldersFirst = v;
		persistKv.setItem(FOLDERS_FIRST_KEY, v ? 'true' : 'false');
	}
	const FOLDER_STACKS_KEY = 'fe:folderStacks';
	/** Icons view: folder icons show a deck of thumbnails from inside. */
	let folderStacks = $state(initialView?.folderStacks ?? (persistKv.getItem(FOLDER_STACKS_KEY) !== 'false'));
	function setFolderStacks(v: boolean) {
		folderStacks = v;
		persistKv.setItem(FOLDER_STACKS_KEY, v ? 'true' : 'false');
	}
	/** Stacks fetch children previews silently — auto-download drivers only. */
	const folderStacksOk = $derived(explorerThumbsAreEager(driver));

	const HIDDEN_FILES_KEY = 'fe:showHidden';
	/** Leading-dot ("system") names are hidden until the user asks to see them. */
	let showHidden = $state(initialView?.showHidden ?? (persistKv.getItem(HIDDEN_FILES_KEY) === 'true'));
	function setShowHidden(v: boolean) {
		showHidden = v;
		persistKv.setItem(HIDDEN_FILES_KEY, v ? 'true' : 'false');
	}
	const hiddenFilesTip = $derived(showHidden ? 'Hide system files' : 'Show system files');
	let sortSpec = $state<{ col: SortCol; dir: SortDir } | null>(
		initialView ? initialView.sortSpec && { ...initialView.sortSpec } : loadSort()
	);
	/** Active sort — set from the detailed headings or the list/icons popup tools. */
	const activeSort = $derived(sortSpec);
	const sortDir = $derived(sortSpec?.dir ?? 'asc');
	function toggleSort(col: SortCol) {
		sortSpec =
			sortSpec && sortSpec.col === col
				? { col, dir: sortSpec.dir === 'asc' ? 'desc' : 'asc' }
				: { col, dir: 'asc' };
		persistKv.setItem(SORT_KEY, JSON.stringify(sortSpec));
	}
	function clearSort() {
		sortSpec = null;
		persistKv.removeItem(SORT_KEY);
	}
	/** Popup sort tools (list/icons): the same spec the detailed headings edit. */
	const SORT_TOOLS: SortCol[] = ['name', 'size', 'type', 'modified'];
	function flipSortDir() {
		if (!sortSpec) return;
		sortSpec = { col: sortSpec.col, dir: sortSpec.dir === 'asc' ? 'desc' : 'asc' };
		persistKv.setItem(SORT_KEY, JSON.stringify(sortSpec));
	}
	let viewSwitcherOpen = $state(false);
	/**
	 * Collapse the icon toolbar into one overflow button. Seed from viewport
	 * so phones don't flash a wrapping row; ResizeObserver then follows the
	 * explorer's own width (split panes, session-end column).
	 */
	const COMPACT_TOOLBAR_PX = 720;
	let compactToolbar = $state(
		typeof window !== 'undefined' &&
			typeof window.innerWidth === 'number' &&
			window.innerWidth > 0 &&
			window.innerWidth < COMPACT_TOOLBAR_PX
	);
	let toolbarMoreOpen = $state(false);
	let newMenuOpen = $state(false);
	let roomMenuOpen = $state(false);
	let newRoomNameOpen = $state(false);
	let newRoomName = $state('');
	let peopleSheetOpen = $state(false);
	let revokeTarget = $state<ExplorerPerson | null>(null);
	let unlinkTarget = $state<ExplorerPerson | null>(null);
	let peopleRenameDrafts = $state<Record<string, string>>({});
	let rootEl = $state<HTMLDivElement | undefined>();
	let floatingPreviewEntry = $state<ExplorerEntry | null>(null);
	/**
	 * macOS-style Quick Look on Space. A tap pins the popup open (tap again
	 * to close); holding Space peeks while held and closes on release.
	 * Entries without a preview kind keep the legacy selection toggle.
	 */
	let quickLookPinned = $state(false);
	let quickLookPeek = $state(false);
	let spaceDownAt = $state(0);
	const QUICK_LOOK_HOLD_MS = 300;
	/** Remote (B2) preview-pane media is opt-in — keyed by entry id. */
	let previewMediaId = $state<string | null>(null);

	function persistViewMode(v: ViewMode) {
		persistKv.setItem(VIEW_MODE_KEY, v);
	}
	function persistShowPreview(v: boolean) {
		persistKv.setItem(SHOW_PREVIEW_KEY, v ? 'true' : 'false');
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
		if (viewSwitcherOpen) {
			toolbarMoreOpen = false;
			newMenuOpen = false;
			roomMenuOpen = false;
			peopleSheetOpen = false;
		}
	}
	function closeViewSwitcher() {
		viewSwitcherOpen = false;
	}
	function closeToolbarMore() {
		toolbarMoreOpen = false;
	}
	function closeNewMenu() {
		newMenuOpen = false;
	}
	function closeRoomMenu() {
		roomMenuOpen = false;
		newRoomNameOpen = false;
	}
	function toggleRoomMenu() {
		roomMenuOpen = !roomMenuOpen;
		if (roomMenuOpen) {
			viewSwitcherOpen = false;
			toolbarMoreOpen = false;
			newMenuOpen = false;
			peopleSheetOpen = false;
			newRoomNameOpen = false;
			newRoomName = '';
		}
	}
	function closePeopleSheet() {
		peopleSheetOpen = false;
	}
	function togglePeopleSheet() {
		peopleSheetOpen = !peopleSheetOpen;
		if (peopleSheetOpen) {
			viewSwitcherOpen = false;
			toolbarMoreOpen = false;
			newMenuOpen = false;
			roomMenuOpen = false;
		}
	}
	function toggleToolbarMore() {
		toolbarMoreOpen = !toolbarMoreOpen;
		if (toolbarMoreOpen) {
			viewSwitcherOpen = false;
			newMenuOpen = false;
			roomMenuOpen = false;
			peopleSheetOpen = false;
		}
	}
	function toggleNewMenu() {
		newMenuOpen = !newMenuOpen;
		if (newMenuOpen) {
			viewSwitcherOpen = false;
			toolbarMoreOpen = false;
			peopleSheetOpen = false;
			roomMenuOpen = false;
		}
	}
	function chooseNewProject() {
		closeNewMenu();
		closeToolbarMore();
		onNewProject?.(parentId);
	}

	function chooseNewMenuItem(id: string) {
		closeNewMenu();
		closeToolbarMore();
		onNewMenuItem?.(id, parentId);
	}

	const showNewMenu = $derived(
		mode === 'manage' && Boolean(onNewProject || newMenuItems.length)
	);

	function entryHasMediaMeta(entry: ExplorerEntry): boolean {
		if (entry.kind !== 'file') return false;
		const kind = getPreviewKind(entry);
		return kind === 'video' || kind === 'image';
	}

	async function loadMediaBlob(entry: ExplorerEntry): Promise<Blob> {
		const blob = await readExplorerBlob(driver, entry.id);
		if (!blob) throw new Error('File is empty');
		return blob;
	}

	/**
	 * A handoff to another tool's popup (Quick edit, Convert to SVG, a git
	 * project's commit panel after Open / Init project) closes the
	 * preview first. The preview is portalled to <body>, so left open it paints
	 * over a popup mounted inside the pane and swallows every click in it.
	 */
	function closePreviewForHandoff() {
		actionsMenuOpen = false;
		floatingPreviewEntry = null;
		// The details popup; a docked preview is not modal and can stay.
		if (previewDock === 'off') previewEntry = null;
	}

	function openFloatingPreview() {
		if (previewEntry && previewEntry.kind === 'file' && getPreviewKind(previewEntry)) {
			floatingPreviewEntry = previewEntry;
		}
	}
	/** Focused row first, else the primary selection — when previewable. */
	function quickLookTarget(): ExplorerEntry | null {
		const n = focusedNode() ?? selectedPrimary();
		if (!n || n.kind !== 'file' || !getPreviewKind(n)) return null;
		return n;
	}
	function openQuickLook(entry: ExplorerEntry, pinned: boolean) {
		floatingPreviewEntry = entry;
		quickLookPinned = pinned;
		quickLookPeek = !pinned;
	}
	function closeQuickLook() {
		floatingPreviewEntry = null;
		quickLookPinned = false;
		quickLookPeek = false;
		spaceDownAt = 0;
	}
	function onQuickLookKeyup(e: KeyboardEvent) {
		if (e.key !== ' ' && e.key !== 'Spacebar') return;
		if (!quickLookPeek || !floatingPreviewEntry) {
			quickLookPeek = false;
			spaceDownAt = 0;
			return;
		}
		if (Date.now() - spaceDownAt >= QUICK_LOOK_HOLD_MS) closeQuickLook();
		else {
			quickLookPinned = true;
			quickLookPeek = false;
			spaceDownAt = 0;
		}
	}
	// The popup closes itself on Escape/backdrop: drop the stale mode flags.
	$effect(() => {
		if (!floatingPreviewEntry && (quickLookPinned || quickLookPeek)) {
			quickLookPinned = false;
			quickLookPeek = false;
			spaceDownAt = 0;
		}
	});
	function requestPreviewMedia(id: string) {
		previewMediaId = id;
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
	/** Position in `focusableEntries` (display order) — never a `nodes` index. */
	let focusIndex = $state(-1);
	const clipboard = $derived(appClipboard.current?.type === FILE_CLIPBOARD_TYPE
		? fileClipboardPayload(appClipboard.current.data) : null);
	let pasteBusy = $state(false);
	let systemClip = $state<SystemClip | null>(null);
	let uploadBusy = $state(false);
	let osDropOver = $state(false);
	let fileInputEl = $state<HTMLInputElement | null>(null);
	let folderInputEl = $state<HTMLInputElement | null>(null);

	/** Per-instance DnD session (dual-pane safe). */
	const dnd = createTreeDndSession();
	let dndTargetId = $state<string | null>(null);
	let dndZone = $state<DropZone | null>(null);
	/** Same-pane move: dest folder from breadcrumb / tree. `undefined` = not a nav drop. */
	let dndIntoId = $state<string | null | undefined>(undefined);
	/** Hover chrome for a copy-across drag that started in another explorer. */
	let copyHoverActive = $state(false);
	let moveDragActive = $state(false);
	const dropChromeActive = $derived(moveDragActive || copyHoverActive);
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

	// Notify parent of selection/folder without tracking unstable callback identity.
	// Names/sizes belong in the key: DualPane copy-across reads `ctx.entries`
	// for dest filenames, and a rename does not change parent, selection, or count.
	let lastCtxKey = '';
	$effect(() => {
		const ids = [...selected].sort().join(',');
		const stamp = nodes.map((n) => `${n.id}:${n.name}:${n.kind}:${n.size ?? ''}`).join('\n');
		const viewSettings: ExplorerViewSettings = {
			viewMode, showPreview, iconSize, previewDock, treeDock, previewRatio, treeRatio,
			detailColOrder: [...detailColOrder], hiddenCols: [...hiddenCols],
			sortSpec: sortSpec && { ...sortSpec }, foldersFirst, folderStacks, showHidden, selectMulti
		};
		const key = `${driver.id}|${parentId ?? ''}|${ids}|${stamp}|${JSON.stringify(viewSettings)}`;
		if (key === lastCtxKey) return;
		lastCtxKey = key;
		onContextChange?.({
			parentId,
			selectedIds: [...selected],
			backend: driver.id,
			entries: nodes,
			viewSettings
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

	let isInsideProject = $state(false);
	let projectRootId = $state<ExplorerEntryId | null>(null);
	let isGitEnabled = $state(false);
	let gitRootId = $state<ExplorerEntryId | null>(null);
	let projectRooms = $state<ProjectRoom[]>([]);
	let projectCurrentRoomId = $state<string | null>(null);
	let pendingRoomSwitch = $state<{ kind: 'switch'; roomId: string } | { kind: 'new'; label: string } | null>(
		null
	);
	const showRoomChip = $derived(
		Boolean(onSwitchRoom && isInsideProject && isGitEnabled && projectRooms.length && localVfs)
	);
	const currentRoom = $derived(
		projectRooms.find((r) => r.id === projectCurrentRoomId) ?? projectRooms[0] ?? null
	);
	const showPeopleChip = $derived(
		Boolean(isInsideProject && (people || onInvitePeople))
	);
	const peopleHere = $derived((people ?? []).filter((p) => p.now.kind === 'here'));
	const peopleElsewhere = $derived((people ?? []).filter((p) => p.now.kind !== 'here'));
	let currentDetectGen = 0;
	let projectStorageOpen = $state(false);
	let projectIntegrityOpen = $state(false);
	const canProjectStorage = $derived(Boolean(localVfs && isInsideProject && projectRootId));

	$effect(() => {
		const curParentId = parentId;
		const d = driver;
		const vfs = localVfs;
		// An extract or import can add .git to the open folder without navigation.
		// Refresh increments this after the new listing has landed.
		void treeVersion;
		const gen = ++currentDetectGen;
		void Promise.all([
			findProjectRoot(d, curParentId, 'project'),
			findProjectRoot(d, curParentId, 'git')
		])
			.then(async ([project, git]) => {
				let rooms: ProjectRoom[] = [];
				let current: string | null = null;
				if (project.found && project.id && vfs) {
					const fromMeta = roomsFromMeta(await readProjectMeta(vfs, project.id));
					rooms = fromMeta.rooms;
					current = fromMeta.currentRoomId;
				}
				if (gen !== currentDetectGen) return;
				isInsideProject = project.found;
				projectRootId = project.found ? project.id : null;
				isGitEnabled = git.found;
				gitRootId = git.found ? git.id : null;
				projectRooms = rooms;
				projectCurrentRoomId = current;
				if (!rooms.length) roomMenuOpen = false;
				onRoomContext?.({
					rootId: project.found ? project.id : null,
					roomId: git.found ? current : null
				});
			})
			.catch(() => {
				if (gen !== currentDetectGen) return;
				isInsideProject = false;
				projectRootId = null;
				isGitEnabled = false;
				gitRootId = null;
				projectRooms = [];
				projectCurrentRoomId = null;
				roomMenuOpen = false;
				onRoomContext?.({ rootId: null, roomId: null });
			});
	});

	$effect(() => {
		// The dock with an empty selection previews the open folder, so project
		// detection follows that folder too. The driver root has no real id.
		const n =
			previewDock !== 'off' && !(selected.size === 0 && parentId == null) && selected.size <= 1
				? dockedPreviewEntry()
				: previewEntry;
		const want = hasProjectActions && n?.kind === 'folder' && n.id !== OPEN_ROOT_PREVIEW_ID;
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
		void detectProject(d, folderId, projectMarker).then(
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

	/**
	 * Operation errors surface as toasts only — the persistent inline banner is
	 * reserved for input validation (rename checks below), which is the one
	 * place an inline message is attached to the thing being edited.
	 */
	function reportMessage(msg: string): void {
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

	function isForeignCopyDrag(e?: DragEvent): boolean {
		if (dnd.getState().active) return false;
		if (getCrossWindowDrag() || isPointerDragActive()) return true;
		return Boolean(e && dataTransferHasExplorerIds(e.dataTransfer));
	}

	function applyForeignRowHover(n: ExplorerEntry) {
		copyHoverActive = true;
		if (n.kind === 'folder') {
			dndTargetId = n.id;
			dndZone = 'into';
			dndIntoId = undefined;
			dndLine = null;
			return;
		}
		dndTargetId = null;
		dndZone = 'into';
		dndIntoId = parentId;
		dndLine = null;
	}

	function applyRowHover(n: ExplorerEntry, clientX: number, clientY: number, rowEl: HTMLElement) {
		if (!dnd.getState().active) return;
		const rect = rowEl.getBoundingClientRect();
		let zone = zoneFromPoint(
			{ top: rect.top, left: rect.left, height: rect.height, width: rect.width },
			{ x: clientX, y: clientY },
			{
				kind: n.kind,
				supportsSiblingOrder: canReorder,
				layout: viewMode === 'icons' ? 'grid' : 'row'
			}
		);
		let target = n;
		let targetEl = rowEl;
		if (!canReorder) {
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
		if (dnd.getState().active) {
			if (!caps.supportsMove) return;
			dnd.setDropTarget(null, 'into');
		} else {
			copyHoverActive = true;
		}
		dndTargetId = null;
		dndZone = 'into';
		dndLine = null;
		dndIntoId = parentId;
	}

	function hoverGapAfterLast() {
		dndIntoId = undefined;
		if (!canReorder || !nodes.length) {
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
		const dragged = ids
			.map((id) => nodes.find((x) => x.id === id) ?? (id === n.id ? n : undefined))
			.filter((row): row is ExplorerEntry => Boolean(row));
		const fileTypes = [
			...new Set(
				dragged.map((row) =>
					row.kind === 'folder' ? 'folder' : (row.fileType ?? inferFileTypeFromName(row.name))
				)
			)
		];
		try {
			e.dataTransfer?.setData('text/plain', ids.join(','));
			e.dataTransfer?.setData(
				FE_EXPLORER_IDS_MIME,
				JSON.stringify({
					driverId: driver.id,
					ids,
					fileTypes,
					...(driver.connectionId ? { connectionId: driver.connectionId } : {})
				})
			);
			for (const ft of fileTypes) {
				e.dataTransfer?.setData(fileTypeMime(ft), ft);
			}
		} catch {
			/* jsdom may lack full DataTransfer */
		}

		// OS drag-out: Chromium DownloadURL is a URL string only — Chrome GETs
		// it on drop (mouseup), so this tab does not buffer the file. Fall back
		// to a cached File for local VFS (no HTTP URL).
		if (caps.supportsDragOut && e.dataTransfer) {
			try {
				const urls = ids
					.map((id) => {
						const row = nodes.find((x) => x.id === id);
						return getDragOutUrl(id, row?.name);
					})
					.filter((u): u is NonNullable<typeof u> => u != null);
				if (urls.length === 1) {
					e.dataTransfer.setData('DownloadURL', formatDownloadURL(urls[0]!));
				} else {
					for (const id of ids) {
						const row = nodes.find((x) => x.id === id);
						const file = getDragOutFile(id, row?.name);
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
		if (isForeignCopyDrag(e)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			applyForeignRowHover(n);
			return;
		}
		if (!dnd.getState().active) return;
		e.preventDefault();
		applyRowHover(n, e.clientX, e.clientY, e.currentTarget as HTMLElement);
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onNavDragOver(e: DragEvent, destParentId: string | null) {
		if (allowOsFileDrag(e)) return;
		if (isForeignCopyDrag(e)) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			hoverNavParent(destParentId);
			return;
		}
		if (!dnd.getState().active || !caps.supportsMove) return;
		e.preventDefault();
		e.stopPropagation();
		hoverNavParent(destParentId);
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onNavDrop(e: DragEvent, destParentId: string | null) {
		if (allowOsFileDrag(e)) return;
		if (isForeignCopyDrag(e)) {
			e.preventDefault();
			return;
		}
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
					supportsSiblingOrder: canReorder
				});
				if (!resolved.ok) {
					// The reason was computed and then discarded, so a drop the UI
					// had offered simply did nothing. Two of these are worth
					// saying out loud; a null zone or a self-drop is not.
					if (resolved.reason === 'unsupported-zone') {
						toast.info('This location cannot reorder items.');
					} else if (resolved.reason === 'invalid-target') {
						toast.info('Drop onto a folder, not a file.');
					}
					return;
				}
				for (const id of dragIds) {
					if (resolved.mode === 'move-into') {
						if (id === resolved.newParentId) continue;
						const before = nodes.find((e: ExplorerEntry) => e.id === id);
						const moved = await driver.move?.(id, resolved.newParentId);
						// A name already taken in the destination is silently
						// deduped. The user dragged `report.pdf` and now has
						// `report 2.pdf` — worth one line.
						if (moved && before && moved.name !== before.name) {
							toast.info(`Renamed to "${moved.name}" — that name was taken there.`);
						}
					} else if (canReorder && driver.reorder) {
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
			if (previewEntry) {
				const live = nextNodes.find((row) => row.id === previewEntry!.id);
				if (live) previewEntry = live;
			}
			if (floatingPreviewEntry) {
				const live = nextNodes.find((row) => row.id === floatingPreviewEntry!.id);
				if (live) floatingPreviewEntry = live;
			}
			// Pack membership for the rows now on screen. Best-effort and
			// non-blocking: a listing must never fail to render because a badge
			// could not be resolved.
			if (localVfs) {
				const forRows = nextNodes.filter((n) => n.kind === 'file').map((n) => n.id);
				void packBadges(localVfs, forRows)
					.then((badges) => {
						packedRows = badges;
					})
					.catch(() => {
						packedRows = new Map();
					});
			} else if (packedRows.size) {
				packedRows = new Map();
			}
			const folders = nextNodes.filter((n) => n.kind === 'folder');
			const markGen = gen;
			if (folders.length) {
				void Promise.all(folders.map(async (f) => [f.id, await classifyFolder(driver, f)] as const))
					.then((pairs) => {
						if (markGen !== refreshGen) return;
						folderMarks = new Map(pairs);
					})
					.catch(() => {
						if (markGen !== refreshGen) return;
						folderMarks = new Map();
					});
			} else if (folderMarks.size) {
				folderMarks = new Map();
			}
			if (focusIndex >= focusableEntries.length)
				focusIndex = focusableEntries.length ? focusableEntries.length - 1 : -1;
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
				// Archive writes thousands of small files; live re-list freezes Cancel.
				if (archiveJobRunning) return;
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
		if (focusIndex < 0 || focusIndex >= focusableEntries.length) return null;
		return focusableEntries[focusIndex] ?? null;
	}

	async function enterFolder(n: ExplorerEntry) {
		if (n.kind !== 'folder') return;
		trashOpen = false;
		navigatedFolder = n;
		parentId = n.id;
		selected = new Set();
		lastSelectedId = null;
		focusIndex = -1;
	}

	async function goCrumb(id: string | null) {
		trashOpen = false;
		navigatedFolder = id
			? breadcrumbs.find((folder) => folder.id === id) ??
				(navigatedFolder?.id === id ? navigatedFolder : null)
			: null;
		parentId = id;
		selected = new Set();
		lastSelectedId = null;
		focusIndex = -1;
	}

	async function reloadProjectRooms() {
		if (!localVfs || !projectRootId) return;
		const fromMeta = roomsFromMeta(await readProjectMeta(localVfs, projectRootId));
		projectRooms = fromMeta.rooms;
		projectCurrentRoomId = fromMeta.currentRoomId;
	}

	async function afterRoomChange() {
		const root = projectRootId;
		if (parentId && root && parentId !== root) {
			const path = await driver.getPath(parentId).catch(() => []);
			if (!path.length) await goCrumb(root);
		}
		await reloadProjectRooms();
		await refresh(true, 'delay', true);
	}

	async function applyRoomAction(
		pending: { kind: 'switch'; roomId: string } | { kind: 'new'; label: string },
		save: boolean
	): Promise<ExplorerRoomActionResult | 'error'> {
		const root = projectRootId;
		if (!root) return 'error';
		try {
			if (pending.kind === 'switch') {
				if (!onSwitchRoom) return 'error';
				return await onSwitchRoom({ rootId: root, roomId: pending.roomId, save });
			}
			if (!onNewRoom) return 'error';
			return await onNewRoom({ rootId: root, label: pending.label, save });
		} catch (e) {
			reportError(e);
			return 'error';
		}
	}

	let combineOpen = $state(false);
	let combinePending = $state<string | null>(null);
	let combineConflict = $state<{ label: string; roomId: string; paths: string[]; reasons?: Record<string, string> } | null>(null);
	let combineMissing = $state(false);

	function roomLabelOf(roomId: string): string {
		return projectRooms.find((r) => r.id === roomId)?.label ?? roomId;
	}

	async function runCombine(fromRoomId: string, save: boolean) {
		const root = projectRootId;
		if (!root || !onCombineRoom) return;
		combineConflict = null;
		try {
			const result = await onCombineRoom({ rootId: root, fromRoomId, save });
			if (result.status === 'dirty') {
				combinePending = fromRoomId;
				return;
			}
			combinePending = null;
			if (result.status === 'conflict') {
				combineConflict = {
					label: roomLabelOf(fromRoomId),
					roomId: fromRoomId,
					paths: result.paths,
					reasons: result.reasons
				};
				return;
			}
			if (result.status === 'live' || result.status === 'missing') {
				combineMissing = result.status === 'missing';
				return;
			}
			combineMissing = false;
			combineOpen = false;
			await afterRoomChange();
		} catch (e) {
			reportError(e);
		}
	}

	async function chooseRoom(roomId: string) {
		closeRoomMenu();
		if (!projectRootId || !onSwitchRoom) return;
		const pending = { kind: 'switch' as const, roomId };
		const result = await applyRoomAction(pending, false);
		if (result === 'dirty') {
			pendingRoomSwitch = pending;
			return;
		}
		if (result !== 'ok') return;
		projectCurrentRoomId = roomId;
		await afterRoomChange();
	}

	async function submitNewRoom() {
		const label = newRoomName.trim() || `Room ${projectRooms.length + 1}`;
		closeRoomMenu();
		if (!projectRootId || !onNewRoom) return;
		const pending = { kind: 'new' as const, label };
		const result = await applyRoomAction(pending, false);
		if (result === 'dirty') {
			pendingRoomSwitch = pending;
			return;
		}
		if (result !== 'ok') return;
		await afterRoomChange();
	}

	async function confirmSaveAndSwitch() {
		const pending = pendingRoomSwitch;
		pendingRoomSwitch = null;
		if (!pending) return;
		const result = await applyRoomAction(pending, true);
		if (result !== 'ok') return;
		if (pending.kind === 'switch') projectCurrentRoomId = pending.roomId;
		await afterRoomChange();
	}

	function personNowLabel(person: ExplorerPerson): string {
		if (person.now.kind === 'here') return 'In this room';
		if (person.now.kind === 'room') return `in ${person.now.label}`;
		if (person.lastSyncAt) {
			return `offline · ${new Date(person.lastSyncAt).toLocaleString()}`;
		}
		return 'offline';
	}

	function personSessionLabel(person: ExplorerPerson): string {
		if (person.sessionGrant === 'edit') return 'Can edit';
		if (person.sessionGrant === 'view') return 'View only';
		return '—';
	}

	function peopleChipText(): string {
		const names = peopleHere.map((p) => p.label).filter(Boolean);
		if (names.length) {
			const shown = names.slice(0, 2).join(', ');
			const extra = peopleElsewhere.length;
			return extra ? `${shown} +${extra}` : shown;
		}
		if (peopleElsewhere.length) return `+${peopleElsewhere.length}`;
		return 'People';
	}

	async function commitPersonLabel(pairingId: string, raw: string) {
		const next = raw.trim();
		if (!next) {
			const current = (people ?? []).find((p) => p.pairingId === pairingId);
			peopleRenameDrafts = { ...peopleRenameDrafts, [pairingId]: current?.label ?? '' };
			return;
		}
		await onRenamePerson?.(pairingId, next);
	}

	async function confirmRevokeEdit() {
		const person = revokeTarget;
		revokeTarget = null;
		if (!person) return;
		await onRevokePerson?.(person.pairingId);
	}

	function revokeToUnlink() {
		const person = revokeTarget;
		revokeTarget = null;
		if (person) unlinkTarget = person;
	}

	async function confirmUnlink(drain: ExplorerUnlinkDrain) {
		const person = unlinkTarget;
		unlinkTarget = null;
		if (!person) return;
		await onUnlinkPerson?.(person.pairingId, drain);
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
		// Saving onto an existing name: confirm overwrite before delegating.
		// A folder with the same name is never a valid overwrite target.
		const sameName = nodes.find((n) => n.name === name);
		if (sameName) {
			if (sameName.kind === 'folder') {
				error = `A folder named “${name}” already exists. Choose a different name.`;
				return;
			}
			const ok = await askConfirm(overwriteSaveCopy(name));
			if (!ok) return;
			try {
				await onSave({ parentId, name, overwrite: true });
			} catch (e) {
				reportError(e);
			}
			return;
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
		const restored = await driver.restore(n.id);
		// Restore falls back to the drive root when the original folder is gone,
		// and renames on top of that if the name is taken there. Both are
		// reasonable last resorts and neither should happen in silence — this is
		// the one action performed specifically to put something back.
		if (restored && typeof restored === 'object') {
			if (restored.name !== n.name) {
				toast.info(`Restored as "${restored.name}" — that name was taken.`);
			} else if (n.parentId != null && restored.parentId !== n.parentId) {
				toast.info(`Restored to the top level — the folder it came from is gone.`);
			}
		}
		await Promise.all([refreshTrash(), refresh()]);
	}

	async function permanentNode(n: ExplorerEntry) {
		if (!driver.permanentDelete) return;
		if (!(await askConfirm(permanentDeleteCopy(n.name)))) return;

		// A packed file's delete does real work beyond unlinking a row — it may
		// rewrite a shared pack to give the space back — so the stages are
		// surfaced rather than leaving the UI silent through them.
		const packed = localVfs ? (await packBadges(localVfs, [n.id])).get(n.id)?.packed : false;
		if (localVfs && packed) {
			const opId = generateId('packdel');
			const paint = (label: string, done = false) =>
				upsertProgress({
					id: opId,
					name: n.name,
					size: 100,
					transferred: done ? 100 : 50,
					direction: 'copying',
					done,
					status: done ? 'done' : 'active',
					hopNote: label
				});
			paint('Deleting — wiping from blob…');
			try {
				const result = await deleteFromProject(localVfs, [n.id], {
					onProgress: (ev) => paint(ev.label, ev.stage === 'done')
				});
				if (!result.reclaimedBytes) paint('Success! Blob integrity checked, delete successful', true);
			} catch (e) {
				// Reclamation is part of the delete: if it fails, the delete
				// failed, and the user is told rather than left with a success
				// that quietly kept the bytes.
				upsertProgress({
					id: opId,
					name: n.name,
					size: 100,
					transferred: 100,
					direction: 'copying',
					done: true,
					status: 'failed',
					error: formatExplorerError(e),
					hopNote: 'Delete failed'
				});
				reportError(e);
				await refreshTrash();
				return;
			}
			await refreshTrash();
			return;
		}

		await driver.permanentDelete(n.id);
		await refreshTrash();
	}

	function bumpEmptyTrashProgress(done: number, total: number, name?: string) {
		emptyTrashPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
		emptyTrashLabel = name || 'Emptying trash…';
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
				status: cancelled ? 'cancelled' : 'failed',
				error: cancelled ? undefined : formatExplorerError(e),
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
			evictDragOutFile(n.id);
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
		void healSelected(n);
	}

	/** Shift-click: replace the selection with the display-order range from the anchor. */
	function rangeSelect(n: ExplorerEntry) {
		const targetPos = focusPosById.get(n.id);
		if (targetPos == null) {
			selectExclusive(n);
			return;
		}
		const anchorPos = lastSelectedId != null ? focusPosById.get(lastSelectedId) : null;
		const lo = Math.min(anchorPos ?? targetPos, targetPos);
		const hi = Math.max(anchorPos ?? targetPos, targetPos);
		const next = new Set<string>();
		for (let i = lo; i <= hi; i++) {
			const entry = focusableEntries[i];
			if (entry) next.add(entry.id);
		}
		selected = next;
		// Keep the anchor so further shift-clicks extend from the same start.
		if (anchorPos == null) lastSelectedId = n.id;
	}

	/** Catalog type from the name. Never blocks select, preview, or delete. */
	async function healSelected(n: ExplorerEntry) {
		if (n.kind !== 'file' || !driver.healFileType) return;
		try {
			await driver.healFileType(n.id);
		} catch {
			/* ghost rows must still be clickable */
		}
	}

	function selectedPrimary(): ExplorerEntry | null {
		if (lastSelectedId) {
			const last = nodes.find((n) => n.id === lastSelectedId && selected.has(n.id));
			if (last) return last;
		}
		return selectedEntries[0] ?? null;
	}

	/** What the dock shows for one item: the selection, or the open folder when nothing is selected. */
	function dockedPreviewEntry(): ExplorerEntry | null {
		if (selected.size > 1) return null;
		return selectedPrimary() ?? openFolderEntry;
	}

	function previewTarget(): ExplorerEntry | null {
		return floatingPreviewEntry ?? previewEntry;
	}

	function previewInfoLine(entry: ExplorerEntry): string {
		const parts: string[] = [];
		// Folder totals are not on the row. The preview offers Calculate size
		// instead of printing "Unknown size".
		if (entry.kind !== 'folder') parts.push(formatBytes(entry.size));
		if (entry.fileType) parts.push(entry.fileType);
		if (entry.updatedAt) {
			const when = formatWhen(entry.updatedAt);
			if (when) parts.push(when);
		}
		return parts.join(' · ');
	}

	function dismissPreviewPopup() {
		if (floatingPreviewEntry) closeQuickLook();
		if (previewDock === 'off') previewEntry = null;
	}

	function openSelectedDetails() {
		const n = selectedPrimary();
		if (!n) return;
		previewEntry = n;
		actionsMenuOpen = false;
		if (previewDock !== 'off') {
			floatingPreviewEntry = n;
			quickLookPinned = true;
			quickLookPeek = false;
		}
	}

	let actionsMenuOpen = $state(false);

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

	/**
	 * Hiding mid-job (Hide button, Escape, scrim) must not strand the job with
	 * no way back — the header chip asks the archiveReshow registry first and
	 * lands here. Registered for the pane's lifetime; it declines whenever this
	 * pane has nothing hidden and running, so other panes get their turn.
	 */
	function showHiddenArchiveDialog(opId?: string): boolean {
		if (opId && archiveTransferId !== opId) return false;
		if (!archiveJobRunning || archiveDialogOpen) return false;
		archiveDialogOpen = true;
		return true;
	}

	const archivePendingScratch = new Map<string, ListingPending>();
	let archiveListingFlush: ReturnType<typeof setTimeout> | null = null;

	function flushArchiveListing() {
		archiveListingFlush = null;
		const archiveIds = new Set(archiveInboundIds);
		inboundOps = [
			...inboundOps.filter((o) => !archiveIds.has(o.id)),
			...archivePendingScratch.values()
		];
	}

	function settleArchiveListing() {
		if (archiveListingFlush) {
			clearTimeout(archiveListingFlush);
			archiveListingFlush = null;
		}
		const ids = archiveInboundIds;
		archivePendingScratch.clear();
		archiveNameToId.clear();
		archiveInboundIds = [];
		inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
	}

	function bumpArchiveProgress(ev: ArchiveWriteProgress) {
		if (ev.job) {
			if (ev.note) archiveJobLabel = ev.note;
			if (ev.size > 0) {
				const pct = Math.min(100, Math.round((ev.transferred / ev.size) * 100));
				// Monotonic within a job, reset explicitly when one starts.
				//
				// "One job emits sequentially" does not hold: a worker extract
				// that fails partway hands over to the main-thread runner, which
				// starts its own count at zero — so the bar ran up to nearly full
				// and dropped back, repeatedly, exactly as reported. The runners
				// each emit sensibly; it is the handover between them that the
				// user sees. Clamping here makes the guarantee hold however many
				// runners contribute, rather than trusting each one to be the
				// only one.
				if (pct > archiveJobPct) archiveJobPct = pct;
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
		const key = `${ev.parentId ?? ''}::${ev.entryKind ?? 'file'}::${ev.name}`;
		let id = archiveNameToId.get(key);
		if (!id) {
			id = generateId('archive');
			archiveNameToId.set(key, id);
			archiveInboundIds = [...archiveInboundIds, id];
		}
		const row: ListingPending = {
			id,
			name: ev.name,
			transferred: ev.transferred,
			size: ev.size,
			direction: 'receiving',
			done: ev.done,
			destParentId: ev.parentId,
			entryKind: ev.entryKind ?? 'file'
		};
		archivePendingScratch.set(id, row);
		if (!archiveListingFlush) {
			archiveListingFlush = setTimeout(flushArchiveListing, 50);
		}
	}

	function abortArchiveJob() {
		archiveJobLabel = 'Cancelling…';
		if (archiveTransferId) {
			upsertProgress({
				id: archiveTransferId,
				name: archiveChipName || 'Archive',
				size: 100,
				transferred: archiveJobPct,
				direction: 'copying',
				done: false,
				status: 'active',
				hopNote: 'Cancelling…'
			});
		}
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
			// Prefer the worker for plain extracts into a folder: it reads the
			// archive from OPFS itself and writes members with sync access
			// handles, so no bytes cross the boundary and inflate is ~12x
			// faster than on this thread. Everything else — popup/memory
			// destinations, host jobs, compress/encrypt — stays here, and any
			// worker failure falls through to the same path.
			const workerClient =
				localVfs && !spec.useHost && (spec.kind === 'decompress' || spec.kind === 'decrypt')
					? getVfsWorkerClient()
					: null;
			const destSupported = spec.dest === 'same' || spec.dest === 'folder';
			const workerEligible = workerClient != null && driver.id === 'local' && destSupported;
			// Distinguish "this job was never a worker candidate" (popup dest,
			// host job, compress) from "we wanted the worker and could not have
			// it". Only the second is a degradation worth telling anyone about.
			const workerWanted =
				localVfs != null &&
				driver.id === 'local' &&
				destSupported &&
				!spec.useHost &&
				(spec.kind === 'decompress' || spec.kind === 'decrypt');

			await beginArchiveOp(id, spec.kind === 'decompress' ? 'extract' : spec.kind, spec.title, spec.destParentId ?? null, ac.signal, { driverId: driver.id, endpointKey: driver.endpointKey ?? driver.connectionId, executor: spec.useHost ? 'monitor' : 'this-browser', note: spec.useHost ? 'Monitor archive job' : workerEligible ? 'Background archive worker' : 'This tab · main thread', windowId: originWindowId });

			let result: Awaited<ReturnType<typeof runArchiveJob>> | undefined;
			let ranOnWorker = false;
			/** Non-null once we have degraded, so the UI can say WHY. */
			let fallbackReason: string | null = null;
			if (workerEligible && localVfs) {
				try {
					await workerClient!.extract(
						{
							dbName: localVfs.db.name,
							opfsRoot: 'shared-vfs',
							kind: spec.kind === 'decrypt' ? 'decrypt' : 'decompress',
							entryIds: spec.entries.filter((e) => e.kind === 'file').map((e) => e.id),
							destParentId: spec.destParentId,
							title: spec.title,
							password: spec.password,
							skipSystemFiles: spec.skipSystemFiles,
							wrapInSubfolder: spec.wrapInSubfolder !== false,
							compressEngineId: spec.compressEngineId,
							pack: spec.pack === true
						},
						{ signal: ac.signal, onProgress: bumpArchiveProgress }
					);
					ranOnWorker = true;
					result = { title: spec.title, engines: [] };
					await localVfs.reloadCatalog();
				} catch (e) {
					// A cancel is the user's decision, not a worker fault.
					if (e instanceof Error && e.name === 'AbortError') throw e;
					// Do not re-run the extract on this tab. The worker may
					// already have written members into OPFS; a second pass
					// duplicates them. Unavailable worker (null client) still
					// takes the main-thread path below.
					throw e;
				}
			}
			if (!ranOnWorker) {
				if (!fallbackReason && workerWanted && workerClient == null) {
					fallbackReason =
						vfsWorkerUnavailableReason() ?? 'Background file workers are unavailable.';
				}
				if (fallbackReason) {
					archiveJobLabel = 'Extracting on this tab (background worker unavailable)…';
					upsertProgress({ id, name: spec.title, size: 100, transferred: archiveJobPct, direction: 'copying', done: false, status: 'active', hopNote: `${archiveJobLabel} ${fallbackReason}` });
				}
				result = await runArchiveJob({
					...spec,
					signal: ac.signal,
					onProgress: bumpArchiveProgress
				});
			}
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
				status: cancelled ? 'cancelled' : 'failed',
				error: cancelled ? undefined : formatExplorerError(e),
				hopNote: cancelled ? 'Cancelled' : 'Failed'
			});
			if (cancelled) toast.info('Cancelled');
			else toast.error(formatExplorerError(e));
			settleArchiveListing();
			hideArchiveDialog();
			closeArchive();
		} finally {
			archiveJobRunning = false;
			if (archiveAbort === ac) archiveAbort = null;
			if (archiveTransferId === id) archiveTransferId = null;
		}
	}

	async function finishArchive(
		result?: import('./archiveOps.js').ArchiveJobResult
	) {
		settleArchiveListing();
		hideArchiveDialog();
		closeArchive();
		if (result?.innerSession) {
			innerFs = result.innerSession;
			return;
		}
		if (result?.inner?.length) {
			try {
				innerFs = await createInnerFsSession(result.title, result.inner);
			} catch (e) {
				reportError(e);
			}
			return;
		}
		await refresh();
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
			// Opening straight from the listing skips FeArchiveDialog, so nothing
			// has instantiated the engine yet. Start that in parallel with the
			// read: cold WASM load measured ~8s, and it is a one-time cost that
			// should overlap the I/O rather than sit inside the click.
			prewarmExpandEngines([entry.name]);
			const bytes = await readEntryBytes(driver, entry);
			const files = await expandPackedBytes(bytes, entry.name);
			innerFs = await createInnerFsSession(entry.name, files);
			dismissPreviewPopup();
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
		if (next === 'off') persistKv.removeItem(PREVIEW_DOCK_KEY);
		else persistKv.setItem(PREVIEW_DOCK_KEY, next);
	}

	function cyclePreviewDock() {
		const next: PreviewDock =
			previewDock === 'off' ? 'bottom' : previewDock === 'bottom' ? 'right' : 'off';
		previewDock = next;
		persistPreviewDock(next);
		if (next === 'off') previewEntry = null;
	}

	function persistTreeDock(next: TreeDock) {
		if (next === 'off') persistKv.removeItem(TREE_DOCK_KEY);
		else persistKv.setItem(TREE_DOCK_KEY, next);
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
		return formatSize(n);
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
		if (entry.fileType === 'kb') return 'Open in Documents';
		if (entry.fileType === 'anim') return 'Open in Animations';
		if (entry.fileType === 'vide') return 'Open in Video';
		if (entry.fileType === 'vrec') return 'Open in voice';
		if (entry.fileType === 'vcomp') return 'Open in voice';
		if (entry.fileType === 'image') return 'Open in Images';
		if (entry.fileType === 'video') return 'Open in Simple Video';
		if (entry.fileType === 'audio') return 'Open in Audio';
		if (entry.fileType === 'pdf') return 'Open PDF';
		if (entry.fileType === 'text') return 'Open in Text Editor';
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
		const n = previewTarget();
		if (!n) return;
		if (n.kind === 'folder') {
			dismissPreviewPopup();
			await enterFolder(n);
			return;
		}
		if (await openPackedEntry(n)) return;
		if (!onOpen) return;
		previewBusy = true;
		try {
			await emitOpen(n);
			dismissPreviewPopup();
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	async function confirmOpenProject() {
		const n = previewTarget();
		if (!n || n.kind !== 'folder' || !onOpenProject) return;
		previewBusy = true;
		try {
			const ok = await detectProject(driver, n.id, projectMarker);
			previewIsProject = ok;
			if (!ok) {
				reportMessage('Not a git project');
				return;
			}
			error = '';
			await onOpenProject(n);
			closePreviewForHandoff();
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	async function confirmInitProject() {
		const n = previewTarget();
		if (!n || n.kind !== 'folder' || !onInitProject) return;
		previewBusy = true;
		try {
			const already = await detectProject(driver, n.id, projectMarker);
			if (already) {
				previewIsProject = true;
				if (onOpenProject) {
					error = '';
					await onOpenProject(n);
					closePreviewForHandoff();
				} else {
					reportMessage('Already a git project');
				}
				return;
			}
			error = '';
			await onInitProject(n);
			previewIsProject = true;
			// The project's commit panel opens next; the portalled preview would cover it.
			closePreviewForHandoff();
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	function renamePreviewItem() {
		const n = previewTarget();
		if (!n) return;
		dismissPreviewPopup();
		startRename(n);
	}

	async function copyPreviewItem() {
		const n = previewTarget();
		if (!n) return;
		await putFilesOnClipboard([n], 'copy');
		dismissPreviewPopup();
		await tick();
		rootEl?.focus();
	}

	async function cutPreviewItem() {
		const n = previewTarget();
		if (!n) return;
		await putFilesOnClipboard([n], 'cut');
		dismissPreviewPopup();
		await tick();
		rootEl?.focus();
	}

	async function deletePreviewItem() {
		const n = previewTarget();
		if (!n) return;
		dismissPreviewPopup();
		await deleteIds([n.id]);
	}

	function renameSelectedItem() {
		if (selectedEntries.length !== 1) return;
		startRename(selectedEntries[0]!);
	}

	async function confirmPreviewSend() {
		const n = previewTarget();
		if (!n || !onSendFile) return;
		previewBusy = true;
		try {
			await onSendFile(n);
			dismissPreviewPopup();
		} catch (e) {
			reportError(e);
		} finally {
			previewBusy = false;
		}
	}

	function isRowControl(t: EventTarget | null): boolean {
		return (
			t instanceof Element &&
			!!t.closest(
				'input, button, a, [contenteditable="true"], [data-testid="fe-presence-dot"], [data-testid="fe-presence-dots"]'
			)
		);
	}

	/** Ctrl/Cmd-click toggles one row and leaves the rest of the selection. */
	function isAdditiveClick(e?: MouseEvent): boolean {
		return Boolean(e && (e.ctrlKey || e.metaKey) && !e.shiftKey);
	}

	function toggleSelected(id: string, e?: Event) {
		e?.stopPropagation();
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
		lastSelectedId = next.has(id) ? id : next.size ? [...next][next.size - 1]! : null;
	}

	function toggleSelect(id: string, e?: Event) {
		if (!canToggleSelect()) return;
		toggleSelected(id, e);
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
	/** Skip the second pointerup of a plain double-click so multi-select doesn't toggle off. */
	let lastRowActivate: { id: string; at: number; additive: boolean } | null = null;
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
		focusIndex = focusPosById.get(start.id) ?? -1;
		selectedOnPointerUp = true;
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		const additive = e.ctrlKey || e.metaKey;
		// A second plain click on the same row is the double-click that opens it.
		// A Ctrl/Cmd-click is its own toggle, and a plain click after one still
		// selects that row.
		if (
			lastRowActivate &&
			lastRowActivate.id === n.id &&
			!lastRowActivate.additive &&
			now - lastRowActivate.at < DBLCLICK_MS &&
			!additive
		) {
			return;
		}
		lastRowActivate = { id: n.id, at: now, additive };
		void applyRowActivate(n, e);
	}

	function onRowClick(e: MouseEvent, n: ExplorerEntry, i: number) {
		if (isRowControl(e.target)) return;
		if (e.detail > 1) return;
		if (selectedOnPointerUp) {
			selectedOnPointerUp = false;
			return;
		}
		focusIndex = focusPosById.get(n.id) ?? -1;
		void applyRowActivate(n, e);
	}

	function onRowDblClick(e: MouseEvent, n: ExplorerEntry, i: number) {
		if (isRowControl(e.target)) return;
		if (renamingId === n.id) return;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		focusIndex = focusPosById.get(n.id) ?? -1;
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

	async function applyRowActivate(n: ExplorerEntry, e?: MouseEvent) {
		if (e?.shiftKey && (mode === 'manage' || mode === 'open')) {
			rangeSelect(n);
			return;
		}
		if (isAdditiveClick(e) && (mode === 'manage' || mode === 'open')) {
			toggleSelected(n.id, e);
			return;
		}
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

	// ── Marquee select — drag from the list's empty background to box-select ──
	/** Mouse/pen only: touch drags from the background scroll the listing. */
	let marquee = $state<{
		x0: number;
		y0: number;
		x1: number;
		y1: number;
		base: Set<string>;
		pointerId: number;
	} | null>(null);
	let marqueeListen = false;
	const MARQUEE_SLOP_PX = 4;

	function attachMarqueeListeners() {
		if (marqueeListen || typeof document === 'undefined') return;
		marqueeListen = true;
		document.addEventListener('pointermove', onMarqueeMove, { capture: true, passive: false });
		document.addEventListener('pointerup', onMarqueeUp, { capture: true });
		document.addEventListener('pointercancel', onMarqueeUp, { capture: true });
	}

	function detachMarqueeListeners() {
		if (!marqueeListen || typeof document === 'undefined') return;
		marqueeListen = false;
		document.removeEventListener('pointermove', onMarqueeMove, true);
		document.removeEventListener('pointerup', onMarqueeUp, true);
		document.removeEventListener('pointercancel', onMarqueeUp, true);
	}

	function stopMarquee() {
		marquee = null;
		detachMarqueeListeners();
	}

	function onListPointerDown(e: PointerEvent) {
		// Same button quirk as onRowPointerDown: jsdom events carry no button.
		if ((e.button != null && e.button !== 0) || e.pointerType === 'touch') return;
		const t = e.target;
		if (!(t instanceof Element) || !listEl?.contains(t)) return;
		if (
			t.closest('.fe-row, .fe-dnd-line, input, button, a, [contenteditable="true"], .fe-busy-overlay')
		)
			return;
		marquee = {
			x0: e.clientX,
			y0: e.clientY,
			x1: e.clientX,
			y1: e.clientY,
			base: new Set(selected),
			pointerId: e.pointerId
		};
		attachMarqueeListeners();
	}

	/** Real row ids whose rect intersects the marquee, in display order. */
	function marqueeHits(m: { x0: number; y0: number; x1: number; y1: number }): string[] {
		const l = Math.min(m.x0, m.x1);
		const t = Math.min(m.y0, m.y1);
		const r = Math.max(m.x0, m.x1);
		const b = Math.max(m.y0, m.y1);
		const out: string[] = [];
		for (const el of listEl?.querySelectorAll('[data-fe-row-id]') ?? []) {
			const rect = el.getBoundingClientRect();
			if (rect.right < l || rect.left > r || rect.bottom < t || rect.top > b) continue;
			out.push(el.getAttribute('data-fe-row-id')!);
		}
		return out;
	}

	function onMarqueeMove(e: PointerEvent) {
		// @ts-expect-error debug
		globalThis.__dbg?.('move pid=' + e.pointerId + ' marquee=' + (marquee ? 'set' : 'null'));
		if (!marquee || e.pointerId !== marquee.pointerId) return;
		e.preventDefault();
		marquee = { ...marquee, x1: e.clientX, y1: e.clientY };
		if (Math.hypot(marquee.x1 - marquee.x0, marquee.y1 - marquee.y0) < MARQUEE_SLOP_PX) return;
		const next = new Set(marquee.base);
		for (const id of marqueeHits(marquee)) next.add(id);
		if (next.size !== selected.size || [...next].some((id) => !selected.has(id))) selected = next;
	}

	function onMarqueeUp(e: PointerEvent) {
		if (!marquee || e.pointerId !== marquee.pointerId) return;
		const m = marquee;
		stopMarquee();
		if (Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < MARQUEE_SLOP_PX) {
			// A plain click on the empty background clears the selection.
			if (selected.size > 0) selected = new Set();
			lastSelectedId = null;
			focusIndex = -1;
			return;
		}
		const next = new Set(m.base);
		for (const id of marqueeHits(m)) next.add(id);
		selected = next;
		// Anchor shift-click at the furthest-down-list hit, like a focus move.
		let bestPos = -1;
		let bestId: string | null = null;
		for (const id of next) {
			const p = focusPosById.get(id);
			if (p != null && p > bestPos) {
				bestPos = p;
				bestId = id;
			}
		}
		lastSelectedId = bestId;
		focusIndex = bestPos;
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
	/** System files (leading-dot names) are display-hidden by default — this
	 *  filter only touches the rendering, so an entry the user names explicitly
	 *  (open/save path, copy dest) still reaches the backend as before. */
	const visibleRows = $derived(
		showHidden ? listingRows : listingRows.filter((r) => !r.node.name.startsWith('.'))
	);
	/**
	 * Detailed view may re-order the listing client-side. Unsorted (or in
	 * other views) the rows pass through in driver order so sibling
	 * reorder can stick; a sort always renders a stable copy.
	 */
	const sortedRows = $derived(
		activeSort ? sortListingRows(visibleRows, activeSort.col, activeSort.dir, foldersFirst) : visibleRows
	);
	/** Reorder needs the driver's manual order — sorting it away makes before/after drops meaningless. */
	const canReorder = $derived(caps.supportsSiblingOrder && !activeSort);
	/** Real rows in display order — click focus and arrow-key nav walk this, not nodes. */
	const focusableEntries = $derived.by(() => {
		const out: ExplorerEntry[] = [];
		for (const row of sortedRows) if (!row.placeholder) out.push(row.node);
		return out;
	});
	const focusPosById = $derived.by(() => {
		const m = new Map<string, number>();
		focusableEntries.forEach((entry, idx) => m.set(entry.id, idx));
		return m;
	});
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

	function folderCopySupported(): boolean {
		if (caps.supportsFolderCopy === false) return false;
		return caps.supportsCopy;
	}

	async function putFilesOnClipboard(entries: ExplorerEntry[], mode: 'copy' | 'cut') {
		if (mode === 'cut' ? !canCutFiles : !canCopyFiles) return;
		if (!entries.length) return;
		if (mode === 'copy' && entries.some((entry) => entry.kind === 'folder') && !folderCopySupported()) {
			toast.error('Cannot copy');
			return;
		}
		rememberClipboardSource(driver);
		const payload: FileClipboardPayload = {
			mode, clipboardId: generateId('clip'), sourceDriverId: driver.id,
			sourceConnectionId: driver.connectionId, sourceParentId: parentId,
			ids: entries.map((entry) => entry.id), entries: clipboardEntries(entries)
		};
		const image = mode === 'copy' && entries.length === 1 && getPreviewKind(entries[0]) === 'image';
		systemClip = null;
		// The store starts the native write during the click/keypress and retains it
		// for the history popup's Copy to system action.
		const sourceDriver = driver;
		try {
			await appClipboard.copy(FILE_CLIPBOARD_TYPE, fileClipboardLabel(payload), payload,
				fileClipboardText(payload), { syncWithSystem: !fileClipboardHasFolders(payload), systemWriter: () => image
					? copyImageToSystem(sourceDriver, entries[0], payload) : copyFilesToSystem(payload) });
			if (mode === 'copy') toast.success('Copied to clipboard');
		} catch (e) {
			reportMessage(`Could not copy ${image ? 'image' : 'files'} to the system clipboard: ${errMsg(e)}`);
		}
	}

	function entriesForClipboard(): ExplorerEntry[] {
		const ids = new Set(idsForClipboard());
		return nodes.filter((entry) => ids.has(entry.id));
	}

	async function cutSelection() {
		if (mode !== 'manage') return;
		await putFilesOnClipboard(entriesForClipboard(), 'cut');
	}

	async function copySelection() {
		if (mode !== 'manage') return;
		await putFilesOnClipboard(entriesForClipboard(), 'copy');
	}

	/** Consume only completed moves, retaining failed items and newer clipboard operations. */
	async function consumeCut(payload: FileClipboardPayload, id: string) {
		markClipboardFileMoved(payload, id);
		payload.ids = payload.ids.filter((next) => next !== id);
		payload.entries = payload.entries.filter((entry) => entry.id !== id);
		const current = clipboard;
		if (!current || current.clipboardId !== payload.clipboardId) return;
		let sync = false;
		try {
			let system = navigator.clipboard.read ? await fileClipboardFromItems(await navigator.clipboard.read()) : null;
			if (!system && navigator.clipboard.readText) {
				const text = await navigator.clipboard.readText();
				system = fileClipboardFromOwnedText(text) ?? fileClipboardFromText(text);
			}
			sync = Boolean(system && system.clipboardId === payload.clipboardId);
		} catch { /* Internal clipboard remains usable without OS read permission. */ }
		if (clipboard?.clipboardId !== payload.clipboardId) return;
		try {
			await appClipboard.copy(FILE_CLIPBOARD_TYPE, fileClipboardLabel(payload), { ...payload },
				fileClipboardText(payload), { syncWithSystem: sync && payload.ids.length > 0,
					systemWriter: () => copyFilesToSystem(payload) });
		} catch { /* A clipboard write failure must not interrupt the remaining file moves. */ }
		if (sync && !payload.ids.length) {
			try { await navigator.clipboard.writeText(''); } catch { /* Completed cuts stay consumed internally. */ }
		}
	}

	async function pasteClipboard(eventPayload?: FileClipboardPayload, fromEvent = false) {
		if (mode !== 'manage' || pasteBusy) return;
		pasteBusy = true;
		error = '';
		// Keep the operation bound to the destination where Paste was invoked.
		const destDriver = driver;
		const destParentId = parentId;
		try {
			if (!fromEvent) await refreshSystemClipboard();
			const payload = eventPayload ?? clipboard;
			if (payload) {
				if (!payload.ids.length) return;
				if (sameClipboardSource(payload, destDriver) &&
					(payload.mode === 'cut' || destDriver.copy)) {
					const ids = [...payload.ids];
					for (const id of ids) {
						if (payload.mode === 'cut') {
							const entry = payload.entries.find((next) => next.id === id);
							if (entry?.parentId !== destParentId) {
								if (!destDriver.move || !destDriver.capabilities.supportsMove) throw new Error('MOVE_UNSUPPORTED');
								await destDriver.move(id, destParentId);
							}
							await consumeCut(payload, id);
						} else {
							if (!destDriver.copy || !destDriver.capabilities.supportsCopy) throw new Error('COPY_UNSUPPORTED');
							await destDriver.copy(id, destParentId);
						}
					}
				} else if (onCopyAcrossFromClipboard) {
					await onCopyAcrossFromClipboard(payload, destParentId,
						(id) => consumeCut(payload, id));
				} else {
					throw new Error('Open the source connection in another file window to paste these items');
				}
				selected = new Set();
			} else if (canImportFromDevice && systemClip?.files.length) {
				await importDeviceFiles(systemClip.files, destParentId);
			} else {
				reportMessage('Clipboard is empty or not readable');
			}
		} catch (e) {
			reportError(e);
		} finally {
			pasteBusy = false;
			await refresh();
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
					direction: 'receiving',
					destParentId: n.parentId
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
	const canCopyFiles = $derived(caps.supportsCopy || canReadExplorerBlob(driver));
	const canCutFiles = $derived(caps.supportsMove || (canImportFromDevice && canReadExplorerBlob(driver)));
	const canPasteFiles = $derived(Boolean(
		(clipboard?.ids.length && (sameClipboardSource(clipboard, driver)
			? clipboard.mode === 'cut' ? canCutFiles : caps.supportsCopy || onCopyAcrossFromClipboard
			: onCopyAcrossFromClipboard)) ||
		(canImportFromDevice && (systemClip?.files.length ||
			(typeof navigator !== 'undefined' && (navigator.clipboard?.read || navigator.clipboard?.readText))))
	));
	/** File-picker chrome is local writeFile only; remotes import via drop / copy-across. */
	// osDrop takes `driver.upload ?? driver.writeFile`, so an upload-only driver
	// (B2, monitor) can import device files perfectly well. Gating the
	// picker on writeFile alone hid the button on every remote backend while
	// drag-and-drop to the same pane still worked.
	const showDeviceFilePicker = $derived(Boolean(driver.writeFile || driver.upload));

	async function refreshSystemClipboard() {
		// Folder operations deliberately leave the OS clipboard alone. Keep the app
		// operation available across panes until the next app Copy/Cut replaces it.
		if (fileClipboardHasFolders(clipboard)) return;
		if (typeof navigator === 'undefined' || !navigator.clipboard) return;
		const previous = appClipboard.current;
		try {
			let text = '';
			let next: SystemClip | null = null;
			let files: FileClipboardPayload | null = null;
			if (navigator.clipboard.read) {
				try {
					const items = await navigator.clipboard.read();
					files = await fileClipboardFromItems(items);
					for (const item of items) {
						if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
					}
					if (!files && !fileClipboardFromText(text)) next = await payloadFromClipboardItems(items);
				} catch (e) {
					if (!navigator.clipboard.readText) throw e;
					text = await navigator.clipboard.readText();
					files = fileClipboardFromOwnedText(text) ?? fileClipboardFromText(text);
					next = files ? null : payloadFromText(text);
				}
			} else if (navigator.clipboard.readText) {
				text = await navigator.clipboard.readText();
				files = fileClipboardFromOwnedText(text) ?? fileClipboardFromText(text);
				next = files ? null : payloadFromText(text);
			} else return;
			// A slow permission prompt must not overwrite a subsequent Copy/Cut.
			if (appClipboard.current !== previous) return;
			await adoptSystemClipboard(text, next, files);
		} catch {
			/* permission / unsupported — keep last snapshot from paste */
		}
	}

	async function adoptSystemClipboard(text: string, next: SystemClip | null, refs: FileClipboardPayload | null = null) {
		const files = refs ?? fileClipboardFromText(text);
		systemClip = files ? null : next;
		if (files) {
			if (JSON.stringify(files) !== JSON.stringify(clipboard)) {
				const source = sameClipboardSource(files, driver) ? driver : clipboardSource(files);
				const entry = files.mode === 'copy' && files.ids.length === 1 ? files.entries.find((e) => e.id === files.ids[0]) : null;
				await appClipboard.copy(FILE_CLIPBOARD_TYPE, fileClipboardLabel(files), files,
					fileClipboardText(files), { syncWithSystem: false, systemWriter: () => source && entry && getPreviewKind(entry) === 'image'
						? copyImageToSystem(source, entry, files) : copyFilesToSystem(files) });
			}
		} else if (clipboard) {
			// External clipboard changes replace the active operation; history is not a paste fallback.
			await appClipboard.copy('text/plain', next?.label ?? 'System clipboard', text,
				undefined, { syncWithSystem: false });
		}
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		if (mode !== 'manage') return;
		const onPaste = (e: ClipboardEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			if (!target || target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
			if (!rootEl?.contains(target) && !(isTarget && target === document.body)) return;
			if (e.defaultPrevented || !e.clipboardData) return;
			if (fileClipboardHasFolders(clipboard)) {
				e.preventDefault();
				void pasteClipboard(clipboard!, true);
				return;
			}
			const text = e.clipboardData.getData('text/plain');
			let files = fileClipboardFromHtml(e.clipboardData.getData('text/html')) ??
				fileClipboardFromText(text) ?? fileClipboardFromOwnedText(text);
			const next = payloadFromDataTransfer(e.clipboardData);
			e.preventDefault();
			void (async () => {
				if (!files && next?.kind === 'image' && next.files.length === 1) {
					files = await fileClipboardForPastedImage(next.files[0]);
				}
				await adoptSystemClipboard(text, files ? null : next, files);
				await pasteClipboard(files ?? undefined, true);
			})();
		};
		const onFocus = () => void refreshSystemClipboard();
		const onVis = () => {
			if (document.visibilityState === 'visible') void refreshSystemClipboard();
		};
		document.addEventListener('paste', onPaste, true);
		window.addEventListener('focus', onFocus);
		document.addEventListener('visibilitychange', onVis);
		document.addEventListener('clipboardchange', onFocus);
		// Subscribe to lifecycle events, not internal Copy/Cut updates. A remote image
		// download may still be writing its native clipboard representation.
		untrack(() => void refreshSystemClipboard());
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
		const idByPath = new Map<string, string>();
		// The header bar carries the transfer-shaped view (same as the dual
		// pane): every import from this device is a transfer into the open
		// destination, remote or local. The listing keeps its pending rows.
		let reporter: Awaited<ReturnType<typeof createDeviceImportReporter>> | null = null;
		const bump = (ev: OsDropFileProgress) => {
			const key = `${ev.entryKind ?? 'file'}:${ev.relativePath ?? ev.name}`;
			let id = idByPath.get(key);
			if (!id) {
				id = generateId('osdrop');
				idByPath.set(key, id);
				ids.push(id);
			}
			const row: ListingPending = {
				id,
				name: ev.name,
				transferred: ev.transferred,
				size: ev.size,
				direction: 'receiving',
				done: ev.done,
				destParentId: ev.parentId ?? destParentId,
				entryKind: ev.entryKind ?? 'file'
			};
			inboundOps = inboundOps.some((o) => o.id === id)
				? inboundOps.map((o) => (o.id === id ? row : o))
				: [...inboundOps, row];
			if (ev.entryKind !== 'folder') reporter?.onFile(ev);
		};
		try {
			reporter = await createDeviceImportReporter(driver, destParentId, originWindowId);
			const incoming = await dropNodes;
			if (!incoming.length) { reporter.done(); return; }
			await importOsDropToDriver(driver, destParentId, incoming, {
				onFile: bump,
				signal: reporter?.signal
			});
			reporter.done();
			await refresh();
		} catch (e) {
			reporter?.fail(e);
			reportError(e);
		} finally {
			inboundOps = inboundOps.filter((o) => !ids.includes(o.id));
			uploadBusy = false;
		}
	}

	async function importDeviceFiles(
		files: File[],
		destParentId: string | null = parentId,
		fromPicker = false
	) {
		if (!files.length) return;
		// Input-picked Files remain readable after the change handler returns.
		// Clipboard Files may not, so only that route needs an eager snapshot.
		await importOsNodes(fromPicker ? Promise.resolve(nodesFromFiles(files)) : snapshotFiles(files), destParentId);
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
		if (isForeignCopyDrag(e)) {
			if ((e.target as HTMLElement).closest?.('.fe-row')) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			hoverNavParent(parentId);
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
		if (t?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (marquee) {
				stopMarquee();
				return;
			}
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
			if (!focusableEntries.length) return;
			focusIndex = Math.min(focusableEntries.length - 1, Math.max(0, focusIndex) + 1);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (!focusableEntries.length) return;
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
			if (e.repeat) return;
			const target = quickLookTarget();
			if (target) {
				e.preventDefault();
				if (floatingPreviewEntry && quickLookPinned) {
					if (floatingPreviewEntry.id === target.id) closeQuickLook();
					else openQuickLook(target, true);
					return;
				}
				spaceDownAt = Date.now();
				openQuickLook(target, false);
				return;
			}
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
			if (mode === 'manage' && canCopyFiles) {
				e.preventDefault();
				copySelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
			if (mode === 'manage' && canCutFiles) {
				e.preventDefault();
				cutSelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && mode === 'manage' && fileClipboardHasFolders(clipboard)) {
			e.preventDefault();
			void pasteClipboard(clipboard!, true);
			return;
		}
		// Let Ctrl/Cmd+V dispatch a native paste event, which also exposes OS
		// files when async clipboard read permission is unavailable.
	}

	// $derived, not const: these are props, so a plain const froze the testid at
	// the initial value if a caller ever toggled variant.
	const rootTestId = $derived(
		compatLibraryTestId ? 'library-modal' : compatSaveTestId ? 'save-modal' : 'file-explorer'
	);
	const renameTip = $derived(selected.size === 1 ? 'Rename' : 'Select one item to rename');
	const deleteTip = $derived(selected.size ? 'Delete' : 'Select an item to delete');
	const cutTip = $derived(selected.size && canCutFiles ? 'Cut' : 'Select an item to cut');
	const copyTip = $derived(selected.size && canCopyFiles ? 'Copy' : 'Select an item to copy');
	const detailsTip = $derived(selected.size ? 'Details' : 'Select an item for details');
	const uploadTip = $derived(uploadBusy ? 'Uploading…' : 'Select file');
	const folderUploadTip = $derived(uploadBusy ? 'Uploading…' : 'Select folder');
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
		clipboard?.ids.length ? clipboard.mode === 'cut' ? 'Paste (move)' : 'Paste (copy)' :
			systemClip?.label ?? 'Paste from clipboard'
	);
</script>

<svelte:window onkeyup={onQuickLookKeyup} onblur={() => quickLookPeek && closeQuickLook()} />
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fe-root {variant} {className}"
	class:preview-bottom={previewDock === 'bottom'}
	class:preview-right={previewDock === 'right'}
	class:is-target={isTarget}
	bind:this={rootEl}
	data-testid={rootTestId}
	data-fe-target={isTarget ? 'true' : 'false'}
	data-fe-backend={driver.id}
	data-fe-mode={mode}
	data-fe-select-multi={selectMulti ? 'on' : 'off'}
	data-fe-preview-dock={previewDock}
	data-fe-tree-dock={treeDock}
	data-fe-view-mode={viewMode}
	data-fe-show-preview={showPreview ? 'on' : 'off'}
	data-fe-compact={compactToolbar ? 'on' : 'off'}
	style="--preview-ratio: {previewRatio * 100}%"
	role={variant === 'dialog' ? 'dialog' : 'group'}
	aria-label="File explorer"
	tabindex="0"
	onkeydown={onListKeydown}
	onclick={(e) => {
		const t = e.target;
		if (
			t instanceof Element &&
			t.closest(
				'[data-testid="fe-toolbar-more-wrap"], [data-testid="fe-view-switcher"], [data-testid="fe-new-menu"], [data-testid="fe-room-chip-wrap"], [data-testid="fe-people-chip-wrap"], [data-testid="fe-people-revoke-dialog"], [data-testid="fe-people-unlink-dialog"]'
			)
		) {
			return;
		}
		if (viewSwitcherOpen) closeViewSwitcher();
		if (toolbarMoreOpen) closeToolbarMore();
		if (newMenuOpen) closeNewMenu();
		if (roomMenuOpen) closeRoomMenu();
		if (peopleSheetOpen) closePeopleSheet();
	}}
>
	<header class="fe-header" data-testid="fe-header">
		<div class="fe-header-left">
			{#if !headerLeading}
				<OpProgressChip windowId={originWindowId} />
			{/if}
			{#if headerLeading}
				<div class="fe-header-leading" data-testid="fe-header-leading">
					{@render headerLeading()}
				</div>
			{/if}
			{#if driver.id !== 'memory'}
				<nav
					class="fe-pathbar"
					class:drop-ready={dropChromeActive}
					data-testid="fe-breadcrumbs"
					aria-label="Current folder"
				>
					<button
						type="button"
						class="fe-crumb"
						class:drop-target={dropChromeActive && dndIntoId === null}
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
						<span class="fe-crumb-item">
							<button
								type="button"
								class="fe-crumb"
								class:drop-target={dropChromeActive && dndIntoId === crumb.id}
								data-testid="fe-crumb"
								data-id={crumb.id}
								data-fe-drop-parent={crumb.id}
								onclick={() => goCrumb(crumb.id)}
								ondragover={(e) => onNavDragOver(e, crumb.id)}
								ondrop={(e) => onNavDrop(e, crumb.id)}
							>
								{crumb.name}
							</button>
							{#if onToggleFolderFavourite && currentFavouriteFolder?.id === crumb.id}
								<FeTipIconBtn
									testid="fe-favourite-folder" icon="star"
									tip={isFolderFavourite?.(crumb.id) ? 'Remove folder from favourites' : 'Add folder to favourites'}
									active={isFolderFavourite?.(crumb.id)}
									pressed={isFolderFavourite?.(crumb.id) ?? false}
									disabled={listBusy}
									onclick={() => onToggleFolderFavourite?.(crumb)}
								/>
							{/if}
						</span>
					{/each}
				</nav>
			{/if}
			{#if isInsideProject || isGitEnabled}
				<div class="fe-folder-badges" data-testid="fe-folder-badges">
					{#if showRoomChip && currentRoom}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="fe-room-chip-wrap"
							data-testid="fe-room-chip-wrap"
							onclick={(e) => e.stopPropagation()}
						>
							<button
								type="button"
								class="fe-room-chip"
								data-testid="fe-room-chip"
								aria-haspopup="menu"
								aria-expanded={roomMenuOpen}
								onclick={toggleRoomMenu}
							>
								{currentRoom.label}
								<span class="fe-room-chip-caret" aria-hidden="true">▾</span>
							</button>
							{#if roomMenuOpen}
								<div
									class="fe-view-popup fe-room-menu"
									data-testid="fe-room-menu"
									role="menu"
									tabindex="-1"
									onclick={(e) => e.stopPropagation()}
								>
									{#each projectRooms as room (room.id)}
										<button
											type="button"
											class="fe-view-option"
											class:active={room.id === currentRoom.id}
											data-testid="fe-room-item"
											data-room-id={room.id}
											role="menuitem"
											aria-current={room.id === currentRoom.id ? 'true' : undefined}
											onclick={() => void chooseRoom(room.id)}
										>
											<span>{room.label}</span>
											{#if room.id === currentRoom.id}
												<span class="fe-view-check" aria-hidden="true">✓</span>
											{/if}
										</button>
									{/each}
									<div class="fe-view-divider"></div>
									{#if onNewRoom}
										{#if newRoomNameOpen}
											<form
												class="fe-room-new-form"
												data-testid="fe-room-new-form"
												onsubmit={(e) => {
													e.preventDefault();
													void submitNewRoom();
												}}
											>
												<input
													class="fe-room-new-input"
													data-testid="fe-room-new-input"
													bind:value={newRoomName}
													placeholder="Room name"
													aria-label="New room name"
												/>
												<button
													type="submit"
													class="ds-btn ds-btn--sm ds-btn--primary"
													data-testid="fe-room-new-create"
												>
													Create
												</button>
											</form>
										{:else}
											<button
												type="button"
												class="fe-view-option"
												data-testid="fe-room-new"
												role="menuitem"
												onclick={() => (newRoomNameOpen = true)}
											>
												<span>New room</span>
											</button>
										{/if}
									{/if}
									{#if onCombineRoom && projectRooms.length > 1}
										<button
											type="button"
											class="fe-view-option"
											data-testid="fe-room-combine"
											role="menuitem"
											disabled={combineBusy}
											onclick={() => (combineOpen = true)}
										>
											<span>Combine with…</span>
										</button>
										{#if combineBusy}
											<p class="fe-room-note" data-testid="fe-room-combine-busy">
												You can combine rooms when nobody is editing.
											</p>
										{/if}
									{/if}
								</div>
							{/if}
						</span>
					{/if}
					{#if showPeopleChip}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="fe-people-chip-wrap"
							data-testid="fe-people-chip-wrap"
							onclick={(e) => e.stopPropagation()}
						>
							<button
								type="button"
								class="fe-people-chip"
								data-testid="fe-people-chip"
								aria-haspopup="dialog"
								aria-expanded={peopleSheetOpen}
								onclick={togglePeopleSheet}
							>
								{#each peopleHere as person (person.pairingId)}
									<span
										class="fe-people-chip-dot"
										style:background={person.color ?? 'var(--accent, #38bdf8)'}
										aria-hidden="true"
									></span>
								{/each}
								{peopleChipText()}
								<span class="fe-room-chip-caret" aria-hidden="true">▾</span>
							</button>
							{#if peopleSheetOpen}
								<div
									class="fe-view-popup fe-people-sheet"
									data-testid="fe-people-sheet"
									role="dialog"
									aria-label="People"
									tabindex="-1"
									onclick={(e) => e.stopPropagation()}
								>
									{#each people ?? [] as person (person.pairingId)}
										<div class="fe-people-row" data-testid="fe-people-row" data-pairing-id={person.pairingId}>
											<label class="fe-people-name">
												<span class="fe-people-name-label">Name</span>
												<input
													class="fe-people-rename"
													data-testid="fe-people-rename"
													value={peopleRenameDrafts[person.pairingId] ?? person.label}
													aria-label="Nickname"
													onchange={(e) => {
														const value = e.currentTarget.value;
														peopleRenameDrafts = {
															...peopleRenameDrafts,
															[person.pairingId]: value
														};
														void commitPersonLabel(person.pairingId, value);
													}}
												/>
											</label>
											<p class="fe-people-now" data-testid="fe-people-now">
												{personNowLabel(person)}
											</p>
											<p class="fe-people-session" data-testid="fe-people-session">
												This session · {personSessionLabel(person)}
											</p>
											<p class="fe-people-later" data-testid="fe-people-later">
												Later · {person.linked ? 'Linked' : 'Session only'}
											</p>
											<div class="fe-people-row-actions">
												{#if person.canRevoke}
													<button
														type="button"
														class="ds-btn ds-btn--sm ds-btn--ghost"
														data-testid="fe-people-revoke"
														onclick={() => (revokeTarget = person)}
													>
														Revoke edit
													</button>
												{/if}
												{#if person.linked}
													<button
														type="button"
														class="ds-btn ds-btn--sm ds-btn--ghost"
														data-testid="fe-people-unlink"
														onclick={() => (unlinkTarget = person)}
													>
														Unlink…
													</button>
												{/if}
											</div>
											{#if onArrivalPolicy && person.linked}
												<label class="fe-people-arrival" data-testid="fe-people-arrival">
													<span class="fe-people-name-label">When their work arrives</span>
													<select
														class="fe-people-arrival-select"
														data-testid="fe-people-arrival-select"
														value={person.onArrival ?? 'inspect'}
														onchange={(e) =>
															void onArrivalPolicy?.({
																pairingId: person.pairingId,
																policy: e.currentTarget.value as ExplorerArrivalPolicy
															})}
													>
														<option value="auto">Merge it for me</option>
														<option value="inspect">Tell me, I'll look</option>
														<option value="later">Just keep it</option>
													</select>
												</label>
											{/if}
											{#if onKeepRoom && person.rooms?.length}
												<div class="fe-people-rooms" data-testid="fe-people-rooms">
													<span class="fe-people-name-label">Keep locally</span>
													{#each person.rooms as room (room.roomId)}
														<label class="fe-people-room" data-testid="fe-people-room">
															<input
																type="checkbox"
																data-testid="fe-people-room-keep"
																data-room-id={room.roomId}
																checked={room.kept}
																disabled={room.locked}
																onchange={(e) =>
																	void onKeepRoom?.({
																		pairingId: person.pairingId,
																		roomId: room.roomId,
																		keep: e.currentTarget.checked
																	})}
															/>
															<span>{room.label}</span>
														</label>
													{/each}
												</div>
											{/if}
										</div>
									{/each}
									{#if onInvitePeople}
										<button
											type="button"
											class="fe-view-option"
											data-testid="fe-people-invite"
											onclick={() => {
												closePeopleSheet();
												onInvitePeople();
											}}
										>
											<span>Invite</span>
										</button>
									{/if}
								</div>
							{/if}
						</span>
					{/if}
					{#if isInsideProject}
						<span class="fe-inside-project-badge" data-testid="fe-inside-project-badge">
							Inside Project
						</span>
						{#if onProjectMap && projectRootId}
							<button
								type="button"
								class="fe-folder-action"
								data-testid="fe-project-map"
								onclick={() => onProjectMap?.(projectRootId)}
							>
								Dependency map
							</button>
						{/if}
						{#if canProjectStorage}
							<button
								type="button"
								class="fe-folder-action"
								data-testid="fe-project-storage"
								onclick={() => (projectStorageOpen = true)}
							>
								Project storage
							</button>
							<button
								type="button"
								class="fe-folder-action"
								data-testid="fe-project-integrity"
								onclick={() => (projectIntegrityOpen = true)}
							>
								Check project integrity
							</button>
						{/if}
					{/if}
					{#if isGitEnabled}
						{#if onGitEnabled}
							<button
								type="button"
								class="fe-git-enabled-badge"
								data-testid="fe-git-enabled-badge"
								onclick={() => onGitEnabled?.(gitRootId)}
							>
								Git enabled
							</button>
						{:else}
							<span class="fe-git-enabled-badge" data-testid="fe-git-enabled-badge">
								Git enabled
							</span>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
		{#if moveDragActive}
			<div class="fe-move-banner" data-testid="fe-move-banner" role="status" aria-live="polite">
				{moveDragLabel}
			</div>
		{/if}

		{#snippet actionBtn(
			kind: 'icon' | 'menu',
			testid: string,
			tip: string,
			icon: FeIconName,
			onclick: () => void,
			opts: {
				disabled?: boolean;
				active?: boolean;
				pressed?: boolean;
				haspopup?: boolean;
				label?: string;
			} = {}
		)}
			{#if kind === 'icon'}
				<FeTipIconBtn
					{testid}
					{tip}
					{icon}
					disabled={opts.disabled ?? false}
					active={opts.active ?? false}
					pressed={opts.pressed}
					haspopup={opts.haspopup ?? false}
					{onclick}
				/>
			{:else}
				<button
					type="button"
					class="fe-view-option"
					class:active={opts.active}
					data-testid={testid}
					disabled={opts.disabled ?? false}
					aria-pressed={opts.pressed}
					onclick={() => {
						closeToolbarMore();
						onclick();
					}}
				>
					<FeIcon name={icon} size={16} />
					<span>{opts.label ?? tip}</span>
					{#if opts.active}
						<span class="fe-view-check">✓</span>
					{/if}
				</button>
			{/if}
		{/snippet}

		{#snippet toolbarActions(kind: 'icon' | 'menu')}
			{#if showStorageBtn}
				{@render actionBtn(kind, 'fe-storage-open', 'Storage map and integrity check', 'storage-map', () => (storageDialogOpen = true), { label: 'Storage' })}
			{/if}
			{#if showNewMenu}
				{#if kind === 'icon'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						class="fe-view-switcher-wrap"
						data-testid="fe-new-menu"
						onclick={(e) => e.stopPropagation()}
					>
						<FeTipIconBtn
							testid="fe-new-menu-btn"
							tip="New"
							icon="plus"
							active={newMenuOpen}
							pressed={newMenuOpen}
							haspopup
							onclick={toggleNewMenu}
						/>
						{#if newMenuOpen}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="fe-view-popup fe-new-menu-popup"
								data-testid="fe-new-menu-popup"
								role="menu"
								tabindex="-1"
								onclick={(e) => e.stopPropagation()}
							>
								{#if onNewProject}
									<button
										type="button"
										class="fe-view-option"
										data-testid="fe-new-project"
										role="menuitem"
										onclick={chooseNewProject}
									>
										<FeIcon name="folder-plus" size={16} />
										<span>New project</span>
									</button>
								{/if}
								{#each newMenuItems as item (item.id)}
									<button
										type="button"
										class="fe-view-option"
										data-testid={item.testId ?? `fe-new-${item.id}`}
										role="menuitem"
										onclick={() => chooseNewMenuItem(item.id)}
									>
										<FeIcon name={item.icon} size={16} />
										<span>{item.label}</span>
									</button>
								{/each}
							</div>
						{/if}
					</span>
				{:else}
					{#if onNewProject}
						{@render actionBtn(kind, 'fe-new-project', 'New project', 'folder-plus', chooseNewProject, {
							label: 'New project'
						})}
					{/if}
					{#each newMenuItems as item (item.id)}
						{@render actionBtn(
							kind,
							item.testId ?? `fe-new-${item.id}`,
							item.label,
							item.icon,
							() => chooseNewMenuItem(item.id),
							{ label: item.label }
						)}
					{/each}
				{/if}
			{/if}
			{#if mode === 'manage' || mode === 'open'}
				{@render actionBtn(kind, 'fe-select-multi', 'Select multiple items', 'check-square', () => setSelectMulti(!selectMulti), {
					active: selectMulti,
					pressed: selectMulti,
					label: 'Select multiple'
				})}
				{@render actionBtn(kind, 'fe-item-details', detailsTip, 'info', () => openSelectedDetails(), {
					disabled: selected.size === 0,
					label: 'Details'
				})}
				{#if driver.id !== 'memory'}
					{@render actionBtn(kind, 'fe-tree-dock', treeTip, 'panel-left', cycleTreeDock, {
						active: treeDock !== 'off',
						pressed: treeDock !== 'off',
						label: 'Folder tree'
					})}
				{/if}
				{@render actionBtn(kind, 'fe-preview-layout', previewTip, 'layout', cyclePreviewDock, {
					active: previewDock !== 'off',
					pressed: previewDock !== 'off',
					label: 'Preview'
				})}
			{/if}
			{#if canOpenSelection}
				{@render actionBtn(kind, 'fe-open-selected', 'Open', 'folder-open', () => void openSelected())}
			{/if}
			{#if mode === 'manage'}
				{#if caps.supportsMkdir}
					{@render actionBtn(kind, 'fe-new-folder', 'New folder', 'folder-plus', () => (newFolderOpen = true))}
				{/if}
				{#if showDeviceFilePicker}
					{@render actionBtn(kind, 'fe-upload', uploadTip, 'upload', () => fileInputEl?.click(), {
						disabled: uploadBusy,
						label: 'Upload file'
					})}
					{@render actionBtn(kind, 'fe-folder-upload', folderUploadTip, 'folder-up', () => folderInputEl?.click(), {
						disabled: uploadBusy,
						label: 'Upload folder'
					})}
				{/if}
				{#if caps.supportsTrash && !hideToolbarTrash}
					{@render actionBtn(kind, 'fe-trash-view', 'Open trash', 'archive', () => void toggleTrashPopup(), {
						active: trashOpen,
						pressed: trashOpen,
						haspopup: true
					})}
				{/if}
				{@render actionBtn(kind, 'fe-hidden-files', hiddenFilesTip, 'eye', () => setShowHidden(!showHidden), {
					active: showHidden,
					pressed: showHidden,
					label: 'System files'
				})}
				{#if supportsDownload}
					{@render actionBtn(kind, 'fe-download-selected', 'Download selected to PC', 'download', () => void downloadSelected(), {
						disabled: downloadBusy || !canDownloadSelection,
						label: 'Download'
					})}
				{/if}
				{#if toolbarExtra}
					{@render toolbarExtra({ variant: kind === 'menu' ? 'menu' : 'icon' })}
				{/if}
				{#if canImportFromDevice || caps.supportsMove || caps.supportsCopy || onCopyAcrossFromClipboard}
					{@render actionBtn(kind, 'fe-paste', pasteTip, 'clipboard-paste', () => void pasteClipboard(), {
						label: 'Paste', disabled: !canPasteFiles || pasteBusy || uploadBusy,
						active: Boolean(clipboard?.ids.length || systemClip?.files.length)
					})}
				{/if}
			{/if}
		{/snippet}

		{#snippet selectionActions(kind: 'icon' | 'menu')}
			{@render actionBtn(kind, 'fe-rename-btn', renameTip, 'pencil', renameSelectedItem, {
				disabled: listBusy || selected.size !== 1 || !caps.supportsRename,
				label: 'Rename'
			})}
			{@render actionBtn(kind, 'fe-trash-selected', deleteTip, 'trash', trashSelected, {
				disabled: selected.size === 0,
				label: 'Delete'
			})}
			{@render actionBtn(kind, 'fe-cut', cutTip, 'scissors', cutSelection, {
				disabled: selected.size === 0 || !canCutFiles,
				label: 'Cut'
			})}
			{@render actionBtn(kind, 'fe-copy', copyTip, 'copy', copySelection, {
				disabled: selected.size === 0 || !canCopyFiles,
				label: 'Copy'
			})}
			{@render actionBtn(kind, 'fe-compress-selected', 'Compress', 'file-archive', () => startArchive('compress', selectedEntries), {
				disabled: selected.size === 0
			})}
			{@render actionBtn(kind, 'fe-encrypt-selected', 'Encrypt', 'lock', () => startArchive('encrypt', selectedEntries), {
				disabled: selected.size === 0
			})}
			{@render actionBtn(kind, 'fe-decompress-selected', 'Decompress', 'package-open', () => startArchive('decompress', selectedEntries), {
				disabled: !canDecompressSelection
			})}
			{@render actionBtn(kind, 'fe-decrypt-selected', 'Decrypt', 'unlock', () => startArchive('decrypt', selectedEntries), {
				disabled: !canDecryptSelection
			})}
		{/snippet}

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
								<button type="button" class="fe-view-option" class:active={viewMode === 'detailed'} data-testid="fe-view-detailed" onclick={() => setViewMode('detailed')}>
									<FeIcon name="table" size={16} />
									<span>Detailed</span>
								</button>
								<button type="button" class="fe-view-option" class:active={viewMode === 'icons'} data-testid="fe-view-icons" onclick={() => setViewMode('icons')}>
									<FeIcon name="layout-grid" size={16} />
									<span>Icons</span>
								</button>
								<div class="fe-view-divider"></div>
								<button type="button" class="fe-view-option fe-view-checkbox" class:active={showPreview} data-testid="fe-view-show-preview" onclick={toggleShowPreview}>
									<FeIcon name="eye" size={16} />
									<span>Show preview</span>
									<span class="fe-view-check">{showPreview ? '✓' : ''}</span>
								</button>
								<button
									type="button"
									class="fe-view-option fe-view-checkbox"
									class:active={folderStacks}
									data-testid="fe-view-folder-stacks"
									onclick={() => setFolderStacks(!folderStacks)}
								>
									<FeIcon name="copy" size={16} />
									<span>Folder stacks</span>
									<span class="fe-view-check">{folderStacks ? '✓' : ''}</span>
								</button>
								<div class="fe-view-divider"></div>
								<label class="fe-view-slider" data-testid="fe-icon-size-slider-wrap">
									<span class="fe-view-slider-label">Thumbnail size</span>
									<input
										type="range"
										min={ICON_SIZE_MIN}
										max={ICON_SIZE_MAX}
										step={4}
										value={iconSize}
										oninput={(e) => setIconSize(Number(e.currentTarget.value))}
										data-testid="fe-icon-size-slider"
										aria-label="Thumbnail size"
									/>
								</label>
								<div class="fe-view-divider"></div>
								<button type="button" class="fe-view-option fe-view-checkbox" class:active={foldersFirst} data-testid="fe-view-folders-first" onclick={() => setFoldersFirst(!foldersFirst)}>
									<FeIcon name="folder" size={16} />
									<span>Folders first</span>
									<span class="fe-view-check">{foldersFirst ? '✓' : ''}</span>
								</button>
								{#if viewMode !== 'detailed'}
									<div class="fe-view-subhead">Sort by</div>
									{#each SORT_TOOLS as c (c)}
										<button
											type="button"
											class="fe-view-option fe-view-checkbox"
											class:active={activeSort?.col === c}
											data-testid={`fe-view-sort-${c}`}
											onclick={() => toggleSort(c)}
										>
											<span>{DETAIL_COL_META[c].label}</span>
											<span class="fe-view-check">{activeSort?.col === c ? (activeSort.dir === 'asc' ? '↑' : '↓') : ''}</span>
										</button>
									{/each}
									<button
										type="button"
										class="fe-view-option"
										data-testid="fe-sort-dir"
										aria-label="Reverse sort direction"
										disabled={!activeSort}
										onclick={flipSortDir}
									>
										<FeIcon name="arrow-left-right" size={16} />
										<span>Reverse order</span>
									</button>
									<button
										type="button"
										class="fe-view-option"
										data-testid="fe-view-clear-sort"
										disabled={!activeSort}
										onclick={clearSort}
									>
										<FeIcon name="x" size={16} />
										<span>Clear sort</span>
									</button>
								{/if}
								{#if viewMode === 'detailed'}
									<div class="fe-view-divider"></div>
									<div class="fe-view-subhead">Columns</div>
									{#each detailColOrder as c (c)}
										<div class="fe-col-row">
											<button type="button" class="fe-view-option fe-view-checkbox" class:active={!hiddenCols.includes(c)} data-testid={`fe-col-toggle-${c}`} onclick={() => toggleDetailCol(c)}>
												<FeIcon name="eye" size={16} />
												<span>{DETAIL_COL_META[c].label}</span>
												<span class="fe-view-check">{hiddenCols.includes(c) ? '' : '✓'}</span>
											</button>
											<span class="fe-col-order">
												<button type="button" class="fe-col-order-btn" data-testid={`fe-col-up-${c}`} aria-label={`Move ${DETAIL_COL_META[c].label} earlier`} onclick={() => moveDetailCol(c, -1)} disabled={c === detailColOrder[0]}>
													↑
												</button>
												<button type="button" class="fe-col-order-btn" data-testid={`fe-col-down-${c}`} aria-label={`Move ${DETAIL_COL_META[c].label} later`} onclick={() => moveDetailCol(c, 1)} disabled={c === detailColOrder[detailColOrder.length - 1]}>
													↓
												</button>
											</span>
										</div>
									{/each}
									<p class="fe-view-note">File name always comes first.</p>
								{/if}
							</div>
						{/if}
					</span>
				{/if}
				{#if mode === 'manage' || mode === 'open'}
					{#if activeSort}
						<span class="fe-sort-chip" data-testid="fe-sort-chip">
							<FeIcon name="table" size={12} />
							<span class="fe-sort-chip-label">
								Sorted by {DETAIL_COL_META[activeSort.col].label}
							</span>
							<button type="button" class="fe-sort-clear" data-testid="fe-sort-clear" aria-label="Clear sort" onclick={clearSort}>
								<FeIcon name="x" size={12} />
							</button>
						</span>
					{/if}
				{/if}
				{#if compactToolbar}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						class="fe-toolbar-more-wrap"
						data-testid="fe-toolbar-more-wrap"
						onclick={(e) => e.stopPropagation()}
						onpointerdown={(e) => e.stopPropagation()}
					>
						<FeTipIconBtn
							testid="fe-toolbar-more"
							tip="File actions"
							icon="ellipsis"
							active={toolbarMoreOpen}
							pressed={toolbarMoreOpen}
							haspopup
							onclick={toggleToolbarMore}
						/>
						{#if toolbarMoreOpen}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="fe-toolbar-more-popup"
								data-testid="fe-toolbar-more-popup"
								role="menu"
								tabindex="-1"
								aria-label="File actions"
								onclick={(e) => e.stopPropagation()}
							>
								{@render toolbarActions('menu')}
								{#if mode === 'manage'}
									<div class="fe-view-divider"></div>
									{@render selectionActions('menu')}
								{/if}
							</div>
						{/if}
					</span>
				{:else}
					{@render toolbarActions('icon')}
				{/if}
				{#if onClose}
					<FeTipIconBtn testid="fe-close" tip="Close" icon="x" onclick={onClose} />
				{/if}
				{#if showPersistChip && localVfs}
					<StoragePersistenceStatus vfs={localVfs} compact class="fe-persist-slot" />
				{/if}
			</div>
			{#if mode === 'manage' && !compactToolbar}
				<div
					class="fe-toolbar-row fe-selection-actions"
					data-testid="fe-selection-actions"
					aria-label="Selection actions"
				>
					{@render selectionActions('icon')}
				</div>
			{/if}
			{#if mode === 'manage' && showDeviceFilePicker}
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
						void importDeviceFiles(Array.from(list), parentId, true).finally(() => {
							el.value = '';
						});
					}}
				/>
				<input
					bind:this={folderInputEl}
					type="file"
					multiple
					hidden
					data-testid="fe-folder-upload-input"
					// Folder picker: each File carries webkitRelativePath, so the
					// import recreates the tree exactly like a dragged-in folder.
					{...({ webkitdirectory: '' } as Record<string, string>)}
					onchange={(e) => {
						const list = (e.currentTarget as HTMLInputElement).files;
						if (!list?.length) return;
						const el = e.currentTarget;
						void importDeviceFiles(Array.from(list), parentId, true).finally(() => {
							el.value = '';
						});
					}}
				/>
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
				{showHidden}
				onNavigate={goCrumb}
				dropActive={dropChromeActive}
				dropTargetId={dndIntoId}
				onDragOverInto={hoverNavParent}
				onDropInto={moveDragActive ? (id) => void commitMoveInto(id) : undefined}
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
	<div class="fe-list-col" style:--fe-detail-tracks="{detailTracks}">
		{#if viewMode === 'detailed' && detailCols.length > 0}
			<div class="fe-list-head" data-testid="fe-list-head">
				<div class="fe-list-head-row">
					<button
						type="button"
						class="fe-head-cell fe-head-name"
						data-testid="fe-head-name"
						aria-label="Sort by file name"
						onclick={() => toggleSort('name')}
					>
						<span class="fe-head-label">File name</span>
						<span class="fe-head-arrow" aria-hidden="true">
							{#if activeSort?.col === 'name'}{activeSort.dir === 'asc' ? '↑' : '↓'}{/if}
						</span>
					</button>
					{#each detailCols as c (c)}
						<button
							type="button"
							class="fe-head-cell fe-row-col fe-col-head-{c}"
							data-testid={`fe-head-${c}`}
							aria-label={`Sort by ${DETAIL_COL_META[c].label.toLowerCase()}`}
							onclick={() => toggleSort(c)}
						>
							<span class="fe-head-label">{DETAIL_COL_META[c].label}</span>
							<span class="fe-head-arrow" aria-hidden="true">
								{#if activeSort?.col === c}{activeSort.dir === 'asc' ? '↑' : '↓'}{/if}
							</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}
		<div
		class="fe-list"
		style:--fe-icon-size="{iconSize}px"
		style:--fe-row-icon-px="{rowIconPx}px"
		data-fe-icon-size={iconSize}
		class:fe-list-icons={viewMode === 'icons'}
		class:fe-list-detailed={viewMode === 'detailed'}
		tabindex="0"
		class:fe-list-busy={listBusy}
		class:fe-list-covered={showBusyOverlay}
		class:fe-list-pointer-dnd={pointerDragActive}
		data-testid="fe-list"
		role="listbox"
		aria-busy={listBusy ? 'true' : undefined}
		class:os-drop={osDropOver || copyHoverActive}
		onpointerdown={onListPointerDown}
		bind:this={listEl}
		ondragover={onListDragOver}
		ondragleave={onListDragLeave}
		ondrop={onListDrop}
	>
		{#snippet pendingChrome(p: ListingPending, onIcon: boolean = false)}
			{@const behindPct = pendingPercent(p)}
			{@const aheadN = p.ready ?? p.transferred}
			{@const rowDone = p.done || p.status === 'done'}
			{@const aheadPct = Math.min(
				rowDone ? 100 : 99,
				Math.round(p.size ? (aheadN / p.size) * 100 : behindPct)
			)}
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
			<span class="fe-pending-pct" class:on-icon={onIcon}>{pendingLabel(p)}{p.owner ? ` · ${ownerLabel(p.owner, ownerCtx)}` : ''}</span>
		{/snippet}
		{#if initialLoad && nodes.length === 0 && listingRows.length === 0}
			<div class="fe-empty" data-testid="fe-loading">Loading…</div>
		{:else if listingRows.length === 0}
			<div class="fe-empty" data-testid="fe-empty">
				No files here
			</div>
		{:else}
			{#each sortedRows as row (row.key)}
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
				{@const rasterThumb = hasRasterThumbnail(previewKind)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="fe-row"
					class:folder={n.kind === 'folder'}
					class:file={n.kind === 'file'}
					class:incompatible={!actionable && n.kind === 'file'}
					class:selected={!row.placeholder && selected.has(n.id)}
					class:previewed={!row.placeholder && previewEntry?.id === n.id}
					class:focused={!row.placeholder && focusPosById.get(n.id) === focusIndex}
					class:fe-dnd-into={showInto}
					class:fe-dnd-dragging={!row.placeholder && dndDraggingIds.has(n.id)}
					class:fe-cut-pending={!row.placeholder && clipboard?.mode === 'cut' &&
						sameClipboardSource(clipboard, driver) && clipboard.ids.includes(n.id)}
					class:fe-row-icon={viewMode === 'icons'}
					class:fe-row-detailed={viewMode === 'detailed'}
					class:renaming={!row.placeholder && renamingId === n.id}
					class:fe-pending={Boolean(p)}
					data-testid={row.placeholder && n.kind !== 'folder'
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
					data-fe-folder-mark={entryMark(n)}
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
						if (pointerDragActive || longPressTimer) { e.preventDefault(); return; }
						if (row.placeholder || n.kind !== 'folder' || !onToggleFolderFavourite || listBusy) return;
						e.preventDefault();
						favouriteMenu = { entry: n, x: Math.max(0, Math.min(e.clientX, window.innerWidth - 240)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - 48)) };
					}}
					onclick={row.placeholder || i < 0 ? undefined : (e) => onRowClick(e, n, i)}
					ondblclick={row.placeholder || i < 0 ? undefined : (e) => onRowDblClick(e, n, i)}
				>
					{#if viewMode === 'icons'}
						<span class="fe-row-icon-thumb">
							{#if !row.placeholder && n.kind === 'folder' && folderStacks && folderStacksOk}
								<FeFolderStack
									entry={n}
									{driver}
									enabled={showPreview}
									fallbackSize={Math.round(iconSize * 0.5)}
									maxDim={Math.max(32, Math.min(128, Math.round(iconSize * 0.5)))}
								/>
							{:else if rasterThumb}
								<FeThumbnail entry={n} {driver} maxDim={thumbFetchDim} enabled={showPreview} />
							{:else if n.kind === 'file' && !hasRasterThumbnail(getPreviewKind(n))}
								<span class="fe-row-icon-fallback">
									<FeTypeMark
										entry={n}
										iconSize={Math.min(72, Math.max(18, Math.round(iconSize * 0.36)))}
										labelSize={Math.min(15, Math.max(10, Math.round(iconSize * 0.13)))}
									/>
								</span>
							{:else}
								<span class="fe-row-icon-fallback">
									<FeIcon name={entryIcon(n)} class={entryMarkClass(n)} size={Math.round(iconSize * 0.5)} />
								</span>
							{/if}
							{#if p}
								{@render pendingChrome(p, true)}
							{/if}
						</span>
						<span class="fe-row-icon-name" title={n.name}>{#if renamingId === n.id}{@render renameEditor(n)}{:else}{n.name}{/if}</span>
						{#if n.kind === 'file'}{@render presenceDots(n.id)}{/if}
					{:else if viewMode === 'detailed'}
						<span class="fe-row-main">
							<span class="fe-icon">
								{#if rasterThumb}
									<FeThumbnail entry={n} {driver} maxDim={rowThumbDim} enabled={showPreview} />
								{:else}
									<FeIcon
										name={n.kind === 'folder' ? entryIcon(n) : fileTypeIcon(n)}
										class={entryMarkClass(n)}
										size={rowIconPx}
									/>
								{/if}
							</span>
							{#if renamingId === n.id}
								{@render renameEditor(n)}
							{:else}
								<span class="fe-name" title={!actionable && n.kind === 'file' ? 'Wrong type for this app' : n.name}
									>{n.name}</span
								>
								{#if n.kind === 'file'}{@render presenceDots(n.id)}{/if}
							{/if}
						</span>
						{#each detailCols as c (c)}
							<span class="fe-row-col" class:fe-row-size={c === 'size'} class:fe-row-type={c === 'type'} class:fe-row-modified={c === 'modified'}>
								{#if c === 'size'}
									{n.size != null ? formatBytes(n.size) : '—'}
								{:else if c === 'type'}
									{n.fileType ?? (n.kind === 'folder' ? 'Folder' : 'File')}
								{:else}
									{n.updatedAt ? formatWhen(n.updatedAt) : '—'}
								{/if}
							</span>
						{/each}
					{:else}
						<span class="fe-row-main">
							<span class="fe-icon">
								{#if rasterThumb}
									<FeThumbnail entry={n} {driver} maxDim={rowThumbDim} enabled={showPreview} />
								{:else}
									<FeIcon
										name={n.kind === 'folder' ? entryIcon(n) : fileTypeIcon(n)}
										class={entryMarkClass(n)}
										size={rowIconPx}
									/>
								{/if}
							</span>
							{#if renamingId === n.id}
								{@render renameEditor(n)}
							{:else}
								<span class="fe-name" title={!actionable && n.kind === 'file' ? 'Wrong type for this app' : n.name}
									>{n.name}</span
								>
								{#if packedRows.get(n.id)?.packed}
									<span
										class="fe-pack-badge"
										data-testid="fe-pack-badge"
										title="Stored in a shared pack — its space is reclaimed when every file in that pack is deleted"
										aria-label="in a shared pack">pack</span
									>
								{/if}
								{#if n.kind === 'file'}{@render presenceDots(n.id)}{/if}
							{/if}
						</span>
					{/if}
					{#if p && viewMode !== 'icons'}
						{@render pendingChrome(p, false)}
					{/if}
				</div>
			{/each}
			{#if marquee}
				{@const ml = Math.min(marquee.x0, marquee.x1)}
				{@const mt = Math.min(marquee.y0, marquee.y1)}
				<div
					class="fe-marquee"
					data-testid="fe-marquee"
					style:left="{ml}px"
					style:top="{mt}px"
					style:width="{Math.abs(marquee.x1 - marquee.x0)}px"
					style:height="{Math.abs(marquee.y1 - marquee.y0)}px"
					aria-hidden="true"
				></div>
			{/if}
			{#if dndEnabled && canReorder && dndLine && (dndZone === 'before' || dndZone === 'after')}
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
	</div>
	{#if previewDock !== 'off'}
		<SplitHandle
			axis={previewDock === 'right' ? 'x' : 'y'}
			testid="fe-preview-split"
			ariaLabel="Resize preview pane"
			onRatioDelta={onPreviewRatioDelta}
		/>
		<aside
			class="fe-preview-dock filled"
			data-testid="fe-preview-dock"
			data-placement={previewDock}
			data-multi={selected.size > 1 ? 'true' : undefined}
			data-preview-subject={selected.size === 0 ? 'open-folder' : 'selection'}
			aria-label="File preview"
		>
			{#if selected.size > 1}
				<FeFloatingPreview
					variant="dock"
					entry={selectedEntries[0]!}
					entries={selectedEntries}
					{driver}
					{mediaMeta}
					loadMedia={false}
					infoLine=""
					sizeText={selectionSizeLabel(selectedEntries)}
					showClose={false}
					onClose={() => (previewEntry = null)}
					actions={previewActionBar}
				/>
			{:else if dockedPreviewEntry()}
				{@const single = dockedPreviewEntry()!}
				<FeFloatingPreview
					variant="dock"
					entry={single}
					listParentId={selected.size === 0 ? parentId : undefined}
					{driver}
					{mediaMeta}
					loadMedia={explorerThumbsAreEager(driver) || previewMediaId === single.id}
					onRequestMedia={() => requestPreviewMedia(single.id)}
					infoLine={previewInfoLine(single)}
					projectState={single.kind === 'folder' && single.id !== OPEN_ROOT_PREVIEW_ID ? previewIsProject : null}
					showClose={false}
					onClose={() => (previewEntry = null)}
					actions={selected.size === 0 ? undefined : previewActionBar}
				/>
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
		<FeFloatingPreview
			variant="popup"
			entry={selected.size > 1 ? selectedEntries[0]! : previewEntry}
			entries={selected.size > 1 ? selectedEntries : []}
			{driver}
			{mediaMeta}
			loadMedia={true}
			infoLine={selected.size > 1 ? '' : previewInfoLine(previewEntry)}
			sizeText={selected.size > 1 ? selectionSizeLabel(selectedEntries) : ''}
			projectState={previewEntry.kind === 'folder' ? previewIsProject : null}
			onClose={() => {
				actionsMenuOpen = false;
				previewEntry = null;
			}}
			actions={previewActionBar}
		/>
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

	{#if revokeTarget}
		<div
			class="fe-room-switch-root"
			use:portalModal
			data-testid="fe-people-revoke-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fe-people-revoke-title"
		>
			<button
				type="button"
				class="fe-room-switch-scrim"
				aria-label="Cancel"
				onclick={() => (revokeTarget = null)}
			></button>
			<div class="fe-room-switch-card">
				<h2 id="fe-people-revoke-title" data-testid="fe-people-revoke-title">
					{revokeTarget.label} can still send work later unless you unlink. This only affects the current
					session.
				</h2>
				<div class="fe-room-switch-actions">
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-people-revoke-cancel"
						onclick={() => (revokeTarget = null)}
					>
						Cancel
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-people-revoke-unlink"
						onclick={revokeToUnlink}
					>
						Unlink…
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--primary"
						data-testid="fe-people-revoke-confirm"
						onclick={() => void confirmRevokeEdit()}
					>
						Revoke edit
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if unlinkTarget}
		<div
			class="fe-room-switch-root"
			use:portalModal
			data-testid="fe-people-unlink-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fe-people-unlink-title"
		>
			<button
				type="button"
				class="fe-room-switch-scrim"
				aria-label="Cancel"
				onclick={() => (unlinkTarget = null)}
			></button>
			<div class="fe-room-switch-card">
				<h2 id="fe-people-unlink-title" data-testid="fe-people-unlink-title">
					Unlink {unlinkTarget.label}?
				</h2>
				<p data-testid="fe-people-unlink-body">
					Stops future work from them. Work already in this project stays. Keeping their work
					first takes their last save — if they are still editing, what is on their screen is
					not saved yet and will not come across.
				</p>
				<div class="fe-room-switch-actions">
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-people-unlink-cancel"
						onclick={() => (unlinkTarget = null)}
					>
						Cancel
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-people-unlink-sync"
						disabled={unlinkTarget.now.kind === 'offline'}
						title={unlinkTarget.now.kind === 'offline'
							? 'They are not connected, so there is nothing to keep'
							: undefined}
						onclick={() => void confirmUnlink('sync')}
					>
						Keep their work, then unlink
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--primary"
						data-testid="fe-people-unlink-without"
						onclick={() => void confirmUnlink('without')}
					>
						Unlink without sync
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if splitBrain}
		<div
			class="fe-room-switch-root"
			use:portalModal
			data-testid="fe-split-brain"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fe-split-brain-title"
		>
			<div class="fe-room-switch-card">
				<h2 id="fe-split-brain-title" data-testid="fe-split-brain-title">
					Another group is already editing {splitBrain.roomLabel}.
				</h2>
				<p class="fe-room-note">
					Joining them would mix two live sessions. Your work is safe either way — nothing
					has been combined.
				</p>
				<div class="fe-room-switch-actions">
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-split-brain-cancel"
						onclick={() => void onSplitBrainChoice?.('cancel')}
					>
						Don’t connect
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-split-brain-new-room"
						onclick={() => void onSplitBrainChoice?.('new-room')}
					>
						New room from my work
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--primary"
						data-testid="fe-split-brain-wait"
						onclick={() => void onSplitBrainChoice?.('wait')}
					>
						Wait until they’re done
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if combineOpen}
		<div
			class="fe-room-switch-root"
			use:portalModal
			data-testid="fe-room-combine-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fe-room-combine-title"
		>
			<button
				type="button"
				class="fe-room-switch-scrim"
				aria-label="Cancel"
				onclick={() => {
					combineOpen = false;
					combineConflict = null;
					combinePending = null;
				}}
			></button>
			<div class="fe-room-switch-card">
				<h2 id="fe-room-combine-title" data-testid="fe-room-combine-title">
					Combine into {currentRoom?.label ?? 'this room'}?
				</h2>
				{#if combineConflict}
					<p class="fe-room-note" data-testid="fe-room-combine-conflict">
						{currentRoom?.label ?? 'This room'} and {combineConflict.label} couldn’t combine.
						Both rooms are as they were.
					</p>
					<ul class="fe-room-conflict-list">
						{#each combineConflict.paths as path (path)}
							<li data-testid="fe-room-combine-conflict-path">
								<span>{path}{#if combineConflict.reasons?.[path]} · {combineConflict.reasons[path]}{/if}</span>
								{#if onReviewConflict && projectRootId}
									<button
										type="button"
										class="ds-btn ds-btn--sm ds-btn--ghost"
										data-testid="fe-room-combine-review"
										data-path={path}
										onclick={() =>
											void onReviewConflict?.({
												rootId: projectRootId!,
												fromRoomId: combineConflict!.roomId,
												path
											})}
									>
										Review
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{:else if combineMissing}
					<p class="fe-room-note" data-testid="fe-room-combine-missing">
						Their work hasn’t reached this device yet.
					</p>
				{:else if combinePending}
					<p class="fe-room-note" data-testid="fe-room-combine-dirty">
						You have unsaved work here. Save it first?
					</p>
					<div class="fe-room-switch-actions">
						<button
							type="button"
							class="ds-btn ds-btn--sm ds-btn--ghost"
							onclick={() => (combinePending = null)}
						>
							Cancel
						</button>
						<button
							type="button"
							class="ds-btn ds-btn--sm ds-btn--primary"
							data-testid="fe-room-combine-save"
							onclick={() => void runCombine(combinePending!, true)}
						>
							Save and combine
						</button>
					</div>
				{:else}
					<p class="fe-room-note">
						This keeps the other room’s history in the project. If anything can’t combine
						(usually notes), both rooms stay as they are.
					</p>
					{#each projectRooms.filter((r) => r.id !== currentRoom?.id) as room (room.id)}
						<button
							type="button"
							class="fe-view-option"
							data-testid="fe-room-combine-pick"
							data-room-id={room.id}
							onclick={() => void runCombine(room.id, false)}
						>
							<span>{room.label}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
	{#if pendingRoomSwitch}
		<div
			class="fe-room-switch-root"
			use:portalModal
			data-testid="fe-room-switch-dirty"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fe-room-switch-title"
		>
			<button
				type="button"
				class="fe-room-switch-scrim"
				aria-label="Stay"
				onclick={() => (pendingRoomSwitch = null)}
			></button>
			<div class="fe-room-switch-card">
				<h2 id="fe-room-switch-title" data-testid="fe-room-switch-title">
					You have unsaved work in {currentRoom?.label ?? 'this room'}.
				</h2>
				<div class="fe-room-switch-actions">
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--ghost"
						data-testid="fe-room-stay"
						onclick={() => (pendingRoomSwitch = null)}
					>
						Stay
					</button>
					<button
						type="button"
						class="ds-btn ds-btn--sm ds-btn--primary"
						data-testid="fe-room-save-switch"
						onclick={() => void confirmSaveAndSwitch()}
					>
						Save and switch
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if storageDialogOpen && localVfs}
		<FeStorageDialog
			vfs={localVfs}
			scope="filesystem"
			rootId={parentId}
			onClose={() => (storageDialogOpen = false)}
		/>
	{/if}

	{#if projectStorageOpen && localVfs && projectRootId}
		<FeProjectStorageDialog
			vfs={localVfs}
			rootId={projectRootId}
			onImported={driver.rebuildImportedRefs}
			onScanExportRefs={driver.scanExportRefs}
			onResolveExportRefs={driver.resolveExportRefs}
			history={projectHistory}
			onPackHistory={onPackHistory}
			onClose={() => (projectStorageOpen = false)}
		/>
	{/if}

	{#if projectIntegrityOpen && localVfs && projectRootId}
		<FeStorageDialog
			vfs={localVfs}
			scope="project"
			rootId={projectRootId}
			title="Check project integrity"
			onClose={() => (projectIntegrityOpen = false)}
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
			use:portalModal
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
			entries={selected.size > 1 && selected.has(floatingPreviewEntry.id) ? selectedEntries : []}
			{driver}
			{mediaMeta}
			loadMedia={true}
			infoLine={previewInfoLine(floatingPreviewEntry)}
			sizeText={selected.size > 1 ? selectionSizeLabel(selectedEntries) : ''}
			projectState={floatingPreviewEntry.kind === 'folder' ? previewIsProject : null}
			onClose={() => {
				actionsMenuOpen = false;
				floatingPreviewEntry = null;
			}}
			actions={previewActionBar}
		/>
	{/if}
</div>

{#snippet presenceDots(fileId: string)}
	{@const marks = presenceByFileId?.get(fileId)}
	{#if marks?.length}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<span
			class="fe-presence-dots"
			data-testid="fe-presence-dots"
			data-no-drag
			onpointerdown={(e) => e.stopPropagation()}
			onpointerup={(e) => e.stopPropagation()}
			onclick={(e) => {
				e.stopPropagation();
				e.preventDefault();
				const entry = nodes.find((n) => n.id === fileId);
				if (entry && onOpen && (mode === 'open' || mode === 'manage')) void emitOpen(entry);
			}}
		>
			{#each marks as m (m.clientId)}
				<span
					class="fe-presence-dot"
					data-testid="fe-presence-dot"
					data-client-id={m.clientId}
					title={m.name}
					style:background={m.color}
				></span>
			{/each}
		</span>
	{/if}
{/snippet}

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
	{#if driver.writeFile && ((onQuickEditVideo && getPreviewKind(entry) === 'video') || (onQuickEditAudio && getPreviewKind(entry) === 'audio') || (onQuickEditImage && canQuickEditRaster(entry)))}
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="fe-file-preview-quick-edit"
			onclick={() => {
				const target = entry;
				closePreviewForHandoff();
				const ctx = {
					read: () => readOpenTarget(target),
					save: (file: File) => driver.writeFile!(target.parentId, file)
				};
				if (getPreviewKind(target) === 'video') onQuickEditVideo?.(target, ctx);
				else if (getPreviewKind(target) === 'audio') onQuickEditAudio?.(target, ctx);
				else onQuickEditImage?.(target, ctx);
			}}
		>
			Quick edit
		</button>
	{/if}
	{#if driver.writeFile && onQuickConvertSvg && canQuickConvertSvg(entry)}
		<button
			type="button"
			class="ds-btn ds-btn--sm ds-btn--secondary"
			data-testid="fe-file-preview-convert-svg"
			onclick={() => {
				const target = entry;
				closePreviewForHandoff();
				onQuickConvertSvg(target, {
					read: () => readOpenTarget(target),
					save: (file: File) => driver.writeFile!(target.parentId, file)
				});
			}}
		>
			Convert to SVG
		</button>
	{/if}
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

{#snippet previewIcon(testId: string, tip: string, icon: FeIconName, onclick: () => void, disabled = false, danger = false)}
	<button
		type="button"
		class="fe-preview-icon"
		class:danger
		data-testid={testId}
		title={tip}
		aria-label={tip}
		{disabled}
		onclick={() => {
			actionsMenuOpen = false;
			onclick();
		}}
	>
		<FeIcon name={icon} size={16} /><span class="fe-sr">{tip}</span>
	</button>
{/snippet}

{#snippet previewActionBar()}
	{@const multi = selected.size > 1}
	{@const entry = previewTarget()}
	{#if entry && (mode === 'manage' || mode === 'open')}
		<div
			class="fe-preview-iconbar"
			data-fe-is-project={
				!multi && entry.kind === 'folder' && previewIsProject != null
					? previewIsProject
						? 'true'
						: 'false'
					: undefined
			}
		>
			{#if !multi && previewShowsOpen(entry)}
				{@render previewIcon('fe-file-preview-open', defaultOpenLabel(entry), 'folder-open', () => void confirmPreviewOpen(), previewBusy)}
			{/if}
			{#if !multi && onToggleFolderFavourite && entry.kind === 'folder'}
				{@render previewIcon('fe-preview-favourite-folder', isFolderFavourite?.(entry.id) ? 'Remove folder from favourites' : 'Add folder to favourites', 'star', () => onToggleFolderFavourite?.(entry), listBusy)}
			{/if}
			{#if !multi && onOpenProject && entry.kind === 'folder'}
				{@render previewIcon('fe-open-project', 'Open project', 'folder-project', () => void confirmOpenProject(), previewBusy)}
			{/if}
			{#if !multi && onSendFile && entry.kind === 'file'}
				{@render previewIcon('fe-file-preview-send', sendLabel, 'send', () => void confirmPreviewSend(), previewBusy)}
			{/if}
			{#if mode === 'manage'}
				{#if !multi && caps.supportsRename}
					{@render previewIcon('fe-rename-btn', 'Rename', 'pencil', () => renamePreviewItem(), listBusy)}
				{/if}
				{#if canCopyFiles}
					{@render previewIcon('fe-row-copy', 'Copy', 'copy', () => {
						if (multi) copySelection();
						else void copyPreviewItem();
					}, listBusy)}
				{/if}
				{#if canCutFiles}
					{@render previewIcon('fe-cut', 'Cut', 'scissors', () => {
						if (multi) void cutSelection();
						else void cutPreviewItem();
					}, listBusy)}
				{/if}
				{#if caps.supportsDownload && (multi ? canDownloadSelection : entry.kind === 'file')}
					{@render previewIcon('fe-row-download', 'Download', 'download', () => {
						if (multi) void downloadSelected();
						else void downloadNode(entry);
					}, listBusy || (multi && downloadBusy))}
				{/if}
				{@render previewIcon('fe-row-trash', 'Delete', 'trash', () => {
					if (multi) void trashSelected();
					else void deletePreviewItem();
				}, listBusy, true)}
				<div class="fe-preview-menu-wrap">
					<button
						type="button"
						class="fe-preview-icon"
						data-testid="fe-preview-actions"
						title="Actions"
						aria-label="Actions"
						aria-haspopup="menu"
						aria-expanded={actionsMenuOpen}
						onclick={(e) => {
							e.stopPropagation();
							actionsMenuOpen = !actionsMenuOpen;
						}}
					>
						<FeIcon name="ellipsis" size={16} />
						<span class="fe-sr">Actions</span>
					</button>
					{#if actionsMenuOpen}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="fe-preview-menu" data-testid="fe-preview-actions-menu" onclick={() => (actionsMenuOpen = false)}>
							{#if !multi}
								{@render archiveButtons(entry)}
								{#if onInitProject && entry.kind === 'folder' && previewIsProject !== true}
									<button
										type="button"
										class="fe-preview-menu-item"
										data-testid="fe-init-project"
										disabled={previewBusy}
										onclick={() => {
											actionsMenuOpen = false;
											void confirmInitProject();
										}}
									>
										Init project
									</button>
								{/if}
							{:else}
								<button type="button" class="fe-preview-menu-item" data-testid="fe-file-preview-compress" onclick={() => { actionsMenuOpen = false; startArchive('compress', selectedEntries); }}>Compress</button>
								<button type="button" class="fe-preview-menu-item" data-testid="fe-file-preview-encrypt" onclick={() => { actionsMenuOpen = false; startArchive('encrypt', selectedEntries); }}>Encrypt</button>
								{#if canDecompressSelection}
									<button type="button" class="fe-preview-menu-item" data-testid="fe-file-preview-decompress" onclick={() => { actionsMenuOpen = false; startArchive('decompress', selectedEntries); }}>Decompress</button>
								{/if}
								{#if canDecryptSelection}
									<button type="button" class="fe-preview-menu-item" data-testid="fe-file-preview-decrypt" onclick={() => { actionsMenuOpen = false; startArchive('decrypt', selectedEntries); }}>Decrypt</button>
								{/if}
							{/if}
							{@render detailsCopyAcross()}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#if favouriteMenu}
	<div
		class="fe-favourite-menu" data-testid="fe-folder-context-menu"
		role="menu" aria-label="Folder actions" tabindex="-1"
		style:left="{favouriteMenu.x}px" style:top="{favouriteMenu.y}px"
		bind:this={favouriteMenuEl}
	>
		<button
			type="button" role="menuitem" class="ds-btn ds-btn--sm ds-btn--ghost"
			data-testid="fe-context-favourite-folder"
			onclick={() => { onToggleFolderFavourite?.(favouriteMenu!.entry); favouriteMenu = null; }}
		>
			<FeIcon name="star" size={14} />
			{isFolderFavourite?.(favouriteMenu.entry.id) ? 'Remove from favourites' : 'Add to favourites'}
		</button>
	</div>
{/if}

<style>
	.fe-header :global([data-testid='fe-favourite-folder'][aria-pressed='true']) {
		color: var(--accent);
		background: rgb(var(--accent-rgb) / 0.08);
	}
	.fe-header :global([data-testid='fe-favourite-folder'][aria-pressed='true'] svg) {
		fill: currentColor;
	}
	.fe-favourite-menu {
		position: fixed;
		z-index: 1000;
		padding: 0.3rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
	}

	.fe-root {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		width: 100%;
		max-width: 100%;
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
		min-width: 0;
		max-width: 100%;
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
	.fe-crumb-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.fe-crumb-item :global(.fe-tip) {
		flex-shrink: 0;
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
	.fe-folder-badges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.fe-room-chip-wrap,
	.fe-people-chip-wrap {
		position: relative;
		display: inline-flex;
	}
	.fe-room-chip,
	.fe-people-chip,
	.fe-inside-project-badge,
	.fe-git-enabled-badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--accent, #38bdf8);
		background: rgb(var(--accent-rgb, 56 189 248) / 0.12);
		border: 1px solid rgb(var(--accent-rgb, 56 189 248) / 0.28);
		border-radius: 9999px;
		user-select: none;
		white-space: nowrap;
	}
	button.fe-room-chip,
	button.fe-people-chip,
	button.fe-git-enabled-badge,
	.fe-folder-action {
		cursor: pointer;
		font: inherit;
	}
	.fe-room-chip-caret {
		margin-left: 4px;
		font-size: 0.65rem;
		opacity: 0.8;
	}
	.fe-room-menu {
		min-width: 180px;
	}
	.fe-room-new-form {
		display: flex;
		gap: 6px;
		padding: 4px;
		align-items: center;
	}
	.fe-room-new-input {
		flex: 1;
		min-width: 0;
		padding: 4px 8px;
		font: inherit;
		font-size: 0.85rem;
		color: var(--text-primary);
		background: var(--surface-secondary, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-sm, 4px);
	}
	.fe-room-switch-root {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-room-switch-scrim {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
	}
	.fe-room-switch-card {
		position: relative;
		z-index: 1;
		width: min(440px, calc(100vw - 2rem));
		padding: 1.15rem 1.25rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
	}
	.fe-people-arrival {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.4rem;
		font-size: 0.8rem;
	}
	.fe-people-arrival-select {
		font: inherit;
		color: var(--text-primary);
		background: var(--surface-1);
		border: 1px solid var(--line-hairline);
		padding: 0.1rem 0.3rem;
	}
	.fe-people-rooms {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.4rem;
		font-size: 0.8rem;
	}
	.fe-people-room {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--text-secondary);
	}
	.fe-room-note {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
	.fe-room-conflict-list {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
	.fe-room-conflict-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.1rem 0;
	}
	.fe-room-switch-card h2 {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.fe-room-switch-card p {
		margin: 0 0 0.75rem;
		font-size: 0.9rem;
		color: var(--text-secondary, inherit);
	}
	.fe-room-switch-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.fe-people-chip-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
		margin-right: 4px;
	}
	.fe-people-sheet {
		min-width: 260px;
		max-width: min(360px, 90vw);
		max-height: min(70vh, 480px);
		overflow: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.fe-people-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-sm, 4px);
	}
	.fe-people-name {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.72rem;
		color: var(--text-secondary, inherit);
	}
	.fe-people-rename {
		width: 100%;
		padding: 4px 8px;
		font: inherit;
		font-size: 0.9rem;
		color: var(--text-primary);
		background: var(--surface-secondary, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-sm, 4px);
	}
	.fe-people-now,
	.fe-people-session,
	.fe-people-later {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-secondary, inherit);
	}
	.fe-people-row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		justify-content: flex-end;
	}
	.fe-folder-action {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		font-size: 0.72rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--text-primary);
		background: transparent;
		border: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.14));
		border-radius: 9999px;
		white-space: nowrap;
	}
	.fe-folder-action:hover,
	button.fe-room-chip:hover,
	button.fe-people-chip:hover,
	button.fe-git-enabled-badge:hover {
		border-color: var(--accent, #38bdf8);
		color: var(--text-primary);
	}
	.fe-toolbar {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		flex: 0 1 auto;
		min-width: 0;
		max-width: 100%;
	}
	.fe-toolbar-row {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: nowrap;
		justify-content: flex-end;
		min-width: 0;
		max-width: 100%;
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
	.fe-split > .fe-list-col {
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
	.fe-preview-dock.filled {
		display: flex;
		flex-direction: column;
		padding: 0;
		overflow: hidden;
	}
	.fe-preview-dock.filled :global(.fe-float-card) {
		flex: 1 1 auto;
		min-height: 0;
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
	.fe-row.fe-cut-pending {
		opacity: 0.5;
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
	.fe-preview-name {
		margin: 0 0 12px;
		font-size: 1rem;
		font-weight: 650;
		word-break: break-word;
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
	.fe-preview-iconbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px;
	}
	.fe-preview-icon {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
	}
	.fe-preview-icon:hover:not(:disabled) {
		background: var(--surface-3, #2a2a2a);
		color: var(--text-primary, #fff);
	}
	.fe-preview-icon.danger:hover:not(:disabled) {
		color: var(--cat-red-soft, #e66);
	}
	.fe-preview-icon:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.fe-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.fe-preview-menu-wrap {
		position: relative;
	}
	.fe-preview-menu {
		position: absolute;
		bottom: calc(100% + 4px);
		left: 0;
		z-index: 5;
		min-width: 180px;
		max-height: min(50vh, 320px);
		overflow: auto;
		padding: 4px;
		background: var(--surface-2, #1c1c24);
		border: 1px solid var(--line-hairline, #333);
		border-radius: 4px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
	}
	.fe-preview-menu-item,
	.fe-preview-menu :global(button) {
		display: flex;
		width: 100%;
		justify-content: flex-start;
		align-items: center;
		gap: 8px;
		height: auto;
		min-height: 0;
		padding: 6px 8px;
		background: none;
		border: none;
		box-shadow: none;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		border-radius: 3px;
		cursor: pointer;
		text-align: left;
	}
	.fe-preview-menu-item:hover:not(:disabled),
	.fe-preview-menu :global(button:hover:not(:disabled)) {
		background: var(--surface-3, #2a2a2a);
	}
	.fe-preview-menu-item:disabled {
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
	/* Rubber-band marquee — drawn in viewport (client) coords over the list. */
	.fe-marquee {
		position: fixed;
		border: 1px solid var(--accent);
		background: rgb(var(--accent-rgb) / 0.12);
		pointer-events: none;
		z-index: 6;
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
	/** Focus anchor row: same weight as the selection outline, a shade
	 *  darker — distinct on close look, not a different style. */
	.fe-row.focused {
		outline: 1px solid color-mix(in srgb, var(--accent, #38bdf8) 75%, black);
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
	/* List/detailed rows size icons and thumbnails from --fe-row-icon-px (the
	   view popup slider). Icons mode tiles use --fe-icon-size instead. */
	.fe-list .fe-row .fe-icon,
	.fe-list .fe-row .fe-icon :global(.fe-thumb),
	.fe-list .fe-row .fe-icon :global(.fe-thumb-img),
	.fe-list .fe-row .fe-icon :global(.fe-thumb-loading),
	.fe-list .fe-row .fe-icon :global(.fe-thumb-fallback) {
		width: var(--fe-row-icon-px, 16px);
		height: var(--fe-row-icon-px, 16px);
	}
	.fe-row.folder .fe-icon {
		color: var(--accent-light);
	}
	.fe-pack-badge {
		margin-left: 0.35rem;
		padding: 0 0.3rem;
		font-size: 0.62rem;
		line-height: 1.4;
		border-radius: 3px;
		border: 1px dashed var(--accent-light, var(--accent));
		color: var(--text-muted);
		vertical-align: 1px;
		flex: none;
	}

	.fe-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-presence-dots {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		flex: 0 0 auto;
		margin-left: 0.35rem;
		vertical-align: middle;
		pointer-events: auto;
		cursor: pointer;
	}
	.fe-presence-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		box-shadow: 0 0 0 1px color-mix(in srgb, #000 25%, transparent);
		pointer-events: auto;
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
	.fe-new-menu-popup {
		max-height: min(70vh, 22rem);
		overflow-y: auto;
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
	.fe-view-option:disabled {
		opacity: 0.45;
		cursor: not-allowed;
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
	.fe-view-slider {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 184px;
		padding: 4px 8px 6px;
		font: inherit;
		font-size: 0.85rem;
		color: var(--text-primary);
	}
	.fe-view-slider-label {
		font-size: 0.85rem;
	}
	.fe-view-slider input[type='range'] {
		width: 100%;
		margin: 0;
		accent-color: var(--accent);
	}
	.fe-toolbar-more-wrap {
		position: relative;
		display: inline-flex;
	}
	.fe-toolbar-more-popup {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 20;
		min-width: 200px;
		max-width: min(280px, calc(100vw - 16px));
		max-height: min(70vh, 420px);
		overflow: auto;
		padding: 4px;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md, 4px);
		box-shadow: 0 8px 24px rgb(var(--scrim-rgb, 0 0 0) / 0.3);
	}
	.fe-toolbar-more-popup :global(button.ds-btn.ds-btn--sm) {
		display: flex;
		width: 100%;
		justify-content: flex-start;
		align-items: center;
		gap: 8px;
		height: auto;
		min-height: 0;
		padding: 6px 8px;
		background: none;
		border: none;
		box-shadow: none;
		color: inherit;
		font: inherit;
		font-size: 0.85rem;
		border-radius: 3px;
	}
	.fe-toolbar-more-popup :global(button.ds-btn.ds-btn--sm:hover:not(:disabled)) {
		background: var(--surface-3);
	}

	/* ── Icon view ────────────────────────────────────────────── */
	.fe-list-icons {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(calc(var(--fe-icon-size, 96px) + 16px), 1fr));
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
		width: var(--fe-icon-size, 96px);
		height: var(--fe-icon-size, 96px);
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border-radius: 4px;
		background: var(--surface-3);
	}
	.fe-row-icon-fallback {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
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
	/* Fixed widths, not min-widths: the header buttons share these, so a
	   long cell clips instead of shifting the columns under it. */
	.fe-row-size {
		width: 5rem;
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fe-row-type {
		width: 4.5rem;
		text-transform: capitalize;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fe-row-modified {
		width: 8rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fe-list-detailed .fe-icon,
	.fe-list-detailed .fe-icon :global(.fe-thumb),
	.fe-list-detailed .fe-icon :global(.fe-thumb-img) {
		width: var(--fe-row-icon-px, 16px);
		height: var(--fe-row-icon-px, 16px);
	}

	/* ── Detailed view: header row + sort ────────────────────── */
	.fe-list-col {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.fe-list-head {
		flex: none;
		padding: 0 6px 6px;
	}
	.fe-list-head-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
	}
	.fe-head-cell {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0;
		background: none;
		border: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		min-width: 0;
		overflow: hidden;
	}
	.fe-head-cell:hover {
		color: var(--text-primary);
	}
	.fe-head-name {
		flex: 1 1 0;
		min-width: 0;
		text-align: left;
		justify-content: flex-start;
		/* icon (16px) + gap (8px) on the data rows — keeps name text aligned */
		padding-left: 24px;
	}
	.fe-col-head-size {
		width: 5rem;
		justify-content: flex-end;
	}
	.fe-col-head-type {
		width: 4.5rem;
	}
	.fe-col-head-modified {
		width: 8rem;
	}
	.fe-head-arrow {
		min-width: 12px;
		text-align: right;
	}
	/* Sort chip in the toolbar */
	.fe-sort-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px 3px 8px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		background: var(--surface-3);
		border: 1px solid var(--line-hairline);
		border-radius: 999px;
		white-space: nowrap;
		align-self: center;
	}
	.fe-sort-chip-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fe-sort-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		background: none;
		border: none;
		border-radius: 999px;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.fe-sort-clear:hover {
		background: var(--surface-2);
		color: var(--text-primary);
	}
	/* Columns rows inside the view popup */
	.fe-view-subhead {
		padding: 4px 8px 2px;
		font-size: 0.7rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.fe-col-row {
		display: flex;
		align-items: center;
	}
	.fe-col-row .fe-view-option {
		flex: 1 1 auto;
		min-width: 0;
	}
	.fe-col-order {
		display: inline-flex;
		flex: none;
		gap: 2px;
		padding-right: 8px;
	}
	.fe-col-order-btn {
		width: 20px;
		height: 20px;
		padding: 0;
		background: none;
		border: 1px solid var(--line-hairline);
		border-radius: 3px;
		color: var(--text-secondary);
		font-size: 0.7rem;
		line-height: 1;
		cursor: pointer;
	}
	.fe-col-order-btn:hover:not(:disabled) {
		background: var(--surface-3);
		color: var(--text-primary);
	}
	.fe-col-order-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.fe-view-note {
		padding: 2px 8px 2px;
		margin: 0;
		font-size: 0.72rem;
		color: var(--text-muted);
	}

</style>
