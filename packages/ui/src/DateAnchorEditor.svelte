<script module lang="ts">
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseOrVagueReference, DateInformation, RelevanceBound, RelevanceWindow, ResolveContext, StartOrEnd, TimeReference } from '@modular-app/module-sdk';
  import { cloneTimeReference, readRelevanceWindow } from '@modular-app/module-sdk';
  import {
    DateAnchorEditorState,
    type AnchorType
  } from './DateAnchorEditorState.svelte.js';
  import Button from './Button.svelte';
  import Checkbox from './Checkbox.svelte';
  import type { DatePickerValue } from './date-picker.ts';
  import DatePicker from './DatePicker.svelte';
  import NumberInput from './NumberInput.svelte';
  import RadioGroup from './RadioGroup.svelte';
  import Select from './Select.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import TimePicker from './TimePicker.svelte';
  import TimeRangePicker from './TimeRangePicker.svelte';
  import TimeStackBuilder from './TimeStackBuilder.svelte';

  type EditorMode = 'simple' | 'advanced' | 'radar-only' | 'clone';
  type DurationUnit = 'minutes' | 'hours' | 'days';
  type RelevanceChoice = 'default' | 'day' | 'week' | 'month' | 'year' | 'custom' | 'inf';
  type DisplayAsValue = 'mj' | 'mi' | 'sm' | 'n';
  type OffsetDirection = 'before' | 'after';

  let {
    value,
    onSave,
    onCancel,
    mode = 'simple',
    resolveContext,
    now,
    allowedAnchors = ['nw', 'up', 'pr'],
    saveLabel = 'Save',
    cancelLabel = 'Cancel',
    hideActions = false,
    useAnchorOffsetEditor = false,
    anchorOffsetLabel = 'plan start',
    allowNoDate = false,
    onSummaryChange = null,
    onDraftChange = null
  }: {
    value: DateInformation | null;
    onSave: (next: DateInformation | null) => void;
    onCancel: () => void;
    mode?: EditorMode;
    resolveContext?: ResolveContext;
    now?: Date;
    allowedAnchors?: Array<AnchorType>;
    saveLabel?: string;
    cancelLabel?: string;
    hideActions?: boolean;
    useAnchorOffsetEditor?: boolean;
    anchorOffsetLabel?: string;
    /**
     * When true, expose a third top-level “No date assigned” option in the
     * bucket picker. Selecting it and saving emits `null` to `onSave`,
     * signaling to the host that the item should have no date additional at
     * all (as opposed to an `nw`-anchored empty one).
     */
    allowNoDate?: boolean;
    onSummaryChange?: ((summary: string | null) => void) | null;
    onDraftChange?: ((draft: DateInformation) => void) | null;
  } = $props();

  const editor = new DateAnchorEditorState();

  const displayAsOptions = [
    { value: 'mj', label: 'Major' },
    { value: 'mi', label: 'Minor' },
    { value: 'sm', label: 'Mini' },
    { value: 'n', label: 'None' }
  ];

  const durationOptions = [
    { value: 'minutes', label: 'Minutes' },
    { value: 'hours', label: 'Hours' },
    { value: 'days', label: 'Days' }
  ];



  const offsetDirectionOptions = [
    { value: 'before', label: 'Before' },
    { value: 'after', label: 'After' }
  ] satisfies Array<{ value: OffsetDirection; label: string }>;
  let startDatePickerValue = $state(editor.startDatePickerValue);
  let endDatePickerValue = $state(editor.endDatePickerValue);
  let timeRangeValue = $state(editor.timeRangeValue);
  let simpleStackValue = $state<TimeReference>({});
  // Per-side relevance: 'default' inherits the planner/user fallback; the cal
  // units snap to the calendar period of the anchor; 'custom' uses value+unit.
  let relevanceBefore = $state<RelevanceChoice>('default');
  let relevanceAfter = $state<RelevanceChoice>('default');
  let beforeCustomValue = $state('1');
  let beforeCustomUnit = $state<DurationUnit>('days');
  let afterCustomValue = $state('1');
  let afterCustomUnit = $state<DurationUnit>('days');
  let anchorValue = $state<AnchorType>('nw');
  let dateAssigned = $state(true);
  let anchorSelection = $state<AnchorSelection>('up');
  let offsetEnabled = $state(false);
  let hasExplicitEnd = $state(false);
  let displayAsValue = $state<DisplayAsValue>('mj');
  let simpleAdvancedExpanded = $state(false);
  let visibilityExpanded = $state(false);
  let startOffsetMagnitude = $state('0');
  let startOffsetDirection = $state<OffsetDirection>('after');
  let endOffsetMagnitude = $state('0');
  let endOffsetDirection = $state<OffsetDirection>('after');
  let parentOffsetMagnitude = $state('0');
  let parentOffsetDirection = $state<OffsetDirection>('after');
  let parentEndOffsetMagnitude = $state('0');
  let parentEndOffsetDirection = $state<OffsetDirection>('after');

  // Derived state to unify 'up' and 'pr' offset UIs
  const startMagnitude = $derived(editor.anchorType === 'pr' ? parentOffsetMagnitude : startOffsetMagnitude);
  const startDirection = $derived(editor.anchorType === 'pr' ? parentOffsetDirection : startOffsetDirection);
  const endMagnitude = $derived(editor.anchorType === 'pr' ? parentEndOffsetMagnitude : endOffsetMagnitude);
  const endDirection = $derived(editor.anchorType === 'pr' ? parentEndOffsetDirection : endOffsetDirection);

  function setStartMagnitude(v: string) { if (editor.anchorType === 'pr') parentOffsetMagnitude = v; else startOffsetMagnitude = v; }
  function setStartDirection(v: OffsetDirection) { if (editor.anchorType === 'pr') parentOffsetDirection = v; else startOffsetDirection = v; }
  function setEndMagnitude(v: string) { if (editor.anchorType === 'pr') parentEndOffsetMagnitude = v; else endOffsetMagnitude = v; }
  function setEndDirection(v: OffsetDirection) { if (editor.anchorType === 'pr') parentEndOffsetDirection = v; else endOffsetDirection = v; }

  function isUserProvidedOffsetReference(ref: BaseOrVagueReference<string, number> | undefined): boolean {
    return Boolean(ref?.type === 'of' && ref.a === 'up');
  }

  function isPlanRelativeAnchor(): boolean {
    const value = editor.draft.value;
    return (
      isUserProvidedOffsetReference(value?.y?.s as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.y?.e as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.m?.s as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.m?.e as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.w?.s as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.w?.e as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.d?.s as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.d?.e as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.i?.s as BaseOrVagueReference<string, number> | undefined) ||
      isUserProvidedOffsetReference(value?.i?.e as BaseOrVagueReference<string, number> | undefined)
    );
  }

  function offsetDirectionFromDays(days: number): OffsetDirection {
    return days >= 0 ? 'after' : 'before';
  }

  function offsetMagnitudeFromDays(days: number): string {
    return String(Math.abs(days));
  }

  function daysFromOffset(direction: OffsetDirection, magnitude: string): number {
    const parsed = Number(magnitude);
    const safe = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    return direction === 'before' ? -safe : safe;
  }

  function planRelativeDayOffset(): number | null {
    const startDay = editor.draft.value?.d?.s as BaseOrVagueReference<string, number> | undefined;
    if (startDay?.type === 'of' && startDay.a === 'up') {
      return startDay.v;
    }
    return null;
  }

  function formatPlanRelativePlacement(): string {
    const dayOffset = planRelativeDayOffset();
    const label = anchorOffsetLabel;
    if (dayOffset === null || dayOffset === 0) {
      return `on the ${label}`;
    }
    if (dayOffset === 1) {
      return `1 day after the ${label}`;
    }
    if (dayOffset === -1) {
      return `1 day before the ${label}`;
    }
    if (dayOffset > 0) {
      return `${dayOffset} days after the ${label}`;
    }
    return `${Math.abs(dayOffset)} days before the ${label}`;
  }

  function formatParentRelativePlacement(): string {
    const dayOffset = editor.parentDayOffsets.start;
    if (dayOffset === 0) {
      return 'on the same day as the parent';
    }
    if (dayOffset === 1) {
      return '1 day after the parent';
    }
    if (dayOffset === -1) {
      return '1 day before the parent';
    }
    if (dayOffset > 0) {
      return `${dayOffset} days after the parent`;
    }
    return `${Math.abs(dayOffset)} days before the parent`;
  }

  type AnchorSelection = AnchorType | 'no-date';

  function defaultOffsetSource(anchors: AnchorType[]): AnchorType {
    if (anchors.includes('up')) return 'up';
    if (anchors.includes('pr')) return 'pr';
    return 'up';
  }

  function primaryAnchorOptions(anchors: AnchorType[], allowNoDateOption: boolean) {
    const options: Array<{ value: AnchorSelection; label: string; hint?: string }> = [];
    if (allowNoDateOption) {
      options.push({
        value: 'no-date',
        label: 'No date assigned',
        hint: 'Keep this item in the tree without any date additional.'
      });
    }
    if (anchors.includes('up') || anchors.includes('pr')) {
      options.push({
        value: 'up',
        label: 'Plan start',
        hint: 'Schedule this relative to the plan’s main resolution date.'
      });
    }
    options.push({
      value: 'pr',
      label: 'Closest parent',
      hint: 'Schedule this relative to the closest parent with an available date.'
    });
    return options;
  }


  function simpleSummary(): string {
    if (anchorValue === 'nw') {
      return `This item will stay tied to now and currently resolves to ${formatter.format(editor.resolvedStart)}.`;
    }

    if (anchorValue === 'pr') {
      return `This item is scheduled ${formatParentRelativePlacement()}.`;
    }

    const planRelative = isPlanRelativeAnchor();
    const hasExplicitMinute = Boolean(timeRangeValue.s?.type === 'ba');
    const hasVagueMinute = Boolean(timeRangeValue.s?.type === 'vg');
    const hasRange = Boolean(timeRangeValue.e);
    const hasAnyTime = Boolean(timeRangeValue.s || timeRangeValue.e);
    const scheduleLead = planRelative
      ? `This item is scheduled ${formatPlanRelativePlacement()}`
      : 'This item is scheduled';

    if (!hasAnyTime) {
      return planRelative
        ? `${scheduleLead} as an all-day item.`
        : `${scheduleLead} for ${dateFormatter.format(editor.resolvedStart)} as an all-day item.`;
    }

    if (hasVagueMinute && !hasRange) {
      return planRelative
        ? `${scheduleLead} in a broad time window.`
        : `${scheduleLead} for ${dateFormatter.format(editor.resolvedStart)} in a broad time window.`;
    }

    if (hasRange) {
      return planRelative
        ? `${scheduleLead} from ${timeFormatter.format(editor.resolvedStart)} to ${timeFormatter.format(editor.resolvedEnd)}.`
        : `${scheduleLead} from ${formatter.format(editor.resolvedStart)} to ${formatter.format(editor.resolvedEnd)}.`;
    }

    if (hasExplicitMinute) {
      return planRelative
        ? `${scheduleLead} at ${timeFormatter.format(editor.resolvedStart)}.`
        : `${scheduleLead} for ${dateFormatter.format(editor.resolvedStart)} at ${timeFormatter.format(editor.resolvedStart)}.`;
    }

    return `This item currently resolves to ${formatter.format(editor.resolvedStart)}.`;
  }

  function headerSummary(): string | null {
    if (anchorSelection === 'no-date') {
      return 'No date assigned. This item stays in the tree until you schedule it.';
    }
    return simpleSummary();
  }

  const relevanceChoiceOptions = [
    { value: 'default', label: 'Default' },
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'year', label: 'Year' },
    { value: 'custom', label: 'Custom' },
    { value: 'inf', label: '∞' }
  ] satisfies Array<{ value: RelevanceChoice; label: string }>;

  /** Map a stored bound to the editor's choice + custom duration fields. */
  function boundToChoice(bound: RelevanceBound | undefined): {
    choice: RelevanceChoice;
    value: string;
    unit: DurationUnit;
  } {
    if (!bound) return { choice: 'default', value: '1', unit: 'days' };
    if (bound.type === 'inf') return { choice: 'inf', value: '1', unit: 'days' };
    if (bound.type === 'cal') return { choice: bound.unit, value: '1', unit: 'days' };
    const parts = durationParts(bound.minutes);
    return { choice: 'custom', value: parts.value, unit: parts.unit };
  }

  /** Build a stored bound from the editor's choice + custom duration fields. */
  function choiceToBound(choice: RelevanceChoice, value: string, unit: DurationUnit): RelevanceBound | null {
    if (choice === 'default') return null;
    if (choice === 'inf') return { type: 'inf' };
    if (choice === 'custom') return { type: 'dur', minutes: durationToMinutes(value, unit) };
    return { type: 'cal', unit: choice };
  }

  function durationParts(totalMinutes: number | undefined): { value: string; unit: DurationUnit } {
    const safe = Math.max(0, Math.floor(totalMinutes ?? 0));
    if (safe > 0 && safe % 1440 === 0) return { value: String(safe / 1440), unit: 'days' };
    if (safe > 0 && safe % 60 === 0) return { value: String(safe / 60), unit: 'hours' };
    return { value: String(safe), unit: 'minutes' };
  }

  function durationToMinutes(rawValue: string, unit: DurationUnit): number {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    const rounded = Math.floor(parsed);
    if (unit === 'days') return rounded * 1440;
    if (unit === 'hours') return rounded * 60;
    return rounded;
  }

  function normalizeDisplayAs(next: DateInformation): DisplayAsValue {
    const raw = next.ds;
    if (raw === 'mi') return 'mi';
    if (raw === 'sm') return 'sm';
    if (raw === 'n') return 'n';
    return 'mj';
  }

  function sameRange<VRT extends string>(
    left: StartOrEnd<VRT, number> | undefined,
    right: StartOrEnd<VRT, number> | undefined
  ): boolean {
    return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
  }

  function sameTimeReference(left: TimeReference | undefined, right: TimeReference | undefined): boolean {
    return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
  }

  function applySimpleStackValue(next: TimeReference) {
    simpleStackValue = cloneTimeReference(next);
    const nextDraftValue = cloneTimeReference(next);
    if (sameTimeReference(nextDraftValue, editor.draft.value)) return;
    editor.draft.value = nextDraftValue;
  }

  function sameDatePickerValue(
    left: DatePickerValue,
    right: DatePickerValue
  ): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function cloneDraftForSave(next: DateInformation): DateInformation {
    // Canonical SHORT form only (is / ds / rl / po).
    const window = next.rl;
    const hasWindow = Boolean(window && (window.before || window.after));
    return {
      value: cloneTimeReference(next.value),
      is: Boolean(next.is),
      ...(next.offset_enabled ? { offset_enabled: true } : {}),
      ...(next.ds ? { ds: next.ds } : {}),
      ...(hasWindow ? { rl: structuredClone(window) } : {}),
      ...(next.po ? { po: true } : {})
    };
  }

  function isAnchorOnlyReference(
    value: DateInformation['value'] | undefined,
    anchor: AnchorType
  ): boolean {
    if (!value || anchor === 'nw') return false;
    if (value.y?.e || value.m?.e || value.w?.e || value.d?.e || value.i?.e) return false;
    if (value.i?.s) return false;
    const refs = [value.y?.s, value.m?.s, value.w?.s, value.d?.s].filter(Boolean);
    if (refs.length !== 1) return false;
    const ref = refs[0] as BaseOrVagueReference<string, number>;
    return ref.type === 'of' && ref.a === anchor && Number(ref.v) === 0;
  }

  function hasExplicitOffsetIntent(next: DateInformation, anchor: AnchorType): boolean {
    return Boolean((anchor === 'up' || anchor === 'pr') && next.offset_enabled);
  }

  function setExplicitOffsetIntent(enabled: boolean) {
    if (enabled) {
      if (editor.draft.offset_enabled) return;
      editor.draft.offset_enabled = true;
      return;
    }
    if (!editor.draft.offset_enabled) return;
    delete editor.draft.offset_enabled;
  }

  function applyAnchorWithoutOffset(anchor: 'up' | 'pr') {
    if (anchor === 'up') {
      editor.setAnchorOnly('up');
    } else {
      editor.setAnchorOnly('pr');
    }
    syncLocalStateFromEditor();
  }

  function syncLocalStateFromEditor() {
    anchorValue = editor.anchorType;
    dateAssigned = true;
    if (editor.anchorType === 'up' || editor.anchorType === 'pr') {
      anchorSelection = editor.anchorType;
      offsetEnabled =
        hasExplicitOffsetIntent(editor.draft, editor.anchorType) ||
        !isAnchorOnlyReference(editor.draft.value, editor.anchorType);
    } else {
      offsetEnabled = false;
      if (anchorSelection !== 'up' && anchorSelection !== 'pr') {
        anchorSelection = defaultOffsetSource(allowedAnchors);
      }
    }
    startDatePickerValue = editor.startDatePickerValue;
    endDatePickerValue = editor.endDatePickerValue;
    timeRangeValue = editor.timeRangeValue;
    simpleStackValue = cloneTimeReference(editor.draft.value);
    hasExplicitEnd = editor.hasExplicitEndBoundary;
    displayAsValue = normalizeDisplayAs(editor.draft);

    const window = readRelevanceWindow(editor.draft);
    const before = boundToChoice(window?.before);
    const after = boundToChoice(window?.after);
    relevanceBefore = before.choice;
    beforeCustomValue = before.value;
    beforeCustomUnit = before.unit;
    relevanceAfter = after.choice;
    afterCustomValue = after.value;
    afterCustomUnit = after.unit;

    if (useAnchorOffsetEditor) {
      const offsets = editor.userProvidedDayOffsets;
      startOffsetDirection = offsetDirectionFromDays(offsets.start);
      startOffsetMagnitude = offsetMagnitudeFromDays(offsets.start);
      endOffsetDirection = offsetDirectionFromDays(offsets.end ?? 0);
      endOffsetMagnitude = offsetMagnitudeFromDays(offsets.end ?? 0);
    }

    const parentOffsets = editor.parentDayOffsets;
    parentOffsetDirection = offsetDirectionFromDays(parentOffsets.start);
    parentOffsetMagnitude = offsetMagnitudeFromDays(parentOffsets.start);
    parentEndOffsetDirection = offsetDirectionFromDays(parentOffsets.end ?? 0);
    parentEndOffsetMagnitude = offsetMagnitudeFromDays(parentOffsets.end ?? 0);
  }

  function commit() {
    if (anchorSelection === 'no-date') {
      onSave(null);
      return;
    }
    if (!editor.isValid) return;
    onSave(cloneDraftForSave(editor.draft));
  }

  export function commitFromHost() {
    commit();
  }

  $effect(() => {
    const incomingValue = value;
    const wantsNoDate = allowNoDate && incomingValue === null;
    editor.syncFromProps(incomingValue, now ?? new Date(), resolveContext ?? {});
    untrack(() => {
      syncLocalStateFromEditor();
      if (wantsNoDate) {
        dateAssigned = false;
        anchorSelection = 'no-date';
        offsetEnabled = false;
      }
    });
  });

  $effect(() => {
    const currentAnchor = anchorValue;
    untrack(() => {
      if (anchorSelection === 'no-date') return;
      if (currentAnchor === 'up' || currentAnchor === 'pr') {
        if (!dateAssigned) {
          dateAssigned = true;
        }
        if (anchorSelection !== currentAnchor) {
          anchorSelection = currentAnchor;
        }
      }
    });
  });

  $effect(() => {
    if (!dateAssigned) {
      if (anchorSelection !== 'no-date') {
        anchorSelection = 'no-date';
      }
      if (offsetEnabled) {
        offsetEnabled = false;
      }
      return;
    }
    if (anchorSelection === 'no-date') {
      anchorSelection = defaultOffsetSource(allowedAnchors);
    }
    if (!offsetEnabled) {
      const nextAnchor = anchorSelection === 'pr' ? 'pr' : 'up';
      if (anchorValue !== nextAnchor) {
        anchorValue = nextAnchor;
      }
      return;
    }
    const nextAnchor = anchorSelection === 'pr' ? 'pr' : 'up';
    if (anchorValue !== nextAnchor) {
      anchorValue = nextAnchor;
    }
  });

  $effect(() => {
    if (anchorSelection === 'no-date') {
      if (dateAssigned) {
        dateAssigned = false;
      }
      if (offsetEnabled) {
        offsetEnabled = false;
      }
      return;
    }
    if (!dateAssigned) {
      dateAssigned = true;
    }
    if (anchorSelection !== 'up' && anchorSelection !== 'pr') {
      anchorSelection = defaultOffsetSource(allowedAnchors);
    }
  });

  $effect(() => {
    if (!offsetEnabled && (anchorSelection === 'up' || anchorSelection === 'pr')) {
      if (!isAnchorOnlyReference(editor.draft.value, anchorSelection)) {
        applyAnchorWithoutOffset(anchorSelection);
      }
      setExplicitOffsetIntent(false);
      return;
    }
    if (anchorValue !== editor.anchorType) {
      editor.anchorType = anchorValue;
      if (useAnchorOffsetEditor && anchorValue === 'up') {
        const current = editor.userProvidedDayOffsets;
        editor.setUserProvidedDayOffsets(current.start, hasExplicitEnd ? current.end ?? current.start : null);
      }
      if (anchorValue === 'pr') {
        const current = editor.parentDayOffsets;
        editor.setParentDayOffsets(current.start, hasExplicitEnd ? current.end ?? current.start : null);
      }
      // Preserve offsetEnabled when switching between 'up' and 'pr'
      const wasOffsetEnabled = offsetEnabled;
      syncLocalStateFromEditor();
      if ((anchorSelection === 'up' || anchorSelection === 'pr') && wasOffsetEnabled) {
        offsetEnabled = true;
      }
    }
  });

  $effect(() => {
    if (!useAnchorOffsetEditor) return;
    if (mode === 'simple') return;
    if (editor.anchorType !== 'up') return;
    if (isPlanRelativeAnchor()) return;
    const current = editor.userProvidedDayOffsets;
    editor.setUserProvidedDayOffsets(current.start, hasExplicitEnd ? current.end : null);
    syncLocalStateFromEditor();
  });

  $effect(() => {
    if (editor.anchorType !== 'up') return;
    if (useAnchorOffsetEditor) return;
    if (mode !== 'advanced' && mode !== 'clone') return;
    if (!sameDatePickerValue(startDatePickerValue, editor.startDatePickerValue)) {
      editor.setStartDatePickerValue(startDatePickerValue);
    }
    if (mode === 'advanced' || mode === 'clone') {
      if (!sameDatePickerValue(endDatePickerValue, editor.endDatePickerValue)) {
        editor.setEndDatePickerValue(endDatePickerValue);
      }
    }
  });

  $effect(() => {
    if (editor.anchorType !== 'up') return;
    if (mode !== 'advanced' && mode !== 'clone') return;
    if (!sameRange(timeRangeValue, editor.timeRangeValue)) {
      editor.setTimeRangeValue(timeRangeValue);
    }
  });

  $effect(() => {
    if (!useAnchorOffsetEditor) return;
    if (mode === 'simple') return;
    if (editor.anchorType !== 'up') return;
    const current = editor.userProvidedDayOffsets;
    const nextStart = daysFromOffset(startOffsetDirection, startOffsetMagnitude);
    const nextEnd = hasExplicitEnd ? daysFromOffset(endOffsetDirection, endOffsetMagnitude) : null;
    if (current.start === nextStart && current.end === nextEnd) return;
    editor.setUserProvidedDayOffsets(nextStart, nextEnd);
  });

  $effect(() => {
    if (mode === 'simple') return;
    if (editor.anchorType !== 'pr') return;
    const current = editor.parentDayOffsets;
    const nextStart = daysFromOffset(parentOffsetDirection, parentOffsetMagnitude);
    const nextEnd = hasExplicitEnd ? daysFromOffset(parentEndOffsetDirection, parentEndOffsetMagnitude) : null;
    if (current.start === nextStart && current.end === nextEnd) return;
    editor.setParentDayOffsets(nextStart, nextEnd);
  });

  $effect(() => {
    if (anchorSelection === 'no-date') {
      setExplicitOffsetIntent(false);
      return;
    }
    if (editor.anchorType !== 'up' && editor.anchorType !== 'pr') {
      setExplicitOffsetIntent(false);
      return;
    }
    setExplicitOffsetIntent(offsetEnabled);
  });


  $effect(() => {
    if (editor.anchorType !== 'up') return;
    if (mode !== 'advanced' && mode !== 'clone') return;
    editor.setHasExplicitEnd(hasExplicitEnd);
    if (!hasExplicitEnd) {
      if (!sameDatePickerValue(endDatePickerValue, editor.endDatePickerValue)) {
        endDatePickerValue = editor.endDatePickerValue;
      }
      if (!sameRange(timeRangeValue, editor.timeRangeValue)) {
        timeRangeValue = editor.timeRangeValue;
      }
    }
  });

  $effect(() => {
    if (mode !== 'simple') return;
    if (editor.anchorType !== 'up' && editor.anchorType !== 'pr') return;
    editor.setHasExplicitEnd(hasExplicitEnd);
    if (!sameTimeReference(simpleStackValue, editor.draft.value)) {
      simpleStackValue = cloneTimeReference(editor.draft.value);
    }
  });

  $effect(() => {
    const before = choiceToBound(relevanceBefore, beforeCustomValue, beforeCustomUnit);
    const after = choiceToBound(relevanceAfter, afterCustomValue, afterCustomUnit);

    if (!before && !after) {
      delete editor.draft.rl;
      return;
    }

    const window: RelevanceWindow = {
      ...(before ? { before } : {}),
      ...(after ? { after } : {})
    };
    editor.draft.rl = window;
  });

  $effect(() => {
    editor.draft.ds = displayAsValue;
  });

  $effect(() => {
    onSummaryChange?.(headerSummary());
  });

  $effect(() => {
    onDraftChange?.(editor.draft);
  });
</script>

<div class="flex flex-col gap-6">
  {#if mode === 'clone'}
    <div class="rounded-[var(--radius-md)] bg-[var(--color-info)]/10 p-3 text-[var(--text-sm)] text-[var(--color-info)]">
      Editing a clone of the parent's date. Changes do not affect the parent.
    </div>
  {/if}

  {#if mode !== 'radar-only'}
    <div class="flex flex-col gap-3">
      <Checkbox bind:checked={dateAssigned}>
        Date assigned
      </Checkbox>
      {#if dateAssigned}
        <div class="flex flex-col gap-2">
          <div class="text-[var(--text-xsm)] font-medium text-[var(--color-muted-foreground)] uppercase tracking-wider">
            Relative to
          </div>
          <SegmentedControl
            options={primaryAnchorOptions(allowedAnchors, false)
              .filter((option) => option.value !== 'no-date')
              .map((option) => ({ value: option.value, label: option.label }))}
            bind:value={anchorSelection}
            ariaLabel="Relative to"
            fullWidth
          />
          <Checkbox bind:checked={offsetEnabled}>
            Use offset
          </Checkbox>
        </div>
      {/if}
    </div>
  {/if}

  {#if anchorSelection !== 'no-date' && offsetEnabled && (editor.anchorType === 'up' || editor.anchorType === 'pr') && mode !== 'radar-only'}
    {@const anchorLabel = editor.anchorType === 'pr' ? 'parent' : anchorOffsetLabel}
    <div class="flex flex-col gap-4 py-2">
      {#if mode === 'advanced' || mode === 'clone'}
        <div class="space-y-4">
          <div class="space-y-3">
            {#if useAnchorOffsetEditor}
              <div class="grid gap-3 md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] md:items-end">
                <NumberInput
                  value={startMagnitude}
                  onchange={setStartMagnitude}
                  min={0}
                  max={3650}
                  step={1}
                  class="w-full"
                />
                <SegmentedControl
                  options={offsetDirectionOptions}
                  value={startDirection}
                  onValueChange={(value) => setStartDirection(value as OffsetDirection)}
                  ariaLabel="Start offset direction"
                  fullWidth
                />
              </div>
            {:else}
              <DatePicker
                bind:value={startDatePickerValue}
                side="start"
              />
            {/if}
          </div>

          <Checkbox bind:checked={hasExplicitEnd} hint="When disabled, the end boundary resolves to the start boundary.">
            Different end
          </Checkbox>

          {#if hasExplicitEnd}
            <div class="space-y-3">
              {#if useAnchorOffsetEditor}
                <div class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Choose where this ends relative to the {anchorLabel}.
                </div>
                <div class="grid gap-3 md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] md:items-end">
                  <NumberInput
                    value={endMagnitude}
                    onchange={setEndMagnitude}
                    min={0}
                    max={3650}
                    step={1}
                    class="w-full"
                  />
                  <SegmentedControl
                    options={offsetDirectionOptions}
                    value={endDirection}
                    onValueChange={(value) => setEndDirection(value as OffsetDirection)}
                    ariaLabel="End offset direction"
                    fullWidth
                  />
                </div>
              {:else}
                <DatePicker
                  bind:value={endDatePickerValue}
                  side="end"
                />
              {/if}
            </div>
          {/if}

          <div class="space-y-3">
            <TimeRangePicker bind:value={timeRangeValue} />
          </div>
        </div>
      {:else}
        <div class="space-y-4">
          <div class="space-y-3">
            <TimeStackBuilder
              bind:value={simpleStackValue}
              anchor={editor.anchorType === 'pr' ? 'pr' : 'up'}
              side="start"
              onValueChange={applySimpleStackValue}
            />
          </div>

          <Checkbox bind:checked={hasExplicitEnd}>
            Use end value
          </Checkbox>

          {#if hasExplicitEnd}
            <div class="space-y-3">
              <TimeStackBuilder
                bind:value={simpleStackValue}
                anchor={editor.anchorType === 'pr' ? 'pr' : 'up'}
                side="end"
                onValueChange={applySimpleStackValue}
              />
            </div>
          {/if}

          <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]" class:is-open={simpleAdvancedExpanded}>
            <button
              type="button"
              class="w-full text-left cursor-pointer list-none px-4 py-3 text-[var(--text-sm)] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] rounded-[var(--radius-md)]"
              aria-expanded={simpleAdvancedExpanded}
              onclick={() => simpleAdvancedExpanded = !simpleAdvancedExpanded}
            >
              More options
            </button>
            {#if simpleAdvancedExpanded}
              <div class="flex flex-col gap-4 border-t border-[var(--color-border)] px-4 py-4">
                <div class="flex flex-col gap-2">
                  <div class="text-[var(--text-sm)] font-medium">Display As</div>
                  <RadioGroup
                    options={displayAsOptions}
                    bind:value={displayAsValue}
                  />
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if anchorSelection !== 'no-date' && offsetEnabled && useAnchorOffsetEditor && (editor.anchorType === 'up' || editor.anchorType === 'pr') && mode !== 'simple' && mode !== 'radar-only'}
    <div class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
      {#if editor.anchorType === 'up'}
        Preview with current {anchorOffsetLabel}: {formatter.format(editor.resolvedStart)}
      {:else}
        Preview relative to parent: {formatter.format(editor.resolvedStart)}
      {/if}
      {#if hasExplicitEnd}
        {' '}to {formatter.format(editor.resolvedEnd)}
      {/if}
    </div>
  {/if}

  {#if anchorSelection !== 'no-date' && offsetEnabled && (mode === 'advanced' || mode === 'clone' || mode === 'radar-only')}
    <div class="flex flex-col gap-2">
      <div class="text-[var(--text-sm)] font-medium">Display As</div>
      <RadioGroup
        options={displayAsOptions}
        bind:value={displayAsValue}
      />
    </div>
  {/if}

  {#snippet relevanceControls()}
    <div class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
      Control how early this item surfaces (<strong>before</strong>) and how long it lingers once due (<strong>after</strong>). “Default” inherits the planner's window; the period options snap to the calendar day/week/month/year of the date.
    </div>

    <div class="space-y-2">
      <div class="text-[var(--text-sm)] font-medium">Before — surface early</div>
      <SegmentedControl
        bind:value={relevanceBefore}
        options={relevanceChoiceOptions}
        ariaLabel="Before relevance window"
        fullWidth
      />
      {#if relevanceBefore === 'custom'}
        <div class="grid gap-3 md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] md:items-end">
          <NumberInput bind:value={beforeCustomValue} min={0} step={1} class="w-full" />
          <Select bind:value={beforeCustomUnit} options={durationOptions} ariaLabel="Before window unit" />
        </div>
      {/if}
    </div>

    <div class="space-y-2">
      <div class="text-[var(--text-sm)] font-medium">After — linger past due</div>
      <SegmentedControl
        bind:value={relevanceAfter}
        options={relevanceChoiceOptions}
        ariaLabel="After relevance window"
        fullWidth
      />
      {#if relevanceAfter === 'custom'}
        <div class="grid gap-3 md:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] md:items-end">
          <NumberInput bind:value={afterCustomValue} min={0} step={1} class="w-full" />
          <Select bind:value={afterCustomUnit} options={durationOptions} ariaLabel="After window unit" />
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2">
      <Checkbox bind:checked={editor.draft.po} hint="Pins the item at the top once its scheduled time passes, regardless of the after window.">
        Keep pinned if overdue
      </Checkbox>
    </div>
  {/snippet}

  {#if anchorSelection !== 'no-date' && offsetEnabled && mode === 'simple'}
    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]" class:is-open={visibilityExpanded}>
      <button
        type="button"
        class="w-full text-left cursor-pointer list-none px-4 py-3 text-[var(--text-sm)] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] rounded-[var(--radius-md)]"
        aria-expanded={visibilityExpanded}
        onclick={() => visibilityExpanded = !visibilityExpanded}
      >
        Visibility around this date
      </button>
      {#if visibilityExpanded}
        <div class="flex flex-col gap-4 border-t border-[var(--color-border)] px-4 py-4">
          {@render relevanceControls()}
        </div>
      {/if}
    </div>
  {:else if anchorSelection !== 'no-date'}
    <div class="flex flex-col gap-4 py-2">
      <div class="text-[var(--text-sm)] font-medium">Visibility / Relevance (Radar)</div>
      {@render relevanceControls()}
    </div>
  {/if}

  {#if !hideActions}
    <div class="sticky bottom-0 z-[var(--z-sticky)] flex justify-end gap-3 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel),var(--color-background)_10%)] px-4 py-3 shadow-[0_-12px_24px_-18px_rgba(0,0,0,0.7)] supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--color-panel),transparent_6%)] supports-[backdrop-filter]:backdrop-blur">
      <Button variant="ghost" onclick={onCancel}>{cancelLabel}</Button>
      <Button
        variant="secondary"
        onclick={commit}
        disabled={anchorSelection !== 'no-date' && offsetEnabled && !editor.isValid}
        class={anchorSelection !== 'no-date' && offsetEnabled && !editor.isValid
          ? 'border border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)] opacity-100'
          : 'border-[color-mix(in_srgb,var(--color-primary),var(--color-border)_55%)] bg-[color-mix(in_srgb,var(--color-primary),var(--color-panel)_84%)] text-[var(--color-foreground)] hover:bg-[color-mix(in_srgb,var(--color-primary),var(--color-panel)_78%)]'}
      >
        {saveLabel}
      </Button>
    </div>
  {/if}
</div>
