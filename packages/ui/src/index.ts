// Date model (types + helpers) — reusable, dependency-free. Re-exported here
// so consumers of @modular@shared-packages/ui get the date vocabulary alongside the
// pickers, and so @modular-app/module-sdk can re-export it via ./date.
export * from './date/index.ts';

export { default as ShellFrame } from './ShellFrame.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as TopProgressBar } from './TopProgressBar.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export {
  CHECKBOX_STATES,
  CHECKBOX_STATE_LABELS,
  DEFAULT_CHECKBOX_CYCLE,
  FULL_CHECKBOX_CYCLE,
  nextCheckboxState,
  checkboxStateFromBoolean,
  isCheckboxFilled,
  checkboxAriaChecked,
  type CheckboxState
} from './checkbox.ts';
export { default as RadioGroup } from './RadioGroup.svelte';
export { default as ConnectionScopeSelect } from './ConnectionScopeSelect.svelte';
export { default as NumberInput } from './NumberInput.svelte';
export { default as DateRangeCalendar } from './DateRangeCalendar.svelte';
export { default as DateRangePicker } from './DateRangePicker.svelte';
export { default as DatePicker } from './DatePicker.svelte';
export { default as FileDropZone } from './FileDropZone.svelte';
export { parseExplorerDropPayload, type ExplorerDropPayload } from './explorer-drop.ts';
export { formatBytes, bytesToArrayBuffer, downloadBytes, fileFromBytes } from './files.ts';
export { default as Separator } from './Separator.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as SegmentedControl } from './SegmentedControl.svelte';
export { default as Pagination } from './Pagination.svelte';
export { default as Popover } from './Popover.svelte';
export { default as InfoTooltip } from './InfoTooltip.svelte';
export { default as RouteFrameOverlay } from './RouteFrameOverlay.svelte';
export { default as TimePicker } from './TimePicker.svelte';
export { default as TimeRangePicker } from './TimeRangePicker.svelte';
export { default as DateAnchorEditor } from './DateAnchorEditor.svelte';
export { default as DateDraftComposer } from './DateDraftComposer.svelte';
export { DateAnchorEditorState, type AnchorType } from './DateAnchorEditorState.svelte.js';
export { default as OverlayHost } from './OverlayHost.svelte';
export { default as VelocityScroller } from './VelocityScroller.svelte';
export { default as ResizableSidePanel } from './ResizableSidePanel.svelte';
export { default as PaneLayout } from './pane-layout/PaneLayout.svelte';
export { default as SplitHandle } from './pane-layout/SplitHandle.svelte';
export { default as FileChrome } from './file-chrome/FileChrome.svelte';
export { default as UpdateBanner } from './app-update/UpdateBanner.svelte';
export {
	appUpdate,
	startAppUpdateWatcher
} from './app-update/appUpdate.svelte.js';
export {
	APPLYING_UPDATE_KEY,
	applyUpdatePlan,
	findUpdateBannerHost,
	shouldOfferUpdate,
	type AppUpdateStatus
} from './app-update/appUpdate.ts';
export {
	confirmDiscardUnsaved,
	installBeforeUnload,
	installSaveHotkey,
	DEFAULT_CONFLICT_MSG
} from './file-chrome/unsaved.ts';
export { default as AppWindows } from './app-windows/AppWindows.svelte';
export { default as AppWindowsButton } from './app-windows/AppWindowsButton.svelte';
export type { AppWindowLeaf, AppWindowRoleDef } from './app-windows/types.ts';
export {
	canCloseAppWindow,
	clampUnavailableRoles,
	closeAppWindow,
	createAppWindowRoot,
	defaultAppWindows,
	pickNewRole,
	resolveTargetLeafId,
	roleCount,
	setAppWindowRole,
	splitAppWindow
} from './app-windows/manager.ts';
export {
	paneChromeSlotId,
	findPaneWindowHeader,
	portalToPaneWindowHeader,
	portalToPaneChrome
} from './pane-layout/chrome.ts';
export {
	createLeaf,
	splitLeaf,
	closeLeaf,
	setSplitRatio,
	listLeaves,
	leafCount,
	clampRatio,
	newLayoutId,
	resetLayoutIdsForTests,
	syncLayoutIdSeq,
	findNode,
	MIN_SPLIT_RATIO,
	MAX_SPLIT_RATIO
} from './pane-layout/tree.ts';
export type {
	LayoutNode,
	LayoutLeaf,
	LayoutSplit,
	SplitDirection,
	SplitPlacement
} from './pane-layout/types.ts';
export {
	PANE_SESSION_QUERY,
	PANE_SESSION_VERSION,
	PANE_SESSION_STORAGE_PREFIX,
	createSessionId,
	readSessionId,
	applySessionId,
	isWorkspacePath,
	parseLayoutNode,
	parsePaneSessionSnapshot,
	createPaneSessionStore
} from './pane-layout/session.ts';
export type {
	PaneSessionSnapshot,
	PaneSessionStore,
	StorageLike
} from './pane-layout/session.ts';
export {
	PANE_HISTORY_STATE_KEY,
	readPaneHistoryMarker,
	createPaneHistory
} from './pane-layout/history.ts';
export type {
	PaneHistory,
	PaneHistoryMarker,
	HistoryLike,
	EventTargetLike
} from './pane-layout/history.ts';
export { default as MobileBottomTray } from './MobileBottomTray.svelte';
export { default as TimeStackBuilder } from './TimeStackBuilder.svelte';
export { default as TimeReferenceRangeEditor } from './TimeReferenceRangeEditor.svelte';
export { default as QuickAddDateTimePopover } from './QuickAddDateTimePopover.svelte';
export {
  DEFAULT_QUICK_ADD_DATE_TIME_PRESETS,
  buildQuickAddDateTimePreset,
  cloneQuickAddTimeReference,
  type QuickAddDateTimePreset,
  type QuickAddDateTimePresetContext,
  type QuickAddDateTimePresetKind
} from './quick-add-date-time.js';
export { sanitizeSvg } from './sanitize.ts';
export { cn } from './utils.js';
export { getConnectionColor } from './connection-color.ts';
export {
  openOverlay,
  closeOverlay,
  updateOverlay,
  getActiveOverlay,
  type OverlayDescriptor
} from './overlay-state.svelte.js';
export type { TabItem } from './tabs.js';
export type { SegmentedControlOption } from './segmented-control.js';
export type { RadioGroupOption } from './radio-group.js';
export type { SelectOption } from './select.js';
export type { ConnectionScopeSelectGroup, ConnectionScopeSelectScope } from './connection-scope-select.ts';
export {
  COMPOSITE_SEPARATOR,
  ALL_SCOPES_SENTINEL,
  buildScopeSelectionToken,
  parseScopeSelectionToken
} from './connection-scope-select.ts';
export {
  buildCompositeId,
  parseCompositeId,
  isCompositeId,
  assertCompositeId
} from './composite-id.ts';
export type { DateRangeValue, DateRangeSelection } from './date-range.js';
export type { DatePickerValue } from './date-picker.js';
export type { ResizableSidePanelHandleVariant } from './ResizableSidePanel.types.ts';
export { default as DeleteConfirmOverlay } from './DeleteConfirmOverlay.svelte';
export { default as Dialog } from './Dialog.svelte';
export {
  pushDialog,
  popDialog,
  isTopDialog,
  getDialogDepth,
  getModalBaseZ,
  nextDialogTitleId,
  __resetDialogStackForTests,
  type DialogStackEntry
} from './dialogStack.ts';
export { default as PathNodeEditor } from './PathNodeEditor.svelte';
export { default as ObjectTransformFrame } from './ObjectTransformFrame.svelte';
export {
	applyFrameResize,
	frameCenter,
	nextRotation,
	rotationCss,
	rotationSvg,
	showMoveHit,
	showResizeHandles,
	showRotateHandle,
	MIN_SIZE,
	RESIZE_HANDLES,
	RESIZE_HANDLE_CURSORS,
	RESIZE_HANDLE_LABELS
} from './objectTransform.ts';
export type { FrameRect, ResizeHandle, TransformMode } from './objectTransform.ts';

// Unified toast system
export { default as ToastHost } from './ToastHost.svelte';
export {
	toast,
	getToasts,
	__resetToastsForTests,
	type Toast,
	type ToastKind
} from './toast-state.svelte.js';

// Unified app clipboard
export {
	appClipboard,
	ClipboardStore,
	CLIPBOARD_SYNC_STORAGE_KEY,
	type ClipboardItem,
	ClipboardPopup
} from './clipboard/index.js';

