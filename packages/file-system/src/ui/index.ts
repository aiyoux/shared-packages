export { default as FileExplorer } from './FileExplorer.svelte';
export { default as FileExplorerDialog } from './FileExplorerDialog.svelte';
export { default as FeTreeView } from './FeTreeView.svelte';
export { default as UnsavedChangesDialog } from './UnsavedChangesDialog.svelte';
export { detectProject, findProjectRoot, type ProjectRootHit } from './detectProject.js';
export type { ExplorerMode, ExplorerContext, RemoteKind } from './componentTypes.js';
export {
	saveWithConflictConfirm,
	openFileWithGuard,
	SaveCancelledError,
	DEFAULT_CONFLICT_MSG,
	type SaveConflictConfirmOpts,
	type DirtyOpenChoice,
	type OpenFileWithGuardOpts
} from './saveFlow.js';
export { showDirtyOpenDialog } from './dirtyOpenDialog.js';
export { default as StoragePersistenceStatus } from './StoragePersistenceStatus.svelte';
export { default as DualPaneExplorer } from './DualPaneExplorer.svelte';
export { default as DualPhaseConfirm } from './DualPhaseConfirm.svelte';
export { default as RemoteConnectionsDialog } from './RemoteConnectionsDialog.svelte';
export type { DualPaneTids, PaneId as DualPanePaneId } from './dualPaneTypes.js';
export {
	canServerCopy,
	classify,
	isDualPhaseCopy,
	describeCopyAcrossPath,
	copyAcross,
	CopyAcrossError,
	idsFromExplorerDragTarget,
	idsFromExplorerDataTransfer,
	parseExplorerDragIds,
	parseExplorerDragPayload,
	explorerDragFromDataTransfer,
	dataTransferHasOsFiles,
	dataTransferHasExplorerIds,
	filesFromDataTransfer,
	FE_EXPLORER_IDS_MIME,
	type CopyAcrossArgs,
	type CopyAcrossClass,
	type CopyAcrossErrorCode,
	type CopyAcrossPath,
	type CopyAcrossPathKind,
	type ExplorerDragPayload
} from './copyAcross.js';
export {
	collectOsDrop,
	importOsDropToDriver,
	snapshotFiles,
	nodesFromFiles,
	OsDropError,
	type OsDropFileProgress,
	type OsDropNode
} from './osDrop.js';
export { formatExplorerError } from './explorerError.js';
export {
	setCrossWindowDrag,
	getCrossWindowDrag,
	clearCrossWindowDrag,
	setPointerDragActive,
	isPointerDragActive,
	type CrossWindowDragSession
} from './crossWindowDnd.js';
export {
	prefetchForDragOut,
	canZipFolderForDragOut,
	folderZipName,
	formatDownloadURL,
	getDragOutFile,
	getDragOutUrl,
	hasDragOutFile,
	evictDragOutFile,
	clearDragOutCache,
	evictDriver
} from './dragOutCache.js';
export {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	EXPLORER_LIST_MAX_ENTRIES,
	applyListCap,
	nodeToEntry,
	isLocalClass,
	isRemoteClass,
	canReadExplorerBlob,
	readExplorerBlob,
	loadExplorerMediaSrc,
	type ExplorerCapabilities,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerEntryId,
	type ExplorerEntryKind,
	type ExplorerListOptions,
	type ExplorerListResult,
	type ExplorerOpenTarget,
	type ExplorerOpenContext,
	type OpenProjectContext
} from './explorerDriver.js';
export { createLocalExplorerDriver, type LocalExplorerDriverOptions } from './localExplorerDriver.js';
export { portal } from './portal.js';
export {
	createMemoryExplorerDriver,
	MEMORY_CAPS,
	type MemoryExplorerDriverOptions
} from './memoryExplorerDriver.js';
export {
	createDiskExplorerDriver,
	DISK_CAPS,
	canPickDirectory,
	pickDirectory
} from '../disk/index.js';
export {
	stackTransferItems,
	stackedStageLabel,
	stagePercent,
	type StackedProgress,
	type StackProgressPhase
} from './stackProgress.js';
export {
	httpDownloadIsSafe,
	saveFileToDisk,
	triggerHttpDownload,
	triggerBlobDownload,
	type HttpDownloadLocation,
	type StreamDownload
} from './saveToDisk.js';
export {
	calculateMidOrder,
	canonicalizeSiblingZone,
	createTreeDndSession,
	resolveDrop,
	zoneFromY,
	type DropZone,
	type TreeDndSession
} from './treeDnd/index.js';
export * from './sizeTreemap.js';
export * from './storageInspect.js';
export { default as FeStorageInspector } from './FeStorageInspector.svelte';
export { default as FeStorageDialog } from './FeStorageDialog.svelte';
export { default as ProjectStoragePanel } from './ProjectStoragePanel.svelte';
