// Date model (types + helpers) — reusable, dependency-free. Re-exported here
// so consumers of @modular@shared-packages/ui get the date vocabulary alongside the
// pickers, and so @modular-app/module-sdk can re-export it via ./date.
export * from './date/index.ts';

export { default as ShellFrame } from './ShellFrame.svelte';
export { default as Button } from './Button.svelte';
export { default as Input } from './Input.svelte';
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
export { default as Select } from './Select.svelte';
export { default as ConnectionScopeSelect } from './ConnectionScopeSelect.svelte';
export { default as NumberInput } from './NumberInput.svelte';
export { default as DateRangeCalendar } from './DateRangeCalendar.svelte';
export { default as DateRangePicker } from './DateRangePicker.svelte';
export { default as DatePicker } from './DatePicker.svelte';
export { default as Label } from './Label.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Card } from './Card.svelte';
export { default as FileDropZone } from './FileDropZone.svelte';
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
