<script module lang="ts">
  const demoDateFormatter = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import FileText from '@lucide/svelte/icons/file-text';
import PanelLeft from '@lucide/svelte/icons/panel-left';
import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
import Plus from '@lucide/svelte/icons/plus';
import X from '@lucide/svelte/icons/x';
  import type { BaseOrVagueReference, DateInformation, ResolveContext, TimeReference, VagueMinuteCode, WeekModeCode } from '@shared-packages/ui/date';
  import { formatTimeReferenceRangeLabel } from '@shared-packages/ui/date';
  import { Badge, Button, Checkbox, DateAnchorEditor, DatePicker, DateRangeCalendar, DateRangePicker, Label, MobileBottomTray, NumberInput, Pagination, QuickAddDateTimePopover, RadioGroup, ResizableSidePanel, SegmentedControl, Select, TimePicker, TimeReferenceRangeEditor, type DatePickerValue, type DateRangeValue } from '@shared-packages/ui';
  import IconDay from '../icons/IconDay.svelte';
  import IconWeek from '../icons/IconWeek.svelte';
  import IconMonth from '../icons/IconMonth.svelte';
  import IconYear from '../icons/IconYear.svelte';

  let { data }: { data: { segments?: string[] } } = $props();

  const pages = [
    {
      id: 'input-controls',
      title: 'Input Controls',
      summary: 'Reusable field controls for preference pickers and compact settings panels.',
      items: [
        {
          id: 'checkbox',
          title: 'Checkbox',
          href: '/module/component-library/input-controls/checkbox'
        },
        {
          id: 'radio-group',
          title: 'Radio Group',
          href: '/module/component-library/input-controls/radio-group'
        },
        {
          id: 'select',
          title: 'Select',
          href: '/module/component-library/input-controls/select'
        },
        {
          id: 'number-input',
          title: 'Number Input',
          href: '/module/component-library/input-controls/number-input'
        },
        {
          id: 'time-picker',
          title: 'Time Picker',
          href: '/module/component-library/input-controls/time-picker'
        },
        {
          id: 'segmented-control',
          title: 'Segmented Control',
          href: '/module/component-library/input-controls/segmented-control'
        },
        {
          id: 'pagination',
          title: 'Pagination',
          href: '/module/component-library/input-controls/pagination'
        }
      ]
    },
    {
      id: 'layout-panels',
      title: 'Layout Panels',
      summary: 'Resizable side-panel primitives for detail panes, inspectors, and split workspaces.',
      items: [
        {
          id: 'resizable-side-panel',
          title: 'Resizable Side Panel',
          href: '/module/component-library/layout-panels/resizable-side-panel'
        },
        {
          id: 'mobile-bottom-tray',
          title: 'Mobile Bottom Tray',
          href: '/module/component-library/layout-panels/mobile-bottom-tray'
        }
      ]
    },
    {
      id: 'calendar-related',
      title: 'Calendar Related',
      summary: 'Calendar components and grid-based scheduling primitives.',
      items: [
        {
          id: 'date-range-picker',
          title: 'Date Range Picker',
          href: '/module/component-library/calendar-related/date-range-picker'
        },
        {
          id: 'date-picker',
          title: 'Date Picker',
          href: '/module/component-library/calendar-related/date-picker'
        },
        {
          id: 'date-anchor-editor',
          title: 'Date Anchor Editor',
          href: '/module/component-library/calendar-related/date-anchor-editor'
        },
        {
          id: 'time-reference-range-editor',
          title: 'Time Reference Range Editor',
          href: '/module/component-library/calendar-related/time-reference-range-editor'
        },
        {
          id: 'quick-add-date-time-popover',
          title: 'Quick Add Date/Time Popover',
          href: '/module/component-library/calendar-related/quick-add-date-time-popover'
        }
      ]
    }
  ];
  const calendarRelatedItems = pages.find((entry) => entry.id === 'calendar-related')?.items ?? [];
  const inputControlItems = pages.find((entry) => entry.id === 'input-controls')?.items ?? [];
  const layoutPanelItems = pages.find((entry) => entry.id === 'layout-panels')?.items ?? [];

  const baseHref = '/module/component-library';
  const currentSegments = $derived(data.segments ?? []);
  const currentGroupId = $derived(currentSegments[0] ?? null);
  const currentItemId = $derived(currentSegments[1] ?? null);
  const currentPage = $derived(currentGroupId ? pages.find((entry) => entry.id === currentGroupId) ?? null : null);
  const currentItem = $derived(currentPage && currentItemId ? currentPage.items.find((entry) => entry.id === currentItemId) ?? null : null);
  let expandedGroups = $state(new Set<string>([pages[0].id]));
  let desktopTreeHidden = $state(false);
  let mobileTreeOpen = $state(false);
  const visibleExpandedGroups = $derived.by(() => {
    const next = new Set(expandedGroups);
    if (currentPage?.id) {
      next.add(currentPage.id);
    }
    return next;
  });

  function toggleGroup(id: string) {
    const next = new Set(expandedGroups);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedGroups = next;
  }

  function toggleDesktopTree() {
    desktopTreeHidden = !desktopTreeHidden;
  }

  function openMobileTree() {
    mobileTreeOpen = true;
  }

  function closeMobileTree() {
    mobileTreeOpen = false;
  }

  let firstDayOfWeek = $state(1);
  let rangeValue = $state<DateRangeValue>({
    start: new Date(2026, 3, 8),
    end: new Date(2026, 3, 12)
  });
  let rangeCalendarDate = $state({ year: 2026, month: 4, day: 1 });
  let rangeFirstDayOfWeek = $state(1);
  let rangeInfinite = $state(true);
  let rangeShowMonthOutline = $state(false);
  let rangeSimpleCellMode = $state(true);
  let rangeDualMonth = $state(false);
  let rangeAllowVague = $state(true);
  let rangeVagueYear = $state<string | null>(null);
  let rangeVagueMonth = $state<string | null>(null);
  let rangeVagueDay = $state<string | null>(null);
  let rangeExactYear = $state<number | null>(null);
  let rangeExactMonth = $state<number | null>(null);
  let rangeExactDay = $state<number | null>(null);
  let rangeExactWeek = $state<number | null>(null);
  let rangeWeekMode = $state<WeekModeCode>('ord');
  let rangeWeekStart = $state(1);
  let datePickerValue = $state<DatePickerValue>({
    y: { type: 'ba', v: 2026 },
    m: { type: 'ba', v: 4 },
    d: { type: 'ba', v: 15 }
  });
  let progressiveDatePickerValue = $state<DatePickerValue>({
    y: { type: 'ba', v: 2026 },
    m: { type: 'ba', v: 5 },
    d: { type: 'vg', t: 'sh' }
  });

  function formatDemoDateRange(range: DateRangeValue) {
    if (!range.start) return 'Pick a date range';
    if (!range.end || range.start.getTime() === range.end.getTime()) {
      return demoDateFormatter.format(range.start);
    }
    return demoDateFormatter.formatRange(range.start, range.end);
  }

  const rangeSelectionSummary = $derived.by(() => {
    if (rangeExactWeek !== null) {
      const weekType = rangeWeekMode === 'iso' ? 'ISO' : rangeWeekMode === 'row' ? 'Row' : 'Abstract';
      return `Week ${rangeExactWeek} (${weekType})${rangeExactYear ? `, ${rangeExactYear}` : ''}`;
    }
    if (rangeExactDay !== null && rangeExactMonth === null) {
      return `Day ${rangeExactDay}${rangeExactYear ? `, ${rangeExactYear}` : ''}`;
    }
    if (rangeVagueYear || rangeVagueMonth || rangeVagueDay) {
      return [rangeVagueDay, rangeVagueMonth, rangeVagueYear].filter(Boolean).map((part) => String(part).toUpperCase()).join(' / ');
    }
    return formatDemoDateRange(rangeValue);
  });
  const dateAnchorResolveContext: ResolveContext = {
    userProvided: new Date(2026, 3, 15, 9, 0),
    parentResolved: new Date(2026, 3, 12, 8, 30)
  };
  let dateAnchorSimpleValue = $state<DateInformation>({
    value: {
      y: { s: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 } },
      d: { s: { type: 'ba', v: 15 } },
      i: { s: { type: 'vg', t: 'mo' } }
    },
    is: false,
    rl: { before: { type: 'dur', minutes: 1440 }, after: { type: 'dur', minutes: 1440 } }
  });
  let dateAnchorAdvancedValue = $state<DateInformation>({
    value: {
      y: { s: { type: 'ba', v: 2026 }, e: { type: 'ba', v: 2026 } },
      m: { s: { type: 'ba', v: 4 }, e: { type: 'ba', v: 4 } },
      d: { s: { type: 'vg', t: 'em' }, e: { type: 'vg', t: 'lm' } },
      i: { s: { type: 'vg', t: 'mo' }, e: { type: 'ba', v: 17 * 60 + 30 } }
    },
    is: true,
    ds: 'mi',
    rl: { before: { type: 'dur', minutes: 4320 }, after: { type: 'dur', minutes: 4320 } },
    po: true
  });
  let dateAnchorRadarValue = $state<DateInformation>({
    value: {},
    is: false,
    ds: 'mj',
    rl: { before: { type: 'dur', minutes: 240 }, after: { type: 'dur', minutes: 240 } },
    po: true
  });
  let dateAnchorCloneValue = $state<DateInformation>({
    value: {
      y: { s: { type: 'ba', v: 2026 }, e: { type: 'ba', v: 2026 } },
      m: { s: { type: 'vg', t: 'q2' }, e: { type: 'vg', t: 'q3' } },
      d: { s: { type: 'vg', t: 'fh' }, e: { type: 'vg', t: 'sh' } },
      i: { s: { type: 'vg', t: 'af' }, e: { type: 'vg', t: 'ev' } }
    },
    is: false,
    ds: 'sm',
    rl: { before: { type: 'dur', minutes: 10080 }, after: { type: 'dur', minutes: 10080 } }
  });
  let checkboxChecked = $state(true);
  let checkboxIndeterminate = $state(false);
  let displayAsValue = $state<'ma' | 'mi' | 'mn' | 'no'>('ma');
  let durationUnit = $state<string | number>('day');
  let durationValue = $state('3');
  let timePickerValue = $state<BaseOrVagueReference<VagueMinuteCode, number> | null>({ type: 'vg', t: 'mo' });
  let timePickerFormat = $state<'12h' | '24h'>('12h');
  let timePickerSide = $state<'start' | 'end'>('start');
  let visualClockMinutes = $state(540);
  let visualClockFormat = $state<'12h' | '24h'>('12h');
  let hourMinuteMinutes = $state(540);
  let hourMinuteFormat = $state<'12h' | '24h'>('12h');
  let paginationPage = $state(3);
  let paginationPageSize = $state(12);
  let demoOverlayPanelWidth = $state(352);
  let demoOverlayPanelResizing = $state(false);
  let demoDividerPanelWidth = $state(320);
  let demoDividerPanelResizing = $state(false);
  let demoMobileTrayHeight = $state(320);
  let demoMobileTrayCollapsed = $state(true);
  let demoMobileTrayResizing = $state(false);

  // TimeReferenceRangeEditor demo states
  let treDateOnly = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 13 } }
  });
  let treDatePlusExactTime = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 13 } },
    i: { s: { type: 'ba', v: 540 } }
  });
  let treDatePlusVagueTime = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 13 } },
    i: { s: { type: 'vg', t: 'mo' } }
  });
  let treSameDayTimeRange = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 13 } },
    i: { s: { type: 'ba', v: 540 }, e: { type: 'ba', v: 630 } }
  });
  let treMultiDayRange = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 13 }, e: { type: 'ba', v: 15 } }
  });
  let treVagueMonth = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'vg', t: 'sh' } }
  });
  let treVagueDay = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'vg', t: 'sh' } }
  });
  let treInvalid = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'vg', t: 'sh' } },
    d: { s: { type: 'ba', v: 15 } },
    i: { s: { type: 'ba', v: 840 } }
  });
  let treCompact = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 14 } }
  });
  let quickAddPopupOpen = $state(false);
  let quickAddPopupValue = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 14 } },
    i: { s: { type: 'vg', t: 'mo' }, e: { type: 'ba', v: 11 * 60 } }
  });
  let quickAddLivePopupOpen = $state(false);
  let quickAddLivePopupValue = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 } },
    m: { s: { type: 'vg', t: 'q2' } }
  });
  let quickAddRangePopupOpen = $state(false);
  let quickAddRangePopupValue = $state<TimeReference>({
    y: { s: { type: 'ba', v: 2026 }, e: { type: 'ba', v: 2026 } },
    m: { s: { type: 'ba', v: 5 }, e: { type: 'ba', v: 5 } },
    d: { s: { type: 'ba', v: 16 }, e: { type: 'ba', v: 17 } }
  });

  const paginationTotalItems = 137;
  const paginationDemoItems = Array.from({ length: paginationTotalItems }, (_, index) => ({
    id: `records:demo-${index + 1}`,
    title: `Demo record ${index + 1}`
  }));
  let paginationVisibleItems = $derived.by(() => {
    const start = (paginationPage - 1) * paginationPageSize;
    return paginationDemoItems.slice(start, start + paginationPageSize);
  });

  const weekdayOptions = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' }
  ];
  const displayAsOptions = [
    { value: 'ma', label: 'Major', hint: 'High-visibility schedule item.' },
    { value: 'mi', label: 'Minor', hint: 'Secondary status treatment.' },
    { value: 'mn', label: 'Mini', hint: 'Compact low-noise display.' },
    { value: 'no', label: 'None', hint: 'Do not surface in calendar cards.' }
  ];
  const durationUnitOptions = [
    { value: 'minute', label: 'Minutes', hint: 'Short relevance window.' },
    { value: 'hour', label: 'Hours', hint: 'Useful for same-day planning.' },
    { value: 'day', label: 'Days', hint: 'Default for broad scheduling.' }
  ];
</script>

<div class="library-shell h-full min-h-0 w-full overflow-hidden bg-transparent px-1.5 py-1.5 md:px-2 md:py-2 text-foreground">
  {#if mobileTreeOpen}
    <button
      type="button"
      class="library-mobile-backdrop"
      aria-label="Close component tree"
      onclick={closeMobileTree}
    ></button>
  {/if}

  <div class={`library-layout ${desktopTreeHidden ? 'library-layout--tree-hidden' : ''}`}>
    <aside class={`library-tree-panel ${mobileTreeOpen ? 'library-tree-panel--mobile-open' : ''}`}>
      <div class="space-y-5">
        <div class="flex justify-end md:hidden">
          <button
            type="button"
            class="library-mobile-close"
            aria-label="Close component tree"
            onclick={closeMobileTree}
          >
            <X class="size-4" />
          </button>
        </div>

        <nav aria-label="Component library tree">
          <ul class="space-y-2" role="tree">
          {#each pages as entry}
            <li role="treeitem" aria-expanded={visibleExpandedGroups.has(entry.id)} aria-selected={currentPage?.id === entry.id} class="space-y-1">
              <div
                class={`rounded-[var(--radius-md)] px-2 py-2 transition ${
                  currentPage?.id === entry.id
                    ? 'bg-[var(--color-primary)]/8'
                    : ''
                }`}
              >
                <button
                  class="flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-left hover:bg-[var(--color-muted)]"
                  onclick={() => toggleGroup(entry.id)}
                  aria-expanded={visibleExpandedGroups.has(entry.id)}
                >
                  {#if visibleExpandedGroups.has(entry.id)}
                    <ChevronDown class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  {:else}
                    <ChevronRight class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <a
                      href={`${baseHref}/${entry.id}`}
                      class="block text-[var(--text-sm)] font-semibold hover:underline"
                      onclick={(event) => event.stopPropagation()}
                    >
                      {entry.title}
                    </a>
                    <p class="mt-1 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">{entry.summary}</p>
                  </div>
                </button>
              </div>

              {#if visibleExpandedGroups.has(entry.id)}
                <ul class="ml-4 space-y-1 border-l border-[var(--color-border)] pl-3" role="group">
                  {#each entry.items as item}
                    <li role="treeitem" aria-selected={currentItem?.id === item.id}>
                      <a
                        href={item.href}
                        class={`flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xsm)] transition ${
                          currentItem?.id === item.id
                            ? 'bg-[var(--color-primary)]/10 text-[var(--color-foreground)]'
                            : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                        }`}
                      >
                        <FileText class="size-3.5 shrink-0" />
                        <span>{item.title}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
          </ul>
        </nav>
      </div>
    </aside>

    <section class="library-content-panel">
      <div class="library-content-toolbar">
        <button
          type="button"
          class="library-toolbar-btn library-toolbar-btn--mobile"
          onclick={openMobileTree}
        >
          <PanelLeft class="size-4" />
          <span>Browse Pages</span>
        </button>

        <button
          type="button"
          class="library-toolbar-btn library-toolbar-btn--desktop"
          onclick={toggleDesktopTree}
        >
          {#if desktopTreeHidden}
            <PanelLeft class="size-4" />
            <span>Show Tree</span>
          {:else}
            <PanelLeftClose class="size-4" />
            <span>Hide Tree</span>
          {/if}
        </button>
      </div>



      {#if currentGroupId === 'calendar-related' && !currentItemId}
        <div class="space-y-6">
          <div>
            <div class="space-y-3">
              <h2 class="text-3xl font-semibold tracking-tight">Calendar Related</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Calendar renderers and grid primitives live in this section. Use this page as the index for all
                calendar-related component entries.
              </p>
            </div>
          </div>

          <div class="space-y-3">
            {#each calendarRelatedItems as item}
              <a
                href={item.href}
                class="block rounded-[var(--radius-lg)] border border-transparent bg-transparent p-5 transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5"
              >
                <div class="flex items-start gap-3">
                  <FileText class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  <div class="min-w-0">
                    <p class="text-[var(--text-base)] font-semibold">{item.title}</p>
                    <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                      {item.id === 'calendar-views'
                        ? 'Month grid and vertical day/week timeline renderers for reusable calendar layouts.'
                        : item.id === 'date-range-picker'
                          ? 'Popup range picker and embedded infinite month selector for start/end date picking.'
                          : item.id === 'date-picker'
                            ? 'Single-date exact/vague picker for day, month, and broad range semantics.'
                            : item.id === 'date-anchor-editor'
                              ? 'Full date-authoring surface for anchors, display mode, relevance, and clone flows.'
                              : item.id === 'time-reference-range-editor'
                                ? 'Structured TimeReference editor for date ranges, times, and vague fields.'
                                : 'Styled quick-add popup shell combining trigger pills, presets, and the TimeReference editor.'}
                    </p>
                  </div>
                </div>
              </a>
            {/each}
          </div>
        </div>
      {/if}



      {#if currentGroupId === 'calendar-related' && currentItem?.id === 'date-range-picker'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Date Range Picker</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Reusable start/end date picker built on the same infinite month-scroll model as the calendar route,
                with a popup trigger and an embedded calendar variant for direct composition.
              </p>
            </div>
          </div>

          <div>
            <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <div class="space-y-2">
                <Label>Start of Week</Label>
                <SegmentedControl
                  ariaLabel="Range picker start of week"
                  options={weekdayOptions}
                  bind:value={rangeFirstDayOfWeek}
                  class="max-w-[22rem]"
                />
              </div>
              <Checkbox bind:checked={rangeInfinite} labelClass="text-[var(--text-sm)] font-normal text-[var(--color-foreground)]">
                Use infinite month scroll
              </Checkbox>
              <Checkbox bind:checked={rangeSimpleCellMode} labelClass="text-[var(--text-sm)] font-normal text-[var(--color-foreground)]">
                Use simple day cell
              </Checkbox>
              <Checkbox bind:checked={rangeShowMonthOutline} labelClass="text-[var(--text-sm)] font-normal text-[var(--color-foreground)]">
                Show month svg outline
              </Checkbox>
              <Checkbox bind:checked={rangeDualMonth} labelClass="text-[var(--text-sm)] font-normal text-[var(--color-foreground)]">
                Show dual months side-by-side (Dual Month Mode)
              </Checkbox>
              <Checkbox bind:checked={rangeAllowVague} labelClass="text-[var(--text-sm)] font-normal text-[var(--color-foreground)]">
                Allow approximate/vague dates selection
              </Checkbox>
            </div>
          </div>

          <div>
            <div class="flex flex-wrap items-center justify-center gap-3 text-center">
              <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Selected range</span>
              <span class="text-[var(--text-lg)] font-semibold text-[var(--color-foreground)]">{rangeSelectionSummary}</span>
            </div>
          </div>

          <div>
            <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div class="space-y-1.5">
                <p class="text-[var(--text-lg)] font-semibold">Popup Picker</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Trigger-style range selector for quick-add flows and compact forms.
                </p>
              </div>
              <div class="justify-self-start md:justify-self-end">
                <DateRangePicker
                  bind:value={rangeValue}
                  bind:vagueYear={rangeVagueYear}
                  bind:vagueMonth={rangeVagueMonth}
                  bind:vagueDay={rangeVagueDay}
                  bind:exactYear={rangeExactYear}
                  bind:exactMonth={rangeExactMonth}
                  bind:exactDay={rangeExactDay}
                  bind:exactWeek={rangeExactWeek}
                  bind:weekMode={rangeWeekMode}
                  bind:weekStart={rangeWeekStart}
                  showValue={false}
                  allowVague={rangeAllowVague}
                  firstDayOfWeek={rangeFirstDayOfWeek}
                  infiniteScrollEnabled={rangeInfinite}
                  simpleCellMode={rangeSimpleCellMode}
                  showMonthOutline={rangeShowMonthOutline}
                  dualMonth={rangeDualMonth}
                />
              </div>
            </div>
          </div>

          <div class="grid gap-3">
            <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div class="space-y-1.5">
                <p class="text-[var(--text-lg)] font-semibold">Embedded Calendar</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Direct component use for modal or drawer flows that want the raw range calendar surface.
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge variant="success">Calendar UI</Badge>
              </div>
            </div>

            <div class="overflow-hidden flex flex-col">
            <div class="flex min-h-0 flex-col overflow-hidden p-6" style={rangeDualMonth ? 'height: 26rem; max-height: 26rem;' : 'height: 22rem; max-height: 22rem;'}>
              <DateRangeCalendar
                bind:value={rangeValue}
                bind:viewing_date={rangeCalendarDate}
                bind:vagueYear={rangeVagueYear}
                bind:vagueMonth={rangeVagueMonth}
                bind:vagueDay={rangeVagueDay}
                bind:exactYear={rangeExactYear}
                bind:exactMonth={rangeExactMonth}
                bind:exactDay={rangeExactDay}
                bind:exactWeek={rangeExactWeek}
                bind:weekMode={rangeWeekMode}
                bind:weekStart={rangeWeekStart}
                allowVague={rangeAllowVague}
                firstDayOfWeek={rangeFirstDayOfWeek}
                rows={2}
                infiniteScrollEnabled={rangeInfinite}
                bufferRows={6}
                minCellHeight={24}
                maxCellHeight={32}
                showMonthOutline={rangeShowMonthOutline}
                showFooter={false}
                simpleCellMode={rangeSimpleCellMode}
                dualMonth={rangeDualMonth}
                class="flex-1 h-full max-h-full min-h-0 w-full"
              />
            </div>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'calendar-related' && currentItem?.id === 'date-picker'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Date Picker</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Shared single-date picker with exact dates and progressive vague precision. Vague month terminates day/time; vague day terminates time.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Anchor-aware date picking</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                This foundation keeps the year stable while switching among exact selection, vague days within a month, and vague month groupings.
              </p>
            </div>

            <div class="max-w-4xl">
              <DatePicker bind:value={datePickerValue} anchorYear={2026} side="start" />
            </div>

            <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(datePickerValue, null, 2)}</pre>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Progressive precision builder</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Month precision is selected before day precision, so a vague month naturally hides lower date layers.
              </p>
            </div>

            <div class="max-w-4xl">
              <DatePicker bind:value={progressiveDatePickerValue} anchorYear={2026} side="start" layout="progressive" compactCalendar />
            </div>

            <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(progressiveDatePickerValue, null, 2)}</pre>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'calendar-related' && currentItem?.id === 'date-anchor-editor'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Date Anchor Editor</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Shared date authoring surface for simple, advanced, radar-only, and clone workflows.
              </p>
            </div>
          </div>

          <div class="space-y-4">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Simple mode</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Minimal end-user flow for picking an anchor, date, time, and radar settings.
              </p>
            </div>
            <DateAnchorEditor
              mode="simple"
              value={dateAnchorSimpleValue}
              resolveContext={dateAnchorResolveContext}
              now={new Date(2026, 3, 15, 9, 0)}
              onSave={(next) => { if (next) dateAnchorSimpleValue = next; }}
              onCancel={() => {}}
            />
            <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(dateAnchorSimpleValue, null, 2)}</pre>
          </div>

          <div class="space-y-4">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Advanced mode</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Full start/end editing with exact and vague date fields, minute ranges, display-as, and radar controls.
              </p>
            </div>
            <DateAnchorEditor
              mode="advanced"
              value={dateAnchorAdvancedValue}
              resolveContext={dateAnchorResolveContext}
              now={new Date(2026, 3, 15, 9, 0)}
              onSave={(next) => { if (next) dateAnchorAdvancedValue = next; }}
              onCancel={() => {}}
            />
            <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(dateAnchorAdvancedValue, null, 2)}</pre>
          </div>

          <div class="grid gap-6 xl:grid-cols-2">
            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Radar-only mode</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Exec-style surface for relevance and display tuning without touching the anchor itself.
                </p>
              </div>
              <DateAnchorEditor
                mode="radar-only"
                value={dateAnchorRadarValue}
                resolveContext={dateAnchorResolveContext}
                now={new Date(2026, 3, 15, 9, 0)}
                onSave={(next) => { if (next) dateAnchorRadarValue = next; }}
                onCancel={() => {}}
              />
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(dateAnchorRadarValue, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Clone mode</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Advanced editor variant with the clone warning banner for parent-template copy flows.
                </p>
              </div>
              <DateAnchorEditor
                mode="clone"
                value={dateAnchorCloneValue}
                resolveContext={dateAnchorResolveContext}
                now={new Date(2026, 3, 15, 9, 0)}
                onSave={(next) => { if (next) dateAnchorCloneValue = next; }}
                onCancel={() => {}}
              />
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(dateAnchorCloneValue, null, 2)}</pre>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'calendar-related' && currentItem?.id === 'time-reference-range-editor'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Time Reference Range Editor</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Reusable calendar-friendly absolute/vague editor over a TimeReference. Supports date-only, exact time, vague time, end dates, end times, and automatic vague-hierarchy sanitization.
              </p>
            </div>
          </div>

          <div class="grid gap-6 xl:grid-cols-2">
            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Date only</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Start date with no time and no end.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treDateOnly} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treDateOnly)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treDateOnly, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Date + exact start time</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Start date with an exact start time.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treDatePlusExactTime} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treDatePlusExactTime)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treDatePlusExactTime, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Date + vague start time</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Start date with a vague morning time.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treDatePlusVagueTime} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treDatePlusVagueTime)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treDatePlusVagueTime, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Same-day time range</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Start date with start and end times on the same day.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treSameDayTimeRange} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treSameDayTimeRange)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treSameDayTimeRange, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Multi-day date range</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Start and end dates with no times.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treMultiDayRange} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treMultiDayRange)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treMultiDayRange, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Vague month</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Second half of 2026 — day and time controls are disabled.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treVagueMonth} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treVagueMonth)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treVagueMonth, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Vague day</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Second half of May 2026 — time controls are disabled.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treVagueDay} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treVagueDay)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treVagueDay, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Invalid incoming value</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Vague month with day and time — validation shows errors and sanitization clears lower fields on edit.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treInvalid} />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treInvalid)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treInvalid, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Compact density (progressive layout)</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Density is set to compact, causing the inner date picker to use the progressive layout.</p>
              </div>
              <TimeReferenceRangeEditor bind:value={treCompact} density="compact" />
              <div class="space-y-1">
                <p class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Label</p>
                <p class="text-[var(--text-sm)] text-[var(--color-foreground)]">{formatTimeReferenceRangeLabel(treCompact)}</p>
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(treCompact, null, 2)}</pre>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'calendar-related' && currentItem?.id === 'quick-add-date-time-popover'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Quick Add Date/Time Popover</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Styled popup shell for the modular quick-add direction: trigger pills, quick presets, compact date/time range editing, and exact/vague date semantics in one anchored surface.
              </p>
            </div>
          </div>

          <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div class="space-y-5">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="space-y-2">
                  <p class="text-[var(--text-lg)] font-semibold">Live popup sketch</p>
                  <p class="max-w-2xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    This stays in the component library for now. The quick-add flow can adopt it later without changing calendar or exec behavior today.
                  </p>
                </div>
                <Badge variant={quickAddPopupOpen ? 'success' : 'neutral'}>{quickAddPopupOpen ? 'Open' : 'Closed'}</Badge>
              </div>

              <div class="flex min-h-[18rem] items-start rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_8%,transparent),transparent_58%),var(--color-input)]/20 p-6">
                <QuickAddDateTimePopover
                  bind:value={quickAddPopupValue}
                  bind:open={quickAddPopupOpen}
                  now={new Date(2026, 4, 13, 9, 0)}
                  label="Quick add"
                />
              </div>

              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(quickAddPopupValue, null, 2)}</pre>
            </div>

            <div class="space-y-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Planned component stack</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  The first pass keeps the primitive broad enough to cover quick-add, planner, and clone-template popups.
                </p>
              </div>

              <div class="space-y-3">
                {#each [
                  ['Trigger pills', 'Compact start date, start time, and end summary chips.'],
                  ['Popup shell', 'Anchored popover with mobile-safe width and apply/cancel draft state.'],
                  ['Date editor', 'Progressive month then day layers; vague values hide lower precision.'],
                  ['Preset rail', 'Fast semantic shortcuts like morning, weekend, and current quarter.']
                ] as row}
                  <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/30 px-3 py-3">
                    <p class="text-[var(--text-sm)] font-semibold">{row[0]}</p>
                    <p class="mt-1 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">{row[1]}</p>
                  </div>
                {/each}
              </div>
            </div>
          </div>

          <div class="grid gap-6 xl:grid-cols-2">
            <div class="space-y-5">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Live commit mode</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  For flows that should update their host immediately while the popup stays open.
                </p>
              </div>
              <QuickAddDateTimePopover
                bind:value={quickAddLivePopupValue}
                bind:open={quickAddLivePopupOpen}
                now={new Date(2026, 4, 13, 9, 0)}
                label="Live schedule"
                commitMode="live"
              />
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(quickAddLivePopupValue, null, 2)}</pre>
            </div>

            <div class="space-y-5">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Range-heavy starting value</p>
                <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Opens with an explicit date range so the end-date and end-time paths are visible from the trigger.
                </p>
              </div>
              <div class="max-w-[24rem]">
                <QuickAddDateTimePopover
                  bind:value={quickAddRangePopupValue}
                  bind:open={quickAddRangePopupOpen}
                  now={new Date(2026, 4, 13, 9, 0)}
                  label="Range"
                  class="min-w-0 w-full"
                />
              </div>
              <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(quickAddRangePopupValue, null, 2)}</pre>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && !currentItemId}
        <div class="space-y-6">
          <div>
            <div class="space-y-3">
              <h2 class="text-3xl font-semibold tracking-tight">Input Controls</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Compact selection controls for settings UIs, filter bars, and dense tool panels.
              </p>
            </div>
          </div>

          <div class="space-y-3">
            {#each inputControlItems as item}
              <a
                href={item.href}
                class="block rounded-[var(--radius-lg)] border border-transparent bg-transparent p-5 transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5"
              >
                <div class="flex items-start gap-3">
                  <FileText class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  <div class="min-w-0">
                    <p class="text-[var(--text-base)] font-semibold">{item.title}</p>
                    <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                      {item.id === 'checkbox'
                        ? 'Boolean control with labelled, indeterminate, and helper-text states.'
                        : item.id === 'radio-group'
                          ? 'Typed single-choice control with horizontal and vertical layouts.'
                        : item.id === 'select'
                            ? 'Popover-backed single select with keyboard navigation.'
                            : item.id === 'number-input'
                              ? 'Stepper input with blur-to-commit numeric editing.'
                              : item.id === 'time-picker'
                                ? 'Exact and vague time-of-day picker backed by the canonical vague-minute model.'
                              : item.id === 'segmented-control'
                        ? 'Segmented single-select control for compact option groups with a stronger active state.'
                        : 'Compact pagination control for stepping through large result sets without rendering everything at once.'}
                    </p>
                  </div>
                </div>
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'checkbox'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Checkbox</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Label-first boolean control with helper text and indeterminate support for structured settings forms.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Boolean settings</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Use this for flags like overdue pinning, infinite relevance, and editor toggles.
              </p>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <Checkbox bind:checked={checkboxChecked} hint="Keep overdue items pinned in the planner panel.">
                Pin when overdue
              </Checkbox>

              <Checkbox bind:checked={checkboxChecked} bind:indeterminate={checkboxIndeterminate} hint="Indeterminate is useful while aggregating nested state.">
                Relevance propagates from children
              </Checkbox>
            </div>

            <div class="flex flex-wrap items-center gap-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
              <span>checked: {checkboxChecked ? 'true' : 'false'}</span>
              <span>indeterminate: {checkboxIndeterminate ? 'true' : 'false'}</span>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'radio-group'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Radio Group</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Typed single-select option group for fields that need hints and stronger structure than loose buttons.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Display mode selection</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Intended for options like calendar display treatment or anchor-source decisions.
              </p>
            </div>

            <div class="grid gap-6 lg:grid-cols-2">
              <div class="space-y-2">
                <Label>Vertical layout</Label>
                <RadioGroup ariaLabel="Display as vertical" options={displayAsOptions} bind:value={displayAsValue} />
              </div>

              <div class="space-y-2">
                <Label>Horizontal layout</Label>
                <RadioGroup ariaLabel="Display as horizontal" options={displayAsOptions} bind:value={displayAsValue} orientation="horizontal" />
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'select'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Select</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Single-select dropdown rendered through the shared popover layer with keyboard-friendly option navigation.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Duration unit picker</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                This is the compact dropdown style planned for relevance duration units and similar editor fields.
              </p>
            </div>

            <div class="max-w-sm space-y-2">
              <Label>Duration unit</Label>
              <Select ariaLabel="Duration unit" options={durationUnitOptions} bind:value={durationUnit} />
            </div>

            <p class="text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">Selected value: {String(durationUnit)}</p>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'number-input'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Number Input</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Stepper-backed numeric entry that keeps string editing local until blur or commit.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Duration amount</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Use this for relevance windows, offsets, and exact numeric adjustments inside structured date editors.
              </p>
            </div>

            <div class="max-w-xs space-y-2">
              <Label>Duration value</Label>
              <NumberInput bind:value={durationValue} min={0} max={30} step={1} />
            </div>

            <p class="text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">Committed value: {durationValue || 'empty'}</p>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'time-picker'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Time Picker</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Shared exact-or-vague time-of-day picker that preserves semantic intent when toggling modes.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Anchor-aware time selection</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Planned for minute references inside the future date-anchor editor, with exact entry and vague bucket mode using the same model as exec.
              </p>
            </div>

            <div class="flex flex-wrap gap-4">
              <div class="space-y-2">
                <Label>Format</Label>
                <SegmentedControl ariaLabel="Time picker format" options={[{ value: '12h', label: '12h' }, { value: '24h', label: '24h' }]} bind:value={timePickerFormat} class="w-fit" />
              </div>
              <div class="space-y-2">
                <Label>Range side</Label>
                <SegmentedControl ariaLabel="Time picker side" options={[{ value: 'start', label: 'Start' }, { value: 'end', label: 'End' }]} bind:value={timePickerSide} class="w-fit" />
              </div>
            </div>

            <div class="max-w-3xl">
              <TimePicker bind:value={timePickerValue} format={timePickerFormat} side={timePickerSide} />
            </div>

            <pre class="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/40 p-3 text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(timePickerValue, null, 2)}</pre>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'segmented-control'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Segmented Control</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Single-select segmented control for option groups that need a denser, more legible alternative to loose button rows.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Calendar-style week start selector</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                This is the compact treatment used by the calendar library pages for week-start selection.
              </p>
            </div>

            <div class="space-y-6">
              <div class="space-y-2">
                <Label>Start of Week</Label>
                <SegmentedControl
                  ariaLabel="Component library start of week"
                  options={weekdayOptions}
                  bind:value={firstDayOfWeek}
                  class="max-w-[22rem]"
                />
              </div>

              <div class="space-y-2">
                <Label>Font</Label>
                <SegmentedControl
                  ariaLabel="Font family"
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'inter', label: 'Inter' },
                    { value: 'arial', label: 'Arial' },
                    { value: 'poppins', label: 'Poppins' },
                    { value: 'nunito', label: 'Nunito' }
                  ]}
                  value="inter"
                  fullWidth
                />
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'input-controls' && currentItem?.id === 'pagination'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Pagination</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Compact pager for long lists, search results, and finder overlays that should render one page at a time instead of painting the entire dataset.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Finder-style pagination</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                This is the same primitive now used by the record finder to keep large result sets responsive.
              </p>
            </div>

            <div class="space-y-4">
              <Pagination bind:page={paginationPage} totalItems={paginationTotalItems} pageSize={paginationPageSize} />

              <div class="grid gap-2">
                {#each paginationVisibleItems as item}
                  <div class="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-input)]/40 px-4 py-3 text-[var(--text-sm)]">
                    <div class="font-medium">{item.title}</div>
                    <div class="mt-1 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">{item.id}</div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'layout-panels' && !currentItemId}
        <div class="space-y-6">
          <div>
            <div class="space-y-3">
              <h2 class="text-3xl font-semibold tracking-tight">Layout Panels</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Workspace layout primitives for split-view pages that need a persistent, keyboard-accessible detail panel.
              </p>
            </div>
          </div>

          <div class="space-y-3">
            {#each layoutPanelItems as item}
              <a
                href={item.href}
                class="block rounded-[var(--radius-lg)] border border-transparent bg-transparent p-5 transition hover:border-[var(--color-primary)] hover:bg-[var(--color-primary)]/5"
              >
                <div class="flex items-start gap-3">
                  <FileText class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  <div class="min-w-0">
                    <p class="text-[var(--text-base)] font-semibold">{item.title}</p>
                    <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                      {item.id === 'mobile-bottom-tray'
                        ? 'Viewport-anchored mobile drawer with a collapsed peek, drag gestures, snap behavior, and backdrop handling.'
                        : 'Shared resizable right-side panel with persisted width, pointer drag, keyboard resize, and overlay or divider handle styles.'}
                    </p>
                  </div>
                </div>
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'layout-panels' && currentItem?.id === 'resizable-side-panel'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Resizable Side Panel</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Reusable right-side inspector panel with persisted width, keyboard support, and configurable divider or overlay handle placement.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Overlay handle variant</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Mirrors the planner page treatment where the handle floats on the panel edge and the main canvas uses the current width for layout.
              </p>
            </div>

            <div
              class={`grid min-h-[24rem] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-input)]/20 lg:grid-cols-[minmax(0,1fr)_var(--demo-overlay-panel-width,22rem)] ${demoOverlayPanelResizing ? 'select-none' : ''}`}
              style={`--demo-overlay-panel-width: ${demoOverlayPanelWidth}px`}
            >
              <div class="min-h-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_10%,transparent),transparent_55%),var(--color-background)] p-6">
                <div class="space-y-3">
                  <Badge variant="neutral">Main Workspace</Badge>
                  <h3 class="text-xl font-semibold tracking-tight">Calendar or board canvas</h3>
                  <p class="max-w-xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    The page owns the outer layout and binds `widthPx` so the main surface can size itself with a CSS variable while the panel component owns persistence and interactions.
                  </p>
                </div>
              </div>

              <ResizableSidePanel
                bind:widthPx={demoOverlayPanelWidth}
                bind:isResizing={demoOverlayPanelResizing}
                minPx={260}
                maxPx={720}
                defaultPx={352}
                ariaLabel="Resize overlay demo panel"
                handleVariant="overlay"
                panelClass="relative border-l bg-[var(--color-background)] p-5"
                handleClass={`group hidden lg:flex absolute inset-y-0 -left-1 z-[var(--z-raised)] w-2 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none ${demoOverlayPanelResizing ? 'is-resizing' : ''}`}
              >
                {#snippet handle()}
                  <span
                    aria-hidden="true"
                    class="h-10 w-1 rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-primary)]/70 group-focus-visible:bg-[var(--color-primary)] group-[.is-resizing]:bg-[var(--color-primary)]"
                  ></span>
                {/snippet}

                <div class="space-y-4">
                  <div class="space-y-1">
                    <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">Inspector</p>
                    <h3 class="text-lg font-semibold">Release checklist</h3>
                  </div>
                  <div class="space-y-2 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    <p>Drag the edge, use arrow keys while focused, or double-click to reset.</p>
                    <p>Current width: {demoOverlayPanelWidth}px</p>
                  </div>
                </div>
              </ResizableSidePanel>
            </div>
          </div>

          <div class="space-y-6">
            <div class="space-y-2">
              <p class="text-[var(--text-lg)] font-semibold">Divider handle variant</p>
              <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Matches the todo planner treatment where the handle is a thin divider between a list column and the editor.
              </p>
            </div>

            <div class="flex min-h-[22rem] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)]">
              <div class="flex min-w-0 flex-1 flex-col border-r bg-[var(--color-input)]/20 p-5">
                <p class="text-sm font-semibold">Record List</p>
                <div class="mt-4 space-y-2">
                  {#each ['Draft timeline', 'QA handoff', 'Launch email', 'Support notes'] as label}
                    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm">
                      {label}
                    </div>
                  {/each}
                </div>
              </div>

              <ResizableSidePanel
                bind:widthPx={demoDividerPanelWidth}
                bind:isResizing={demoDividerPanelResizing}
                minPx={240}
                maxPx={640}
                defaultPx={320}
                ariaLabel="Resize divider demo panel"
                handleVariant="divider"
                handleClass={`w-1 cursor-col-resize bg-[var(--color-border)] transition-colors hover:bg-[var(--color-primary)]/40 ${demoDividerPanelResizing ? 'bg-[var(--color-primary)]/40' : ''}`}
                panelClass="shrink-0 bg-[var(--color-background)] p-5"
              >
                <div class="space-y-3">
                  <p class="text-sm font-semibold">Editor Panel</p>
                  <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    Width: {demoDividerPanelWidth}px
                  </p>
                  <p class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    Use this when the handle should visually read as a separator rather than a floating grab pill.
                  </p>
                </div>
              </ResizableSidePanel>
            </div>
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'layout-panels' && currentItem?.id === 'mobile-bottom-tray'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Mobile Bottom Tray</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                Viewport-anchored bottom tray used by calendar and planner mobile layouts. It keeps a collapsed peek visible, opens by tap or upward drag, and resizes vertically.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div class="space-y-2">
                <p class="text-[var(--text-lg)] font-semibold">Live viewport tray</p>
                <p class="max-w-2xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                  Use the button to open the tray, drag the visible handle, or tap the collapsed peek at the bottom of the viewport.
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Badge variant={demoMobileTrayCollapsed ? 'neutral' : 'success'}>{demoMobileTrayCollapsed ? 'Collapsed' : 'Open'}</Badge>
                <Button variant="secondary" size="sm" onclick={() => demoMobileTrayCollapsed = !demoMobileTrayCollapsed}>
                  {demoMobileTrayCollapsed ? 'Open tray' : 'Collapse tray'}
                </Button>
              </div>
            </div>

            <div class="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-input)]/20 p-6">
              <div class="grid gap-3 md:grid-cols-3">
                <div>
                  <p class="text-[var(--text-sm)] font-semibold">Height</p>
                  <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">{demoMobileTrayHeight}px</p>
                </div>
                <div>
                  <p class="text-[var(--text-sm)] font-semibold">Dragging</p>
                  <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">{demoMobileTrayResizing ? 'Active' : 'Idle'}</p>
                </div>
                <div>
                  <p class="text-[var(--text-sm)] font-semibold">Collapsed peek</p>
                  <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">Measured from the tray header.</p>
                </div>
              </div>
            </div>
          </div>

          <MobileBottomTray
            bind:heightPx={demoMobileTrayHeight}
            bind:collapsed={demoMobileTrayCollapsed}
            bind:isResizing={demoMobileTrayResizing}
            minPx={220}
            maxPx={9999}
            defaultPx={320}
            ariaLabel="Resize mobile bottom tray demo"
            collapsedPeekSelector="[data-mobile-bottom-tray-peek]"
            panelClass="bg-[var(--color-background)]"
          >
            <div class="flex min-h-0 flex-col">
              <button
                type="button"
                data-mobile-bottom-tray-peek
                class="flex w-full items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3 text-left"
                onclick={() => demoMobileTrayCollapsed = !demoMobileTrayCollapsed}
              >
                <span class="min-w-0">
                  <span class="block text-[var(--text-sm)] font-semibold text-[var(--color-foreground)]">Mobile tray preview</span>
                  <span class="block truncate text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">Tap or drag to open</span>
                </span>
                <ChevronDown class={`size-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform ${demoMobileTrayCollapsed ? '' : 'rotate-180'}`} />
              </button>

              <div class="grid gap-4 overflow-auto p-4">
                <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)]/20 p-4">
                  <p class="text-[var(--text-sm)] font-semibold">Calendar day panel</p>
                  <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                    Calendar uses this pattern to keep day details anchored while the mobile calendar remains behind it.
                  </p>
                </div>
                <div class="grid gap-2">
                  {#each ['9:00 Design review', '11:30 Sync follow-up', '2:00 Draft planning notes'] as item}
                    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-[var(--text-sm)]">
                      {item}
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </MobileBottomTray>
        </div>
      {/if}

      {#if currentGroupId === 'icons' && !currentItemId}
        <div class="space-y-6">
          <div>
            <div class="space-y-3">
              <h2 class="text-3xl font-semibold tracking-tight">Icons</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                SVG icons brought over from the original Wisewords application.
              </p>
            </div>
          </div>

          <div class="grid gap-4 md:grid-cols-2">
            {#each currentPage?.items ?? [] as item}
              <a
                href={item.href}
                class="group block rounded-xl border border-[color-mix(in_srgb,var(--color-border),transparent_50%)] bg-[color-mix(in_srgb,var(--color-panel),transparent_30%)] p-6 shadow-sm transition hover:border-[var(--color-border)] hover:bg-[var(--color-panel)]"
              >
                <div class="flex items-start gap-3">
                  <FileText class="mt-0.5 size-4 shrink-0 text-[var(--color-muted-foreground)]" />
                  <div class="min-w-0">
                    <p class="text-[var(--text-base)] font-semibold">{item.title}</p>
                    <p class="mt-1 text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                      View all icons inside {item.title}.
                    </p>
                  </div>
                </div>
              </a>
            {/each}
          </div>
        </div>
      {/if}

      {#if currentGroupId === 'icons' && currentItem?.id === 'calendar-icons'}
        <div class="space-y-6">
          <div>
            <div class="space-y-2">
              <h2 class="text-3xl font-semibold tracking-tight">Calendar Icons</h2>
              <p class="max-w-3xl text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
                The original day, week, month, and year grid icons from Wisewords, built entirely via SVG primitives.
              </p>
            </div>
          </div>

          <div class="space-y-6">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div class="flex flex-col items-center justify-center p-6 border rounded-lg bg-muted/20 gap-4 hover:bg-muted/40 transition">
                <IconDay class="size-16 text-foreground" />
                <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Day</span>
              </div>
              <div class="flex flex-col items-center justify-center p-6 border rounded-lg bg-muted/20 gap-4 hover:bg-muted/40 transition">
                <IconWeek class="size-16 text-foreground" />
                <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Week</span>
              </div>
              <div class="flex flex-col items-center justify-center p-6 border rounded-lg bg-muted/20 gap-4 hover:bg-muted/40 transition">
                <IconMonth class="size-16 text-foreground" />
                <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Month</span>
              </div>
              <div class="flex flex-col items-center justify-center p-6 border rounded-lg bg-muted/20 gap-4 hover:bg-muted/40 transition">
                <IconYear class="size-16 text-foreground" />
                <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Year</span>
              </div>
            </div>
          </div>
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .library-shell {
    box-sizing: border-box;
  }

  .library-layout {
    display: grid;
    grid-template-columns: 18rem minmax(0, 1fr);
    gap: 1.5rem;
    width: 100%;
    height: 100%;
    min-height: 0;
    align-items: start;
  }

  @media (min-width: 960px) {
    .library-layout {
      gap: 0;
    }
  }

  .library-layout--tree-hidden {
    grid-template-columns: minmax(0, 1fr);
  }

  .library-tree-panel {
    position: sticky;
    top: 1.5rem;
    align-self: start;
    min-width: 0;
    max-height: calc(100vh - 3rem);
    overflow-y: auto;
  }

  @media (min-width: 960px) {
    .library-tree-panel {
      border-right: 1px solid var(--color-border);
      padding-right: 1.5rem;
    }
  }

  .library-layout--tree-hidden .library-tree-panel {
    display: none;
  }

  .library-content-panel {
    min-width: 0;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  @media (min-width: 960px) {
    .library-content-panel {
      padding-left: 1.5rem;
    }
  }

  .library-content-toolbar {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0 0 1rem;
    background: color-mix(in srgb, var(--color-background) 25%, transparent);
    backdrop-filter: blur(10px);
  }

  .library-toolbar-btn,
  .library-mobile-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-background);
    padding: 0.55rem 0.8rem;
    font-size: var(--text-xsm);
    font-weight: 600;
    color: var(--color-foreground);
  }

  .library-toolbar-btn--mobile,
  .library-mobile-close {
    display: none;
  }

  .library-mobile-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-overlay-backdrop);
    background: color-mix(in srgb, black 42%, transparent);
  }

  @media (max-width: 959px) {
    .library-layout,
    .library-layout--tree-hidden {
      display: block;
      height: 100%;
    }

    .library-tree-panel,
    .library-layout--tree-hidden .library-tree-panel {
      display: block;
      position: fixed;
      top: 0.75rem;
      left: 0.75rem;
      bottom: 0.75rem;
      width: min(22rem, calc(100vw - 1.5rem));
      max-height: none;
      z-index: var(--z-modal);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-background);
      padding: 1rem;
      box-shadow: 0 18px 48px color-mix(in srgb, black 32%, transparent);
      transform: translateX(calc(-100% - 1rem));
      transition: transform 160ms ease;
    }

    .library-tree-panel--mobile-open {
      transform: translateX(0);
    }

    .library-content-panel {
      padding-right: 0;
    }

    .library-content-toolbar {
      justify-content: flex-start;
      padding-bottom: 0.75rem;
    }

    .library-toolbar-btn--desktop {
      display: none;
    }

    .library-toolbar-btn--mobile,
    .library-mobile-close {
      display: inline-flex;
    }
  }
</style>
