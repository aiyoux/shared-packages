<script lang="ts">
  import { onMount, tick, untrack, flushSync } from 'svelte';
  import type { DateRangeSelection, DateRangeValue } from './date-range.ts';
  import { formatRangeLabel, normalizeRange, sameDay, stripTime } from './date-range.ts';
  import {
    monthKey,
    monthLabel,
    addMonths,
    startOfWeek,
    addDays,
    monthForDate,
    monthBufferedGridOrigin as utilsMonthBufferedGridOrigin,
    infiniteTotalRows as utilsInfiniteTotalRows,
    infiniteBufferRows as utilsInfiniteBufferRows,
    logicalCenterRow as utilsLogicalCenterRow,
    recenterThresholdRows as utilsRecenterThresholdRows,
    buildInfiniteGridSetup as utilsBuildInfiniteGridSetup,
    computeSelectionOutlinePath,
    computeSimpleRowBands,
    type RowBandSegment
  } from './date-range-utils.ts';
  import SvgOverlay from './SvgOverlay.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import DateRangeMonthSelector from './DateRangeMonthSelector.svelte';
  import NumberInput from './NumberInput.svelte';
  import {
    RangeCalendarLayout,
    RangeCalendarOutlineStyle,
    type RangeCalendarGridData,
    type RangeCalendarViewOptions
  } from './range-calendar-types.ts';
  import {
    DAY_MS,
    VAGUE_YEARS,
    VAGUE_MONTHS,
    VAGUE_MONTH_ORDER,
    VAGUE_DAYS,
    weekCountFor,
    weekRangeFor,
    type WeekModeCode,
    type VagueYearCode,
    type VagueMonthCode,
    type VagueDayCode
  } from './date';

  type GridCell = {
    date: Date;
    in_current_month: boolean;
  };

  let {
    value = $bindable<DateRangeValue>({ start: null, end: null }),
    viewing_date = $bindable({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 }),
    firstDayOfWeek = 1,
    rows = 6,
    infiniteScrollEnabled = true,
    windowMultiplier = 5,
    windowRows = undefined,
    bufferRows = undefined,
    minCellHeight = undefined,
    maxCellHeight = undefined,
    showHeader = true,
    showWeekdays = true,
    showMonthOutline = false,
    showFooter = true,
    simpleCellMode = false,
    dualMonth = false,
    allowVague = false,
    vagueYear = $bindable<string | null>(null),
    vagueMonth = $bindable<string | null>(null),
    vagueDay = $bindable<string | null>(null),
    exactYear = $bindable<number | null>(null),
    exactMonth = $bindable<number | null>(null),
    exactDay = $bindable<number | null>(null),
    exactWeek = $bindable<number | null>(null),
    weekMode = $bindable<WeekModeCode>('ord'),
    weekStart = $bindable<number>(1),
    onSelectVague,
    onDone,
    class: className = '',
    style = ''
  }: {
    value?: DateRangeValue;
    viewing_date?: { year: number; month: number; day?: number };
    firstDayOfWeek?: number;
    rows?: number;
    infiniteScrollEnabled?: boolean;
    windowMultiplier?: number;
    windowRows?: number;
    bufferRows?: number;
    minCellHeight?: number;
    maxCellHeight?: number;
    showHeader?: boolean;
    showWeekdays?: boolean;
    showMonthOutline?: boolean;
    showFooter?: boolean;
    simpleCellMode?: boolean;
    dualMonth?: boolean;
    allowVague?: boolean;
    vagueYear?: string | null;
    vagueMonth?: string | null;
    vagueDay?: string | null;
    exactYear?: number | null;
    exactMonth?: number | null;
    exactDay?: number | null;
    exactWeek?: number | null;
    weekMode?: WeekModeCode;
    weekStart?: number;
    onSelectVague?: (detail: { type: 'year' | 'month' | 'day'; value: string }) => void;
    onDone?: () => void;
    class?: string;
    style?: string;
  } = $props();

  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const month_names_short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  type MonthPoint = { year: number; month: number };

  let grid_ref = $state<HTMLDivElement | null>(null);
  let left_scroll_container_ref = $state<HTMLDivElement | null>(null);
  let right_scroll_container_ref = $state<HTMLDivElement | null>(null);
  let left_container_height = $state(0);
  let right_container_height = $state(0);
  let grid_height = $state(0);
  let resize_observer: ResizeObserver | null = null;

  let header_visible_date = $state({ year: viewing_date.year, month: viewing_date.month });
  let right_header_visible_date = $state<{ year: number; month: number; day?: number }>({
    year: addMonths(viewing_date, 1).year,
    month: addMonths(viewing_date, 1).month
  });
  let infinite_grid_origin = $state<Date | null>(null);
  let right_infinite_grid_origin = $state<Date | null>(null);

  // Month-Year quick selector overlay state
  let month_selector_open = $state(false);
  let month_selector_side = $state<'left' | 'right'>('left');
  let month_selector_temp_year = $state<number | null>(new Date().getFullYear());
  let years_scroll_ref = $state<HTMLDivElement | null>(null);
  let month_selector_months_scroll_ref = $state<HTMLDivElement | null>(null);

  const current_year = new Date().getFullYear();
  const year_range = Array.from({ length: 120 }, (_, i) => current_year - 90 + i);

  // Left scroll state
  let left_grid_anchor_row = $state(0);
  let left_pending_infinite_reset = $state(true);
  let left_infinite_recenter_pending = $state(false);
  let left_last_scroll_synced_month_key = $state<string | null>(monthKey(viewing_date));
  let left_last_reported_month_key = $state<string | null>(monthKey(viewing_date));

  // Right scroll state
  let right_grid_anchor_row = $state(0);
  let right_pending_infinite_reset = $state(true);
  let right_infinite_recenter_pending = $state(false);
  let right_last_scroll_synced_month_key = $state<string | null>(monthKey(addMonths(viewing_date, 1)));
  let right_last_reported_month_key = $state<string | null>(monthKey(addMonths(viewing_date, 1)));

  let last_infinite_mode = $state(false);
  let pending_second_click = $state(false);
  let anchor_date = $state<Date | null>(value.start ? stripTime(value.start) : null);
  let hovered_date = $state<Date | null>(null);
  let pointer_anchor_date = $state<Date | null>(null);
  let pointer_origin_date = $state<Date | null>(null);
  let is_pointer_down = $state(false);
  let pointer_did_drag = $state(false);
  let suppress_click_once = $state(false);
  let had_pending_second_click_on_pointer_down = false;
  let exact_day_text = $state(exactDay !== null ? String(exactDay) : '');
  let week_start_text = $state(String(weekStart));
  let pending_month_second_click = $state(false);
  let month_anchor = $state<MonthPoint | null>(null);
  let hovered_month = $state<MonthPoint | null>(null);

  const adjusted_weekdays = $derived.by(() => {
    const start = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
    return [...weekdays.slice(start), ...weekdays.slice(0, start)];
  });
  const isInfiniteScroll = $derived(infiniteScrollEnabled);
  const visible_rows = $derived(dualMonth ? 6 : Math.max(1, Math.floor(rows)));
  const cell_min_height = $derived(minCellHeight ?? (simpleCellMode ? 40 : 56));
  const cell_max_height = $derived(maxCellHeight ?? (simpleCellMode ? 52 : 78));
  const selected_year = $derived(exactYear ?? header_visible_date.year);
  const days_in_selected_year = $derived(isLeapYear(selected_year) ? 366 : 365);

  const vagueLabel = $derived.by(() => {
    const fallbackYear = value.start?.getFullYear() ?? new Date().getFullYear();
    const fallbackMonth = (value.start?.getMonth() ?? new Date().getMonth()) + 1;

    let yearPart = '';
    if (vagueYear) {
      const yearInfo = VAGUE_YEARS[vagueYear as VagueYearCode];
      yearPart = yearInfo ? yearInfo.label : vagueYear;
    } else if (exactYear !== null) {
      yearPart = String(exactYear);
    } else {
      yearPart = String(fallbackYear);
    }

    let monthPart = '';
    if (vagueMonth) {
      const monthInfo = VAGUE_MONTHS[vagueMonth as VagueMonthCode];
      monthPart = monthInfo ? monthInfo.label : vagueMonth;
    } else if (vagueDay) {
      let dayLabel = '';
      if (vagueDay === 'em') dayLabel = 'Early';
      else if (vagueDay === 'mm') dayLabel = 'Mid';
      else if (vagueDay === 'lm') dayLabel = 'Late';
      else if (vagueDay === 'fh') dayLabel = 'First half';
      else if (vagueDay === 'sh') dayLabel = 'Second half';
      const year = exactYear ?? fallbackYear;
      const month = exactMonth ?? fallbackMonth;
      const dateObj = new Date(year, month - 1, 1);
      const monthName = dateObj.toLocaleString('default', { month: 'long' });
      monthPart = `${dayLabel} ${monthName}`;
    } else if (exactDay !== null && exactMonth === null) {
      monthPart = formatDayOfYear(exactDay);
    }

    if (monthPart && yearPart) {
      return `${monthPart}, ${yearPart}`;
    }
    return monthPart || yearPart;
  });

  const isVagueActive = $derived(vagueYear !== null || vagueMonth !== null || vagueDay !== null);
  const week_mode_options = [
    { value: 'ord', label: 'Abstract' },
    { value: 'iso', label: 'ISO' },
    { value: 'row', label: 'Row' }
  ] as const;

  let calendarMode = $state<'exact' | 'weeks' | 'approx'>(
    (vagueYear !== null || vagueMonth !== null || vagueDay !== null)
      ? 'approx'
      : (exactWeek !== null)
        ? 'weeks'
        : 'exact'
  );
  const uses_year_day_editor = $derived(
    exactYear !== null &&
    exactMonth === null &&
    !vagueMonth &&
    (calendarMode === 'exact' || calendarMode === 'approx')
  );
  let prevIsVagueActive = vagueYear !== null || vagueMonth !== null || vagueDay !== null;

  $effect(() => {
    const active = vagueYear !== null || vagueMonth !== null || vagueDay !== null;
    if (active && !prevIsVagueActive) {
      calendarMode = 'approx';
    }
    prevIsVagueActive = active;
  });

  function handleModeChange(mode: 'exact' | 'weeks' | 'approx') {
    calendarMode = mode;
    clearMonthRangeDraft();
    if (mode === 'exact') {
      vagueYear = null;
      vagueMonth = null;
      vagueDay = null;
      exactWeek = null;
      exactYear = null;
      exactMonth = null;
      exactDay = null;
    } else if (mode === 'weeks') {
      vagueYear = null;
      vagueMonth = null;
      vagueDay = null;
      value = { start: null, end: null };
    } else {
      exactWeek = null;
      exactYear = null;
      exactMonth = null;
      exactDay = null;
      value = { start: null, end: null };
    }
  }

  function monthBufferedGridOrigin(anchor: { year: number; month: number }) {
    return utilsMonthBufferedGridOrigin(anchor, firstDayOfWeek, visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function infiniteTotalRows() {
    return utilsInfiniteTotalRows(visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function infiniteBufferRows() {
    return utilsInfiniteBufferRows(visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function logicalCenterRow() {
    return utilsLogicalCenterRow(visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function recenterThresholdRows() {
    return utilsRecenterThresholdRows(visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function buildInfiniteGridSetup(origin: Date, anchorRow: number) {
    return utilsBuildInfiniteGridSetup(origin, anchorRow, visible_rows, bufferRows, windowRows, windowMultiplier);
  }

  function isLeapYear(year: number) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function dateForDayOfYear(year: number, dayOfYear: number) {
    const date = new Date(year, 0, 1);
    date.setDate(dayOfYear);
    return date;
  }

  function monthStart(point: MonthPoint) {
    return stripTime(new Date(point.year, point.month - 1, 1));
  }

  function monthEnd(point: MonthPoint) {
    return stripTime(new Date(point.year, point.month, 0));
  }

  function monthIndex(point: MonthPoint) {
    return point.year * 12 + point.month - 1;
  }

  function monthPointFromDate(date: Date): MonthPoint {
    return { year: date.getFullYear(), month: date.getMonth() + 1 };
  }

  function normalizeMonthPoints(start: MonthPoint, end: MonthPoint) {
    return monthIndex(start) <= monthIndex(end)
      ? { start, end }
      : { start: end, end: start };
  }

  function clearMonthRangeDraft() {
    pending_month_second_click = false;
    month_anchor = null;
    hovered_month = null;
  }

  function startMonthRangeSelection(point: MonthPoint) {
    vagueYear = null;
    vagueMonth = null;
    vagueDay = null;
    exactWeek = null;
    exactDay = null;
    exactYear = point.year;
    exactMonth = point.month;
    value = { start: monthStart(point), end: monthEnd(point) };
    month_anchor = point;
    hovered_month = point;
    pending_month_second_click = true;
  }

  function commitMonthRangeSelection(point: MonthPoint) {
    const anchor = month_anchor ?? point;
    const range = normalizeMonthPoints(anchor, point);
    exactYear = range.start.year;
    exactMonth = range.start.month;
    value = { start: monthStart(range.start), end: monthEnd(range.end) };
    clearMonthRangeDraft();
  }

  function monthSelectionFor(point: MonthPoint) {
    const preview = pending_month_second_click && month_anchor && hovered_month
      ? normalizeMonthPoints(month_anchor, hovered_month)
      : null;
    const pointIndex = monthIndex(point);

    if (preview) {
      const startIndex = monthIndex(preview.start);
      const endIndex = monthIndex(preview.end);
      if (pointIndex === startIndex && pointIndex === endIndex) return 'single';
      if (pointIndex === startIndex) return 'preview-start';
      if (pointIndex === endIndex) return 'preview-end';
      if (pointIndex > startIndex && pointIndex < endIndex) return 'preview';
    }

    if (!value.start || !value.end || vagueMonth || vagueYear || vagueDay || exactWeek !== null || exactDay !== null) {
      return 'none';
    }

    const selected = normalizeMonthPoints(monthPointFromDate(value.start), monthPointFromDate(value.end));
    const startIndex = monthIndex(selected.start);
    const endIndex = monthIndex(selected.end);
    if (pointIndex === startIndex && pointIndex === endIndex) return 'single';
    if (pointIndex === startIndex) return 'start';
    if (pointIndex === endIndex) return 'end';
    if (pointIndex > startIndex && pointIndex < endIndex) return 'in-range';
    return 'none';
  }

  function formatDayOfYear(dayOfYear: number | null) {
    if (dayOfYear === null) return '';
    const safeDay = Math.max(1, Math.min(days_in_selected_year, Math.trunc(dayOfYear)));
    const date = dateForDayOfYear(selected_year, safeDay);
    return `Day ${safeDay} (${date.toLocaleString('default', { month: 'short', day: 'numeric' })})`;
  }

  function currentWeekStart() {
    const parsed = Number(week_start_text);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(6, Math.trunc(parsed))) : 1;
  }

  function updateWeekMode(next: WeekModeCode) {
    weekMode = next;
    if (next === 'row') weekStart = currentWeekStart();
    if (exactWeek !== null && exactYear !== null) {
      exactWeek = Math.max(1, Math.min(exactWeek, weekCountFor(exactYear, exactMonth, next, currentWeekStart())));
    }
  }

  function updateWeekStart(next: string) {
    week_start_text = next;
    weekStart = currentWeekStart();
    if (exactWeek !== null && exactYear !== null) {
      exactWeek = Math.max(1, Math.min(exactWeek, weekCountFor(exactYear, exactMonth, weekMode, weekStart)));
    }
  }

  function weekScopeForDate(date: Date): { year: number; month: number | null } {
    if (weekMode === 'iso' && exactMonth === null) {
      const iso = getIsoWeek(date);
      return { year: iso.year, month: null };
    }
    return {
      year: exactYear ?? date.getFullYear(),
      month: exactMonth
    };
  }

  function weekNumberForDate(date: Date): { year: number; month: number | null; week: number } {
    const scope = weekScopeForDate(date);
    if (weekMode === 'iso' && scope.month === null) {
      const iso = getIsoWeek(date);
      return { ...scope, week: iso.week };
    }

    const first = scope.month !== null ? new Date(scope.year, scope.month - 1, 1) : new Date(scope.year, 0, 1);
    const modeStart = weekMode === 'ord' ? first : startOfWeek(first, weekMode === 'iso' ? 1 : currentWeekStart());
    const week = Math.floor((stripTime(date).getTime() - stripTime(modeStart).getTime()) / DAY_MS / 7) + 1;
    const count = weekCountFor(scope.year, scope.month, weekMode, currentWeekStart());
    return { ...scope, week: Math.max(1, Math.min(count, week)) };
  }

  function selectedWeekRange() {
    if (calendarMode !== 'weeks' || exactWeek === null || exactYear === null) return null;
    return weekRangeFor(exactYear, exactMonth, exactWeek, weekMode, currentWeekStart());
  }

  function monthScopeLabel(fallback: { year: number; month: number }) {
    if (vagueMonth) {
      return `${VAGUE_MONTHS[vagueMonth as VagueMonthCode]?.label || vagueMonth}, ${exactYear ?? fallback.year}`;
    }
    if (exactMonth !== null) {
      return monthLabel({ year: exactYear ?? fallback.year, month: exactMonth });
    }
    if (exactYear !== null) {
      return String(exactYear);
    }
    return monthLabel(fallback);
  }

  function currentRowHeightPx(side: 'left' | 'right') {
    const containerHeight = side === 'left' ? left_container_height : right_container_height;
    if (containerHeight <= 0) return cell_min_height;
    const padding = (dualMonth && showWeekdays) ? 34 : 0;
    const nextHeight = (containerHeight - padding) > 0 ? (containerHeight - padding) / visible_rows : cell_min_height;
    return Math.min(Math.max(nextHeight, cell_min_height), cell_max_height);
  }

  function resetInfiniteScrollPosition(side: 'left' | 'right') {
    tick().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = side === 'left' ? left_scroll_container_ref : right_scroll_container_ref;
          if (!container) return;
          const rowHeight = currentRowHeightPx(side);
          const availableHeight = Math.max(0, container.getBoundingClientRect().height);
          const centerRow = logicalCenterRow();
          const targetScrollTop = centerRow * rowHeight - availableHeight / 2 + rowHeight / 2;
          container.scrollTop = Math.max(0, targetScrollTop);
        });
      });
    });
  }

  async function recenterInfiniteGrid(side: 'left' | 'right', deviation: number, currentScroll: number, rowHeight: number) {
    if (side === 'left') {
      if (left_infinite_recenter_pending) return;
      const container = left_scroll_container_ref;
      if (!container || deviation === 0) return;

      left_infinite_recenter_pending = true;
      const targetScrollTop = Math.max(0, currentScroll - deviation * rowHeight);

      flushSync(() => {
        left_grid_anchor_row += deviation;
      });

      container.scrollTop = targetScrollTop;

      setTimeout(() => {
        left_infinite_recenter_pending = false;
      }, 40);
    } else {
      if (right_infinite_recenter_pending) return;
      const container = right_scroll_container_ref;
      if (!container || deviation === 0) return;

      right_infinite_recenter_pending = true;
      const targetScrollTop = Math.max(0, currentScroll - deviation * rowHeight);

      flushSync(() => {
        right_grid_anchor_row += deviation;
      });

      container.scrollTop = targetScrollTop;

      setTimeout(() => {
        right_infinite_recenter_pending = false;
      }, 40);
    }
  }

  function syncVisibleMonthFromScroll(side: 'left' | 'right') {
    if (!isInfiniteScroll) return;
    if (side === 'left' && left_infinite_recenter_pending) return;
    if (side === 'right' && right_infinite_recenter_pending) return;

    const container = side === 'left' ? left_scroll_container_ref : right_scroll_container_ref;
    const gridData = side === 'left' ? left_grid_data : right_grid_data;
    if (!container || gridData.length === 0) return;

    const rowHeight = currentRowHeightPx(side);
    const availableHeight = Math.max(0, container.getBoundingClientRect().height);
    if (availableHeight <= 0) return;

    const currentScroll = container.scrollTop;
    const viewportCenterRow = (currentScroll + availableHeight / 2) / rowHeight;
    const clampedCenterRow = Math.max(0, Math.min(gridData.length - 1, Math.floor(viewportCenterRow)));
    
    const gridSetup = side === 'left' ? active_grid_setup : right_grid_setup;
    const centerDate = addDays(gridSetup.first_day_of_grid, clampedCenterRow * 7 + 3);
    const visibleMonth = monthForDate(centerDate);
    const visibleKey = monthKey(visibleMonth);

    if (side === 'left') {
      if (visibleKey !== monthKey(header_visible_date)) {
        left_last_reported_month_key = visibleKey;
        left_last_scroll_synced_month_key = visibleKey;
        header_visible_date = { year: visibleMonth.year, month: visibleMonth.month };
        if (!dualMonth) {
          viewing_date = { year: visibleMonth.year, month: visibleMonth.month, day: 1 };
        }
      }
      const deviation = clampedCenterRow - logicalCenterRow();
      if (Math.abs(deviation) >= recenterThresholdRows()) {
        void recenterInfiniteGrid('left', deviation, currentScroll, rowHeight);
      }
    } else {
      if (visibleKey !== monthKey(right_header_visible_date)) {
        right_last_reported_month_key = visibleKey;
        right_last_scroll_synced_month_key = visibleKey;
        right_header_visible_date = { year: visibleMonth.year, month: visibleMonth.month };
      }
      const deviation = clampedCenterRow - logicalCenterRow();
      if (Math.abs(deviation) >= recenterThresholdRows()) {
        void recenterInfiniteGrid('right', deviation, currentScroll, rowHeight);
      }
    }
  }

  const active_grid_setup = $derived.by(() => {
    if (isInfiniteScroll) {
      const untracked_viewing = untrack(() => viewing_date);
      const origin = infinite_grid_origin ?? monthBufferedGridOrigin(untracked_viewing);
      return buildInfiniteGridSetup(origin, left_grid_anchor_row);
    }

    const monthStart = new Date(viewing_date.year, viewing_date.month - 1, 1);
    const firstVisibleWeek = startOfWeek(monthStart, firstDayOfWeek);
    return {
      first_day_of_grid: firstVisibleWeek,
      days_in_grid: visible_rows * 7
    };
  });

  const right_grid_setup = $derived.by(() => {
    if (isInfiniteScroll) {
      const untracked_viewing = untrack(() => addMonths(viewing_date, 1));
      const origin = right_infinite_grid_origin ?? monthBufferedGridOrigin(untracked_viewing);
      return buildInfiniteGridSetup(origin, right_grid_anchor_row);
    }

    const nextMonth = addMonths(viewing_date, 1);
    const nextMonthStart = new Date(nextMonth.year, nextMonth.month - 1, 1);
    const nextFirstVisibleWeek = startOfWeek(nextMonthStart, firstDayOfWeek);
    return {
      first_day_of_grid: nextFirstVisibleWeek,
      days_in_grid: visible_rows * 7
    };
  });

  const grid_data = $derived.by(() => {
    const cells: GridCell[][] = [];
    const targetMonth = header_visible_date.month;
    const targetYear = header_visible_date.year;
    for (let rowIdx = 0; rowIdx < Math.ceil(active_grid_setup.days_in_grid / 7); rowIdx++) {
      const row: GridCell[] = [];
      for (let colIdx = 0; colIdx < 7; colIdx++) {
        const date = addDays(active_grid_setup.first_day_of_grid, rowIdx * 7 + colIdx);
        row.push({
          date,
          in_current_month: date.getMonth() === targetMonth - 1 && date.getFullYear() === targetYear
        });
      }
      cells.push(row);
    }
    return cells;
  });

  const left_grid_data = $derived(grid_data);

  const right_grid_data = $derived.by(() => {
    const cells: GridCell[][] = [];
    const targetMonth = right_header_visible_date.month;
    const targetYear = right_header_visible_date.year;
    for (let rowIdx = 0; rowIdx < Math.ceil(right_grid_setup.days_in_grid / 7); rowIdx++) {
      const row: GridCell[] = [];
      for (let colIdx = 0; colIdx < 7; colIdx++) {
        const date = addDays(right_grid_setup.first_day_of_grid, rowIdx * 7 + colIdx);
        row.push({
          date,
          in_current_month: date.getMonth() === targetMonth - 1 && date.getFullYear() === targetYear
        });
      }
      cells.push(row);
    }
    return cells;
  });

  const left_selection_outline_path = $derived(computeSelectionOutlinePath(left_grid_data, selectionForDate, simpleCellMode));
  const right_selection_outline_path = $derived(computeSelectionOutlinePath(right_grid_data, selectionForDate, simpleCellMode));

  const left_simple_row_bands = $derived(computeSimpleRowBands(left_grid_data, selectionForDate, simpleCellMode));
  const right_simple_row_bands = $derived(computeSimpleRowBands(right_grid_data, selectionForDate, simpleCellMode));

  const left_overlay_grid_data = $derived<RangeCalendarGridData[][]>(
    left_grid_data.map((row) =>
      row.map((cell) => ({
        date: cell.date,
        event_slots: [],
        minor_event_slots: [],
        mini_event_slots: [],
        statuses: [],
        mini_statuses: [],
        in_current_month: cell.in_current_month
      }))
    )
  );

  const right_overlay_grid_data = $derived<RangeCalendarGridData[][]>(
    right_grid_data.map((row) =>
      row.map((cell) => ({
        date: cell.date,
        event_slots: [],
        minor_event_slots: [],
        mini_event_slots: [],
        statuses: [],
        mini_statuses: [],
        in_current_month: cell.in_current_month
      }))
    )
  );

  const grid_style = $derived.by(() => {
    const rowHeight = currentRowHeightPx('left');
    return [
      'grid-template-columns: repeat(7, minmax(0, 1fr))',
      `grid-template-rows: repeat(${grid_data.length}, ${rowHeight}px)`,
      `height: ${rowHeight * grid_data.length}px`,
      `min-height: ${rowHeight * grid_data.length}px`,
      'align-content: start'
    ].join('; ');
  });

  const left_grid_style = $derived.by(() => {
    const rowHeight = currentRowHeightPx('left');
    const rowCount = left_grid_data.length;
    return [
      'grid-template-columns: repeat(7, minmax(0, 1fr))',
      `grid-template-rows: repeat(${rowCount}, ${rowHeight}px)`,
      `height: ${rowHeight * rowCount}px`,
      `min-height: ${rowHeight * rowCount}px`,
      'align-content: start'
    ].join('; ');
  });

  const right_grid_style = $derived.by(() => {
    const rowHeight = currentRowHeightPx('right');
    const rowCount = right_grid_data.length;
    return [
      'grid-template-columns: repeat(7, minmax(0, 1fr))',
      `grid-template-rows: repeat(${rowCount}, ${rowHeight}px)`,
      `height: ${rowHeight * rowCount}px`,
      `min-height: ${rowHeight * rowCount}px`,
      'align-content: start'
    ].join('; ');
  });

  const overlay_view_options = $derived<RangeCalendarViewOptions>({
    layout: RangeCalendarLayout.Month,
    first_day_of_week: firstDayOfWeek,
    grey_weekday_mask: 0,
    outline_style: showMonthOutline ? RangeCalendarOutlineStyle.Month : RangeCalendarOutlineStyle.None,
    show_week_outline: false,
    show_cell_outline: false,
    show_days_outside_month: true,
    highlight_today: false
  });

  const overlay_grid_data = $derived<RangeCalendarGridData[][]>(
    grid_data.map((row) =>
      row.map((cell) => ({
        date: cell.date,
        event_slots: [],
        minor_event_slots: [],
        mini_event_slots: [],
        statuses: [],
        mini_statuses: [],
        in_current_month: cell.in_current_month
      }))
    )
  );

  const selection_outline_path = $derived(computeSelectionOutlinePath(grid_data, selectionForDate, simpleCellMode));

  const preview_range = $derived.by(() => {
    if (calendarMode === 'weeks') {
      if (!hovered_date) return null;
      const info = weekNumberForDate(hovered_date);
      return weekRangeFor(info.year, info.month, info.week, weekMode, currentWeekStart());
    }
    if (!pending_second_click || !anchor_date || !hovered_date) return null;
    return normalizeRange(anchor_date, hovered_date);
  });

  function isBandActive(selection: DateRangeSelection) {
    return (
      selection === 'start' ||
      selection === 'end' ||
      selection === 'in-range' ||
      selection === 'preview-start' ||
      selection === 'preview-end' ||
      selection === 'preview'
    );
  }

  function selectionForDate(date: Date): DateRangeSelection {
    const selectedWeek = selectedWeekRange();
    if (selectedWeek) {
      if (date >= selectedWeek.start && date <= selectedWeek.end) {
        if (sameDay(date, selectedWeek.start)) return 'start';
        if (sameDay(date, selectedWeek.end)) return 'end';
        return 'in-range';
      }
    }
    const current = value;
    const start = current.start ? stripTime(current.start) : null;
    if (!start) return 'none';
    const end = current.end ? stripTime(current.end) : start;
    const preview = preview_range;

    if (preview?.start && preview?.end) {
      if (sameDay(date, preview.start) && sameDay(date, preview.end)) return 'single';
      if (sameDay(date, preview.start)) return 'preview-start';
      if (sameDay(date, preview.end)) return 'preview-end';
      if (date >= preview.start && date <= preview.end) return 'preview';
    }

    if (exactYear === null) {
      const matchMD = (d1: Date, d2: Date) => d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
      if (matchMD(start, end) && matchMD(date, start)) return 'single';
      if (matchMD(date, start)) return 'start';
      if (matchMD(date, end)) return 'end';
      const dateCopy = new Date(start.getFullYear(), date.getMonth(), date.getDate());
      if (dateCopy > start && dateCopy < end) return 'in-range';
      return 'none';
    }
    if (sameDay(start, end) && sameDay(date, start)) return 'single';
    if (sameDay(date, start)) return 'start';
    if (sameDay(date, end)) return 'end';
    if (date > start && date < end) return 'in-range';
    return 'none';
  }

  function isHoveredDate(date: Date) {
    if (hovered_date) {
      if (calendarMode === 'weeks') {
        const hoveredWeek = weekNumberForDate(hovered_date);
        const cellWeek = weekNumberForDate(date);
        return hoveredWeek.year === cellWeek.year && hoveredWeek.month === cellWeek.month && hoveredWeek.week === cellWeek.week;
      }
      return Boolean(simpleCellMode && sameDay(date, hovered_date));
    }
    return false;
  }

  const simple_row_bands = $derived(computeSimpleRowBands(grid_data, selectionForDate, simpleCellMode));

  function simpleBandStyle(segment: RowBandSegment) {
    const hasStartCap = segment.shape === 'full' || segment.shape === 'left';
    const hasEndCap = segment.shape === 'full' || segment.shape === 'right';
    const endCol = segment.start_col + segment.span - 1;
    const left = hasStartCap
      ? `calc(${segment.start_col + 0.5} * (100% / 7) - var(--range-band-cap) / 2)`
      : `calc(${segment.start_col} * (100% / 7))`;
    const right = hasEndCap
      ? `calc(${7 - (endCol + 0.5)} * (100% / 7) - var(--range-band-cap) / 2)`
      : `calc(${7 - (endCol + 1)} * (100% / 7))`;

    return [
      'grid-column: 1 / -1',
      `grid-row: ${segment.row + 1}`,
      `--band-left: ${left}`,
      `--band-right: ${right}`
    ].join('; ');
  }

  function commitSingleDay(date: Date) {
    const day = stripTime(date);
    value = { start: day, end: day };
    anchor_date = day;
  }

  function startRangeSelection(date: Date) {
    vagueYear = null;
    vagueMonth = null;
    vagueDay = null;
    exactDay = null;
    clearMonthRangeDraft();
    const day = stripTime(date);
    commitSingleDay(day);
    anchor_date = day;
    hovered_date = day;
    pending_second_click = true;
  }

  function commitRangeSelection(endDate: Date) {
    const anchor = anchor_date ?? stripTime(endDate);
    value = normalizeRange(anchor, endDate);
    anchor_date = value.start;
    hovered_date = null;
    pending_second_click = false;
  }

  function getIsoWeek(d: Date): { year: number; week: number } {
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayNr = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const jan4 = new Date(target.getFullYear(), 0, 4);
    const dayNrJan4 = (jan4.getDay() + 6) % 7;
    const firstThursday = new Date(jan4.getFullYear(), 0, 4 - dayNrJan4 + 3);
    const week = Math.round((target.getTime() - firstThursday.getTime()) / 604800000) + 1;
    return { year: target.getFullYear(), week };
  }

  function handleDayClick(date: Date) {
    if (suppress_click_once) {
      suppress_click_once = false;
      return;
    }
    if (calendarMode === 'weeks') {
      vagueYear = null;
      vagueMonth = null;
      vagueDay = null;
      const weekInfo = weekNumberForDate(date);
      if (exactWeek === weekInfo.week && exactYear === weekInfo.year && exactMonth === weekInfo.month) {
        clearRange();
      } else {
        value = { start: null, end: null };
        exactWeek = weekInfo.week;
        exactYear = weekInfo.year;
        exactMonth = weekInfo.month;
      }
      return;
    }
    const current = value;
    if (current.start) {
      const currentEnd = current.end ?? current.start;
      const match = exactYear === null
        ? (current.start.getMonth() === date.getMonth() && current.start.getDate() === date.getDate() &&
           currentEnd.getMonth() === date.getMonth() && currentEnd.getDate() === date.getDate())
        : (sameDay(current.start, date) && sameDay(currentEnd, date));
      if (match) {
        clearRange();
        return;
      }
    }
    if (!pending_second_click || !anchor_date) {
      startRangeSelection(date);
      return;
    }
    commitRangeSelection(date);
  }

  function handleDayPointerDown(date: Date) {
    is_pointer_down = true;
    pointer_did_drag = false;
    suppress_click_once = true;
    pointer_origin_date = stripTime(date);
    had_pending_second_click_on_pointer_down = pending_second_click;

    if (calendarMode === 'weeks') {
      suppress_click_once = false;
      return;
    }

    if (pending_second_click && anchor_date) {
      pointer_anchor_date = anchor_date;
      hovered_date = stripTime(date);
      return;
    }

    pointer_anchor_date = stripTime(date);
    startRangeSelection(date);
  }

  function handleDayPointerEnter(date: Date) {
    if (calendarMode === 'weeks') {
      hovered_date = stripTime(date);
      return;
    }
    if (pending_second_click) {
      hovered_date = stripTime(date);
    }
    if (is_pointer_down && pointer_anchor_date) {
      hovered_date = stripTime(date);
      if (pointer_origin_date && !sameDay(pointer_origin_date, stripTime(date))) {
        pointer_did_drag = true;
      }
    }
  }

  function handlePointerUp(date?: Date) {
    if (calendarMode === 'weeks') {
      is_pointer_down = false;
      pointer_anchor_date = null;
      pointer_origin_date = null;
      pointer_did_drag = false;
      had_pending_second_click_on_pointer_down = false;
      return;
    }
    if (is_pointer_down && pointer_anchor_date) {
      const target = date ?? hovered_date ?? pointer_origin_date ?? pointer_anchor_date;
      const clicked_new_day = Boolean(pointer_origin_date && anchor_date && !sameDay(pointer_origin_date, anchor_date));
      if (pending_second_click && (pointer_did_drag || clicked_new_day || had_pending_second_click_on_pointer_down)) {
        commitRangeSelection(target);
      }
    }
    is_pointer_down = false;
    pointer_anchor_date = null;
    pointer_origin_date = null;
    pointer_did_drag = false;
    had_pending_second_click_on_pointer_down = false;
  }

  function clearRange() {
    value = { start: null, end: null };
    vagueYear = null;
    vagueMonth = null;
    vagueDay = null;
    exactWeek = null;
    exactYear = null;
    exactMonth = null;
    exactDay = null;
    calendarMode = 'exact';
    pending_second_click = false;
    anchor_date = null;
    hovered_date = null;
    is_pointer_down = false;
    pointer_anchor_date = null;
    pointer_origin_date = null;
    pointer_did_drag = false;
    had_pending_second_click_on_pointer_down = false;
    suppress_click_once = false;
    clearMonthRangeDraft();
  }

  function setVisibleMonth(target: { year: number; month: number; day?: number }, side: 'left' | 'right', anchorToTarget = true) {
    if (side === 'left') {
      viewing_date = { year: target.year, month: target.month, day: target.day ?? 1 };
      header_visible_date = { year: target.year, month: target.month };
      left_last_reported_month_key = monthKey(target);
      if (isInfiniteScroll && anchorToTarget) {
        infinite_grid_origin = monthBufferedGridOrigin(target);
        left_grid_anchor_row = 0;
        left_pending_infinite_reset = true;
        left_last_scroll_synced_month_key = null;
      }
    } else {
      right_header_visible_date = { year: target.year, month: target.month };
      right_last_reported_month_key = monthKey(target);
      if (isInfiniteScroll && anchorToTarget) {
        right_infinite_grid_origin = monthBufferedGridOrigin(target);
        right_grid_anchor_row = 0;
        right_pending_infinite_reset = true;
        right_last_scroll_synced_month_key = null;
      }
    }
  }

  let month_selector_year_mode = $state<'exact' | 'vague'>('exact');
  let month_selector_month_mode = $state<'exact' | 'vague'>('exact');
  let month_selector_temp_vague_year = $state<string | null>(null);
  const VAGUE_YEAR_ORDER: VagueYearCode[] = ['ed', 'md', 'ld', 'fh', 'sh', 'dc'];

  function openMonthSelector(side: 'left' | 'right') {
    month_selector_side = side;
    month_selector_temp_year = exactYear ?? (side === 'left' ? header_visible_date.year : right_header_visible_date.year);
    
    // Sync modes with active vague selections
    month_selector_year_mode = vagueYear ? 'vague' : 'exact';
    month_selector_month_mode = vagueMonth ? 'vague' : 'exact';
    month_selector_temp_vague_year = vagueYear;

    month_selector_open = true;
    centerYearScroll();
  }

  function handleYearSelect(year: number) {
    if (month_selector_temp_year === year) {
      month_selector_temp_year = null;
      exactYear = null;
      vagueYear = null;
      exactMonth = null;
      exactDay = null;
    } else {
      month_selector_temp_year = year;
      exactYear = year;
      vagueYear = null;
      clearMonthRangeDraft();
      const targetDate = { year, month: header_visible_date.month };
      if (month_selector_side === 'left') {
        setVisibleMonth(targetDate, 'left', true);
        if (dualMonth) {
          setVisibleMonth(addMonths(targetDate, 1), 'right', true);
        }
      } else {
        setVisibleMonth(targetDate, 'right', true);
        setVisibleMonth(addMonths(targetDate, -1), 'left', true);
      }
      centerYearScroll();
    }
  }

  function handleVagueYearSelect(code: string) {
    if (vagueYear === code) {
      vagueYear = null;
      month_selector_temp_vague_year = null;
      onSelectVague?.({ type: 'year', value: '' });
    } else {
      month_selector_temp_vague_year = code;
      vagueYear = code;
      vagueMonth = null;
      vagueDay = null;
      exactMonth = null;
      exactDay = null;
      exactWeek = null;
      onSelectVague?.({ type: 'year', value: code });
    }
    if (month_selector_open) month_selector_open = false;
  }

  function handleMonthSelect(monthIndex: number, year = month_selector_temp_year ?? header_visible_date.year) {
    const targetMonth = monthIndex + 1; // 1-indexed
    const targetDate = { year, month: targetMonth };
    month_selector_temp_year = year;

    // Commit Year: exact or vague
    vagueYear = month_selector_year_mode === 'vague' ? month_selector_temp_vague_year : null;
    vagueMonth = null;
    vagueDay = null;
    exactWeek = null;
    exactDay = null;

    if (vagueYear) {
      onSelectVague?.({ type: 'year', value: vagueYear });
    } else {
      if (!pending_month_second_click || !month_anchor) {
        startMonthRangeSelection(targetDate);
      } else {
        commitMonthRangeSelection(targetDate);
      }
    }

    if (month_selector_side === 'left') {
      setVisibleMonth(targetDate, 'left', true);
      if (dualMonth) {
        setVisibleMonth(addMonths(targetDate, 1), 'right', true);
      }
    } else {
      setVisibleMonth(targetDate, 'right', true);
      setVisibleMonth(addMonths(targetDate, -1), 'left', true);
    }
    if (month_selector_open && !pending_month_second_click) month_selector_open = false;
  }

  function handleClearExactMonth() {
    exactMonth = null;
    vagueMonth = null;
    vagueDay = null;
    exactWeek = null;
    exactDay = null;
    value = { start: null, end: null };
    clearMonthRangeDraft();
    if (month_selector_temp_year !== null) {
      exactYear = month_selector_temp_year;
    } else {
      exactYear = exactYear ?? header_visible_date.year;
    }
    if (month_selector_open) month_selector_open = false;
  }

  function handleExactDayOfYearChange(raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      exactDay = null;
      exact_day_text = '';
      return;
    }
    const nextDay = Math.max(1, Math.min(days_in_selected_year, Math.trunc(parsed)));
    exactYear = exactYear ?? header_visible_date.year;
    exactMonth = null;
    exactDay = nextDay;
    exact_day_text = String(nextDay);
    vagueYear = null;
    vagueMonth = null;
    vagueDay = null;
    exactWeek = null;
    clearMonthRangeDraft();
    value = { start: null, end: null };
  }

  function handleVagueMonthSelect(code: string) {
    if (vagueMonth === code) {
      vagueMonth = null;
      exactMonth = null;
      exactYear = null;
      onSelectVague?.({ type: 'month', value: '' });
    } else {
      vagueYear = month_selector_year_mode === 'vague' ? month_selector_temp_vague_year : null;
      vagueMonth = code;
      vagueDay = null;
      exactMonth = null;
      exactDay = null;
      exactWeek = null;
      clearMonthRangeDraft();
      if (!vagueYear) {
        exactYear = header_visible_date.year;
      } else {
        exactYear = null;
      }

      onSelectVague?.({ type: 'month', value: code });
      if (vagueYear) {
        onSelectVague?.({ type: 'year', value: vagueYear });
      }
    }

    if (month_selector_open) month_selector_open = false;
  }

  function handleVagueDaySelect(code: string) {
    vagueYear = null;
    vagueMonth = null;
    exactDay = null;
    exactWeek = null;
    clearMonthRangeDraft();
    if (vagueDay === code) {
      vagueDay = null;
      exactMonth = null;
      exactYear = null;
      onSelectVague?.({ type: 'day', value: '' });
    } else {
      vagueDay = code;
      exactMonth = header_visible_date.month;
      exactYear = header_visible_date.year;
      onSelectVague?.({ type: 'day', value: code });
    }
    if (month_selector_open) month_selector_open = false;
  }

  function centerYearScroll() {
    tick().then(() => {
      const container = years_scroll_ref;
      let selectedEl = container?.querySelector('[data-selected="true"]') ?? null;
      if (!selectedEl && container) {
        const yearButtons = container.querySelectorAll('button');
        const visibleYearStr = String(header_visible_date.year);
        for (const btn of yearButtons) {
          if (btn.textContent?.trim() === visibleYearStr) {
            selectedEl = btn;
            break;
          }
        }
      }
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'center', behavior: 'instant' as any });
      }
      centerMonthGridScroll();
    });
  }

  function centerMonthGridScroll() {
    tick().then(() => {
      const monthsContainer = month_selector_months_scroll_ref;
      const selectedYear = month_selector_temp_year ?? header_visible_date.year;
      const selectedMonthBand = monthsContainer?.querySelector<HTMLElement>(`[data-year="${selectedYear}"]`);
      if (monthsContainer && selectedMonthBand) {
        monthsContainer.scrollTop = Math.max(
          0,
          selectedMonthBand.offsetTop - monthsContainer.clientHeight / 2 + selectedMonthBand.clientHeight / 2
        );
      }
    });
  }

  $effect(() => {
    if (calendarMode === 'approx') {
      centerYearScroll();
    }
  });

  function goPreviousMonth() {
    if (dualMonth) {
      setVisibleMonth(addMonths(header_visible_date, -1), 'left');
      setVisibleMonth(addMonths(right_header_visible_date, -1), 'right');
    } else {
      setVisibleMonth(addMonths(header_visible_date, -1), 'left');
    }
  }

  function goToToday() {
    const today = new Date();
    if (dualMonth) {
      setVisibleMonth({ year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }, 'left');
      setVisibleMonth(addMonths({ year: today.getFullYear(), month: today.getMonth() + 1 }, 1), 'right');
    } else {
      setVisibleMonth({ year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }, 'left');
    }
  }

  function goNextMonth() {
    if (dualMonth) {
      setVisibleMonth(addMonths(header_visible_date, 1), 'left');
      setVisibleMonth(addMonths(right_header_visible_date, 1), 'right');
    } else {
      setVisibleMonth(addMonths(header_visible_date, 1), 'left');
    }
  }

  onMount(() => {
    resize_observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === left_scroll_container_ref) {
          left_container_height = entry.contentRect.height;
        } else if (entry.target === right_scroll_container_ref) {
          right_container_height = entry.contentRect.height;
        }
      }
    });
    if (left_scroll_container_ref) resize_observer.observe(left_scroll_container_ref);
    if (right_scroll_container_ref) resize_observer.observe(right_scroll_container_ref);
    const onWindowPointerUp = () => handlePointerUp();
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      resize_observer?.disconnect();
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  });

  $effect(() => {
    if (left_scroll_container_ref && resize_observer) {
      resize_observer.observe(left_scroll_container_ref);
    }
    return () => {
      if (left_scroll_container_ref && resize_observer) {
        resize_observer.unobserve(left_scroll_container_ref);
      }
    };
  });

  $effect(() => {
    if (right_scroll_container_ref && resize_observer) {
      resize_observer.observe(right_scroll_container_ref);
    }
    return () => {
      if (right_scroll_container_ref && resize_observer) {
        resize_observer.unobserve(right_scroll_container_ref);
      }
    };
  });

  $effect(() => {
    const current_viewing = viewing_date;
    const current_header = untrack(() => header_visible_date);
    if (monthKey(current_viewing) !== monthKey(current_header)) {
      header_visible_date = { year: current_viewing.year, month: current_viewing.month };
      right_header_visible_date = addMonths(current_viewing, 1);
    }
  });

  $effect(() => {
    if (isInfiniteScroll && !last_infinite_mode) {
      left_pending_infinite_reset = true;
      right_pending_infinite_reset = true;
    }
    last_infinite_mode = isInfiniteScroll;
  });

  $effect(() => {
    if (!isInfiniteScroll) {
      left_pending_infinite_reset = false;
      left_infinite_recenter_pending = false;
      left_last_scroll_synced_month_key = null;
      infinite_grid_origin = monthBufferedGridOrigin(viewing_date);
      left_grid_anchor_row = 0;

      right_pending_infinite_reset = false;
      right_infinite_recenter_pending = false;
      right_last_scroll_synced_month_key = null;
      right_infinite_grid_origin = monthBufferedGridOrigin(addMonths(viewing_date, 1));
      right_grid_anchor_row = 0;
      return;
    }

    const visibleKey = monthKey(viewing_date);

    if (untrack(() => left_last_scroll_synced_month_key) === visibleKey) {
      if (infinite_grid_origin === null) {
        infinite_grid_origin = monthBufferedGridOrigin(viewing_date);
        right_infinite_grid_origin = monthBufferedGridOrigin(addMonths(viewing_date, 1));
      }
      return;
    }

    infinite_grid_origin = monthBufferedGridOrigin(viewing_date);
    right_infinite_grid_origin = monthBufferedGridOrigin(addMonths(viewing_date, 1));
    left_grid_anchor_row = 0;
    right_grid_anchor_row = 0;
    header_visible_date = { year: viewing_date.year, month: viewing_date.month };
    right_header_visible_date = addMonths(viewing_date, 1);
    left_last_reported_month_key = visibleKey;
    right_last_reported_month_key = monthKey(addMonths(viewing_date, 1));
    left_pending_infinite_reset = true;
    right_pending_infinite_reset = true;
  });

  $effect(() => {
    if (!isInfiniteScroll) return;
    if (left_pending_infinite_reset) {
      left_pending_infinite_reset = false;
      void resetInfiniteScrollPosition('left');
    }
    if (right_pending_infinite_reset) {
      right_pending_infinite_reset = false;
      void resetInfiniteScrollPosition('right');
    }
  });

  $effect(() => {
    if (isVagueActive) {
      if (value.start !== null || value.end !== null) {
        value = { start: null, end: null };
      }
    }
  });

  $effect(() => {
    const next = exactDay !== null ? String(exactDay) : '';
    if (exact_day_text !== next) {
      exact_day_text = next;
    }
  });

  $effect(() => {
    const next = String(weekStart);
    if (week_start_text !== next) {
      week_start_text = next;
    }
  });
</script>

<div
  class={`date-range-calendar relative flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] ${className}`}
  style={style}
>
  {#snippet vagueOptionsPane(visibleDate: { year: number; month: number }, side: 'left' | 'right')}
    {@const mName = monthLabel(visibleDate).split(' ')[0]}
    {@const year = visibleDate.year}
    <div class="flex flex-col h-full items-center justify-center p-6 bg-[var(--color-background)]">
      <div class="w-full max-w-xs flex flex-col gap-4">
        <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] text-center mb-1">
          {mName} {year}
        </span>

        <!-- Deciles Section -->
        <div>
          <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]/80 mb-2 block">
            Deciles
          </span>
          <div class="grid grid-cols-3 gap-2">
            {#each ['em', 'mm', 'lm'] as code}
              {@const label = code === 'em' ? 'Early' : code === 'mm' ? 'Mid' : 'Late'}
              {@const info = VAGUE_DAYS[code as VagueDayCode]}
              {@const isSelected = vagueDay === code && !vagueYear && !vagueMonth && header_visible_date.month === visibleDate.month && header_visible_date.year === visibleDate.year}
              <button
                type="button"
                class={`py-2 px-1 text-center text-xs rounded-[var(--radius-md)] border transition-all flex flex-col items-center justify-center gap-0.5 ${
                  isSelected
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                    : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                }`}
                onclick={() => {
                  if (side === 'right') {
                    setVisibleMonth(visibleDate, 'left', true);
                    if (dualMonth) {
                      setVisibleMonth(addMonths(visibleDate, 1), 'right', true);
                    }
                  }
                  handleVagueDaySelect(code);
                }}
              >
                <span class="text-xs font-bold">{label}</span>
                <span class="text-[9px] opacity-75 font-medium">Days {info.range[0]}–{info.range[1]}</span>
              </button>
            {/each}
          </div>
        </div>

        <!-- Halves Section -->
        <div>
          <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]/80 mb-2 block">
            Halves
          </span>
          <div class="grid grid-cols-2 gap-2">
            {#each ['fh', 'sh'] as code}
              {@const label = code === 'fh' ? 'First Half' : 'Second Half'}
              {@const info = VAGUE_DAYS[code as VagueDayCode]}
              {@const isSelected = vagueDay === code && !vagueYear && !vagueMonth && header_visible_date.month === visibleDate.month && header_visible_date.year === visibleDate.year}
              <button
                type="button"
                class={`py-2 px-3 text-center text-xs rounded-[var(--radius-md)] border transition-all flex flex-col items-center justify-center gap-0.5 ${
                  isSelected
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                    : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                }`}
                onclick={() => {
                  if (side === 'right') {
                    setVisibleMonth(visibleDate, 'left', true);
                    if (dualMonth) {
                      setVisibleMonth(addMonths(visibleDate, 1), 'right', true);
                    }
                  }
                  handleVagueDaySelect(code);
                }}
              >
                <span class="text-xs font-bold">{label}</span>
                <span class="text-[9px] opacity-75 font-medium">Days {info.range[0]}–{info.range[1]}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/snippet}

  {#if allowVague || isInfiniteScroll || calendarMode === 'weeks'}
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2 bg-[var(--color-muted)]/10 shrink-0">
      <div class="flex flex-wrap items-center gap-2">
        {#if allowVague}
          <SegmentedControl
            options={[
              { value: 'exact', label: 'Exact Dates' },
              { value: 'weeks', label: 'Weeks' },
              { value: 'approx', label: 'Approx / Vague' }
            ]}
            bind:value={calendarMode}
            onValueChange={(val) => handleModeChange(val as 'exact' | 'weeks' | 'approx')}
            class="w-fit"
          />
        {/if}

        {#if calendarMode === 'weeks'}
          <SegmentedControl
            ariaLabel="Week mode"
            options={week_mode_options}
            value={weekMode}
            onValueChange={(val) => updateWeekMode(val as WeekModeCode)}
            class="w-fit"
          />
          {#if weekMode === 'row'}
            <div class="w-24">
              <NumberInput
                value={week_start_text}
                min={0}
                max={6}
                step={1}
                onchange={updateWeekStart}
              />
            </div>
          {/if}
        {/if}
      </div>

      {#if isInfiniteScroll}
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)]/40 bg-[var(--color-muted)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)]/75 hover:text-[var(--color-foreground)]"
            onclick={() => openMonthSelector('left')}
            aria-label="Select month and year"
          >
            <span>{monthScopeLabel(header_visible_date)}</span>
            <svg class="size-3.5 opacity-60" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/>
            </svg>
          </button>
          {#if dualMonth}
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)]/40 bg-[var(--color-muted)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)]/75 hover:text-[var(--color-foreground)]"
              onclick={() => openMonthSelector('right')}
              aria-label="Select right month and year"
            >
              <span>{monthScopeLabel(right_header_visible_date)}</span>
              <svg class="size-3.5 opacity-60" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/>
              </svg>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if showHeader}
    <div class="bg-[var(--color-background)]/96">
      {#if dualMonth}
        <div class="flex items-end gap-3 px-4 pt-2">
          <button class="range-nav-btn shrink-0" type="button" onclick={goPreviousMonth} aria-label="Previous month">Previous</button>
          <div class="flex min-w-0 flex-1 items-end gap-3">
            <span class="inline-flex min-w-0 flex-1 items-center justify-center rounded-t-[var(--radius-md)] rounded-b-none border border-b-0 border-[var(--color-border)]/50 bg-[var(--color-muted)]/55 px-3 py-1.5 text-xs font-semibold text-[var(--color-muted-foreground)]">
              Viewing: {monthScopeLabel(header_visible_date)}
            </span>
            <span class="inline-flex min-w-0 flex-1 items-center justify-center rounded-t-[var(--radius-md)] rounded-b-none border border-b-0 border-[var(--color-border)]/50 bg-[var(--color-muted)]/55 px-3 py-1.5 text-xs font-semibold text-[var(--color-muted-foreground)]">
              Viewing: {monthScopeLabel(right_header_visible_date)}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button class="range-nav-btn" type="button" onclick={goToToday} aria-label="Today">Today</button>
            <button class="range-nav-btn" type="button" onclick={goNextMonth} aria-label="Next month">Next</button>
          </div>
        </div>
      {:else}
        <div class="flex items-end justify-between gap-3 px-4 pt-2">
          <span class="inline-flex min-w-0 items-center rounded-t-[var(--radius-md)] rounded-b-none border border-b-0 border-[var(--color-border)]/50 bg-[var(--color-muted)]/55 px-3 py-1.5 text-xs font-semibold text-[var(--color-muted-foreground)] shrink-0">
            Viewing: {monthScopeLabel(header_visible_date)}
          </span>
          <div class="flex shrink-0 items-center gap-2">
            <button class="range-nav-btn" type="button" onclick={goPreviousMonth} aria-label="Previous month">Previous</button>
            <button class="range-nav-btn" type="button" onclick={goToToday} aria-label="Today">Today</button>
            <button class="range-nav-btn" type="button" onclick={goNextMonth} aria-label="Next month">Next</button>
          </div>
        </div>
        {#if showWeekdays && !uses_year_day_editor}
          <div class="grid border-b border-[var(--color-border)] bg-[var(--color-muted)]/35" style="grid-template-columns: repeat(7, minmax(0, 1fr))">
            {#each adjusted_weekdays as day}
              <div class="py-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">
                {day}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <div
    class="relative h-0 flex-1 min-h-0 overflow-hidden"
  >
    {#if vagueYear}
      <!-- Vague Year Active Placeholder -->
      <div class="p-6 h-full flex flex-col items-center justify-center text-center bg-[var(--color-background)] animate-fade-in">
        <div class="rounded-full bg-[var(--color-primary)]/10 p-4 mb-4 text-[var(--color-primary)] animate-scale-in">
          <svg class="size-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
          </svg>
        </div>
        <h3 class="text-sm font-semibold text-[var(--color-foreground)] mb-1">
          Approximate Year Selection Active
        </h3>
        <p class="text-xs text-[var(--color-muted-foreground)] max-w-xs mb-4">
          You have selected <span class="font-semibold text-[var(--color-foreground)]">{VAGUE_YEARS[vagueYear as VagueYearCode]?.label || vagueYear}</span>. No further months, weeks, or days can be specified under the hierarchy.
        </p>
        <button
          type="button"
          class="range-clear-btn hover:bg-[var(--color-muted)] transition-colors px-4 py-2 text-xs font-semibold rounded-[var(--radius-md)] border border-[var(--color-border)] cursor-pointer"
          onclick={() => {
            vagueYear = null;
            calendarMode = 'exact';
          }}
        >
          Clear Year
        </button>
      </div>
    {:else if vagueMonth}
      <!-- Vague Month Active Placeholder -->
      <div class="p-6 h-full flex flex-col items-center justify-center text-center bg-[var(--color-background)] animate-fade-in">
        <div class="rounded-full bg-[var(--color-primary)]/10 p-4 mb-4 text-[var(--color-primary)] animate-scale-in">
          <svg class="size-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5m-9-6h.008v.008H12v-.008ZM12 15h.008v.008H12V15Zm0 2.25h.008v.008H12v-.008ZM9.75 15h.008v.008H9.75V15Zm0 2.25h.008v.008H9.75v-.008Z" />
          </svg>
        </div>
        <h3 class="text-sm font-semibold text-[var(--color-foreground)] mb-1">
          Approximate Month Selection Active
        </h3>
        <p class="text-xs text-[var(--color-muted-foreground)] max-w-xs mb-4">
          You have selected <span class="font-semibold text-[var(--color-foreground)]">{VAGUE_MONTHS[vagueMonth as VagueMonthCode]?.label || vagueMonth}</span>. No further weeks, days, or times can be specified under the hierarchy.
        </p>
        <button
          type="button"
          class="range-clear-btn hover:bg-[var(--color-muted)] transition-colors px-4 py-2 text-xs font-semibold rounded-[var(--radius-md)] border border-[var(--color-border)] cursor-pointer"
          onclick={() => {
            vagueMonth = null;
            calendarMode = 'exact';
          }}
        >
          Clear Month
        </button>
      </div>
    {:else if calendarMode === 'approx'}
      {#if uses_year_day_editor}
        <div class="p-4 h-full min-h-0 bg-[var(--color-background)]">
          <div class="flex h-full flex-col items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] p-6">
            <div class="w-full max-w-xs space-y-4">
              <div class="text-center">
                <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {exactYear}
                </span>
                <h3 class="mt-1 text-sm font-semibold text-[var(--color-foreground)]">Day of year</h3>
              </div>

              <div class="space-y-2">
                <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]/80">
                  Nth day
                </span>
                <NumberInput
                  bind:value={exact_day_text}
                  min={1}
                  max={days_in_selected_year}
                  step={1}
                  placeholder={`1-${days_in_selected_year}`}
                  onchange={handleExactDayOfYearChange}
                />
              </div>

              {#if exactDay !== null}
                <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-center text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
                  <span class="font-medium text-[var(--color-foreground)]">{formatDayOfYear(exactDay)}</span>
                  <span> of {exactYear}</span>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {:else if dualMonth}
        <div class="p-4 h-full min-h-0 bg-[var(--color-background)]">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-0 border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-background)] h-full">
            <!-- Left Month Pane -->
            <div class="flex flex-col min-w-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] overflow-y-auto scrollbar-hide">
              {@render vagueOptionsPane(header_visible_date, 'left')}
            </div>
            <!-- Right Month Pane -->
            <div class="flex flex-col min-w-0 overflow-y-auto scrollbar-hide">
              {@render vagueOptionsPane(right_header_visible_date, 'right')}
            </div>
          </div>
        </div>
      {:else}
        <div class="p-4 h-full min-h-0 bg-[var(--color-background)]">
          <div class="border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-background)] h-full overflow-y-auto scrollbar-hide">
            {@render vagueOptionsPane(header_visible_date, 'left')}
          </div>
        </div>
      {/if}
    {:else if uses_year_day_editor}
      <div class="p-4 h-full min-h-0 bg-[var(--color-background)]">
        <div class="flex h-full flex-col items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background)] p-6">
          <div class="w-full max-w-xs space-y-4">
            <div class="text-center">
              <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                {exactYear}
              </span>
              <h3 class="mt-1 text-sm font-semibold text-[var(--color-foreground)]">Concrete day of year</h3>
            </div>

            <div class="space-y-2">
              <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]/80">
                Nth day
              </span>
              <NumberInput
                bind:value={exact_day_text}
                min={1}
                max={days_in_selected_year}
                step={1}
                placeholder={`1-${days_in_selected_year}`}
                onchange={handleExactDayOfYearChange}
              />
            </div>

            {#if exactDay !== null}
              <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-center text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
                <span class="font-medium text-[var(--color-foreground)]">{formatDayOfYear(exactDay)}</span>
                <span> of {exactYear}</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      {#if dualMonth}
      <div class="p-4 h-full min-h-0">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-0 border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-background)] h-full">
          <!-- Left Month Pane -->
          <div
            bind:this={left_scroll_container_ref}
            class="flex flex-col min-w-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-background)] overflow-y-auto overflow-x-hidden overscroll-none scrollbar-hide"
            style="overflow-anchor: none;"
            onscroll={() => syncVisibleMonthFromScroll('left')}
          >
            {#if showWeekdays}
              <div class="sticky top-0 z-[var(--z-floating)] bg-[var(--color-background)]">
                <div class="grid border-b border-[var(--color-border)] bg-[var(--color-muted)]/35" style="grid-template-columns: repeat(7, minmax(0, 1fr))">
                  {#each adjusted_weekdays as day}
                    <div class="py-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">
                      {day}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
            <div role="presentation" class="grid relative flex-1" class:selection-pending={pending_second_click} onpointerleave={() => { if (calendarMode === 'weeks') hovered_date = null; }} style={left_grid_style}>
              {#if showMonthOutline}
                <SvgOverlay
                  grid_data={left_overlay_grid_data}
                  view_options={overlay_view_options}
                  viewing_date={header_visible_date}
                  cell_inset_y_ratio={0}
                  cell_offset_y_ratio={0}
                  z_index={simpleCellMode ? 0 : 2}
                />
              {/if}
              {#if simpleCellMode}
                {#each left_simple_row_bands as segment (segment.key)}
                  <div
                    class={`range-row-band ${segment.preview ? 'range-row-band--preview' : ''} range-row-band--${segment.shape}`}
                    style={simpleBandStyle(segment)}
                  ></div>
                {/each}
              {/if}

              <!-- Selection Outline SVG -->
              {#if !simpleCellMode && left_selection_outline_path}
                <div class="pointer-events-none absolute inset-0 z-[var(--z-raised)]">
                  <svg class="size-full overflow-visible" viewBox={`0 0 700 ${left_grid_data.length * 100}`} preserveAspectRatio="none" aria-hidden="true">
                    <path
                      d={left_selection_outline_path}
                      fill="none"
                      stroke="var(--color-primary)"
                      stroke-width="2"
                      stroke-linejoin="miter"
                    />
                  </svg>
                </div>
              {/if}

              {#each left_grid_data as row, rowIdx}
                {#each row as cell, colIdx}
                  {@const selection = selectionForDate(cell.date)}
                  {@const isCurrentMonth = cell.date.getMonth() === header_visible_date.month - 1 && cell.date.getFullYear() === header_visible_date.year}
                  {@const hovered = isHoveredDate(cell.date)}
                  <button
                    type="button"
                    class={`range-cell ${simpleCellMode ? 'range-cell--simple' : ''} ${hovered ? 'range-cell--hovered' : ''} ${isCurrentMonth ? '' : 'range-cell--outside'} range-cell--${selection} ${colIdx === 0 ? 'range-cell--first-col' : ''} ${colIdx === 6 ? 'range-cell--last-col' : ''}`}
                    style={`grid-column: ${colIdx + 1}; grid-row: ${rowIdx + 1};`}
                    onclick={() => handleDayClick(cell.date)}
                    onpointerdown={() => handleDayPointerDown(cell.date)}
                    onpointerenter={() => handleDayPointerEnter(cell.date)}
                    onpointerup={() => handlePointerUp(cell.date)}
                    aria-label={`${cell.date.getDate()}, ${cell.date.toDateString()}`}
                  >
                    {#if simpleCellMode}
                      <span class="range-cell__simple-day">{cell.date.getDate()}</span>
                    {:else}
                      <span class="range-cell__day">{cell.date.getDate()}</span>
                    {/if}
                  </button>
                {/each}
              {/each}
            </div>
          </div>

          <!-- Right Month Pane -->
          <div
            bind:this={right_scroll_container_ref}
            class="flex flex-col min-w-0 bg-[var(--color-background)] overflow-y-auto overflow-x-hidden overscroll-none scrollbar-hide"
            style="overflow-anchor: none;"
            onscroll={() => syncVisibleMonthFromScroll('right')}
          >
            {#if showWeekdays}
              <div class="sticky top-0 z-[var(--z-floating)] bg-[var(--color-background)]">
                <div class="grid border-b border-[var(--color-border)] bg-[var(--color-muted)]/35" style="grid-template-columns: repeat(7, minmax(0, 1fr))">
                  {#each adjusted_weekdays as day}
                    <div class="py-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">
                      {day}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
            <div role="presentation" class="grid relative flex-1" class:selection-pending={pending_second_click} onpointerleave={() => { if (calendarMode === 'weeks') hovered_date = null; }} style={right_grid_style}>
              {#if showMonthOutline}
                <SvgOverlay
                  grid_data={right_overlay_grid_data}
                  view_options={overlay_view_options}
                  viewing_date={right_header_visible_date}
                  cell_inset_y_ratio={0}
                  cell_offset_y_ratio={0}
                  z_index={simpleCellMode ? 0 : 2}
                />
              {/if}
              {#if simpleCellMode}
                {#each right_simple_row_bands as segment (segment.key)}
                  <div
                    class={`range-row-band ${segment.preview ? 'range-row-band--preview' : ''} range-row-band--${segment.shape}`}
                    style={simpleBandStyle(segment)}
                  ></div>
                {/each}
              {/if}

              <!-- Selection Outline SVG -->
              {#if !simpleCellMode && right_selection_outline_path}
                <div class="pointer-events-none absolute inset-0 z-[var(--z-raised)]">
                  <svg class="size-full overflow-visible" viewBox={`0 0 700 ${right_grid_data.length * 100}`} preserveAspectRatio="none" aria-hidden="true">
                    <path
                      d={right_selection_outline_path}
                      fill="none"
                      stroke="var(--color-primary)"
                      stroke-width="2"
                      stroke-linejoin="miter"
                    />
                  </svg>
                </div>
              {/if}

              {#each right_grid_data as row, rowIdx}
                {#each row as cell, colIdx}
                  {@const selection = selectionForDate(cell.date)}
                  {@const isCurrentMonth = cell.date.getMonth() === right_header_visible_date.month - 1 && cell.date.getFullYear() === right_header_visible_date.year}
                  {@const hovered = isHoveredDate(cell.date)}
                  <button
                    type="button"
                    class={`range-cell ${simpleCellMode ? 'range-cell--simple' : ''} ${hovered ? 'range-cell--hovered' : ''} ${isCurrentMonth ? '' : 'range-cell--outside'} range-cell--${selection} ${colIdx === 0 ? 'range-cell--first-col' : ''} ${colIdx === 6 ? 'range-cell--last-col' : ''}`}
                    style={`grid-column: ${colIdx + 1}; grid-row: ${rowIdx + 1};`}
                    onclick={() => handleDayClick(cell.date)}
                    onpointerdown={() => handleDayPointerDown(cell.date)}
                    onpointerenter={() => handleDayPointerEnter(cell.date)}
                    onpointerup={() => handlePointerUp(cell.date)}
                    aria-label={`${cell.date.getDate()}, ${cell.date.toDateString()}`}
                  >
                    {#if simpleCellMode}
                      <span class="range-cell__simple-day">{cell.date.getDate()}</span>
                    {:else}
                      <span class="range-cell__day">{cell.date.getDate()}</span>
                    {/if}
                  </button>
                {/each}
              {/each}
            </div>
          </div>
        </div>
      </div>
    {:else}
      <div
        bind:this={left_scroll_container_ref}
        class="absolute inset-0 min-h-0 overflow-y-auto overflow-x-hidden overscroll-none scrollbar-hide"
        style="overflow-anchor: none;"
        onscroll={() => syncVisibleMonthFromScroll('left')}
      >
        {#if !showHeader}
          <div class="sticky top-0 z-[var(--z-raised)] flex items-center justify-center pointer-events-none py-1">
            <span class="text-[11px] font-semibold tracking-wide text-muted-foreground bg-background/80 backdrop-blur-sm px-3 py-0.5 rounded-full border shadow-sm pointer-events-auto">
              {monthScopeLabel(header_visible_date)}
            </span>
          </div>
        {/if}
        <div bind:this={grid_ref} role="presentation" class="grid relative" class:selection-pending={pending_second_click} onpointerleave={() => { if (calendarMode === 'weeks') hovered_date = null; }} style={grid_style}>
          {#if showMonthOutline}
            <SvgOverlay
              grid_data={overlay_grid_data}
              view_options={overlay_view_options}
              viewing_date={header_visible_date}
              cell_inset_y_ratio={0}
              cell_offset_y_ratio={0}
              z_index={simpleCellMode ? 0 : 2}
            />
          {/if}
          {#if simpleCellMode}
            {#each simple_row_bands as segment (segment.key)}
              <div
                class={`range-row-band ${segment.preview ? 'range-row-band--preview' : ''} range-row-band--${segment.shape}`}
                style={simpleBandStyle(segment)}
              ></div>
            {/each}
          {/if}

          <!-- Selection Outline SVG -->
          {#if !simpleCellMode && selection_outline_path}
            <div class="pointer-events-none absolute inset-0 z-[var(--z-raised)]">
              <svg class="size-full overflow-visible" viewBox={`0 0 700 ${grid_data.length * 100}`} preserveAspectRatio="none" aria-hidden="true">
                <path
                  d={selection_outline_path}
                  fill="none"
                  stroke="var(--color-primary)"
                  stroke-width="2"
                  stroke-linejoin="miter"
                />
              </svg>
            </div>
          {/if}

          {#each grid_data as row, rowIdx}
            {#each row as cell, colIdx}
              {@const selection = selectionForDate(cell.date)}
              {@const isCurrentMonth = cell.date.getMonth() === header_visible_date.month - 1 && cell.date.getFullYear() === header_visible_date.year}
              {@const hovered = isHoveredDate(cell.date)}
              <button
                type="button"
                class={`range-cell ${simpleCellMode ? 'range-cell--simple' : ''} ${hovered ? 'range-cell--hovered' : ''} ${isCurrentMonth ? '' : 'range-cell--outside'} range-cell--${selection} ${colIdx === 0 ? 'range-cell--first-col' : ''} ${colIdx === 6 ? 'range-cell--last-col' : ''}`}
                style={`grid-column: ${colIdx + 1}; grid-row: ${rowIdx + 1};`}
                onclick={() => handleDayClick(cell.date)}
                onpointerdown={() => handleDayPointerDown(cell.date)}
                onpointerenter={() => handleDayPointerEnter(cell.date)}
                onpointerup={() => handlePointerUp(cell.date)}
                aria-label={`${cell.date.getDate()}, ${cell.date.toDateString()}`}
              >
                {#if simpleCellMode}
                  <span class="range-cell__simple-day">{cell.date.getDate()}</span>
                {:else}
                  <span class="range-cell__day">{cell.date.getDate()}</span>
                {/if}
              </button>
            {/each}
          {/each}
        </div>
      </div>
    {/if}
  {/if}
  </div>

  {#if showFooter}
    <div class="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3">
      <div class="min-w-0">
        <p class="truncate text-[var(--text-sm)] font-medium text-[var(--color-foreground)]">
          {isVagueActive || (exactDay !== null && exactMonth === null) ? vagueLabel : formatRangeLabel(value)}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button class="range-clear-btn" type="button" onclick={clearRange} aria-label="Clear">Clear</button>
        {#if onDone}
          <button class="range-done-btn" type="button" onclick={onDone} aria-label="Done">Done</button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Month-Year Quick Selection Popup -->
  <DateRangeMonthSelector
    bind:month_selector_open
    {allowVague}
    bind:month_selector_year_mode
    bind:month_selector_month_mode
    bind:vagueYear
    bind:vagueMonth
    bind:vagueDay
    bind:exactMonth
    {month_selector_temp_year}
    {month_selector_temp_vague_year}
    {pending_month_second_click}
    {year_range}
    {VAGUE_YEAR_ORDER}
    {VAGUE_YEARS}
    {month_names_short}
    {VAGUE_MONTHS}
    {handleYearSelect}
    {handleVagueYearSelect}
    {handleMonthSelect}
    {handleVagueMonthSelect}
    {handleClearExactMonth}
    {monthSelectionFor}
    bind:years_scroll_ref
    bind:month_selector_months_scroll_ref
    bind:hovered_month
  />
</div>

<style>
  .scrollbar-hide {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }

  .date-range-calendar {
    --range-band-cap: 1.75rem;
    --range-band-height: 1.75rem;
  }

  .range-nav-btn,
  .range-clear-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: calc(var(--radius-md) - 0.15rem);
    border: 1px solid color-mix(in srgb, var(--color-border), transparent 12%);
    background: color-mix(in srgb, var(--color-panel), transparent 8%);
    padding: 0.45rem 0.78rem;
    font-size: var(--text-xsm);
    font-weight: 600;
    color: var(--color-foreground);
    transition: background 120ms ease, border-color 120ms ease;
  }

  .range-nav-btn:hover,
  .range-clear-btn:hover {
    background: color-mix(in srgb, var(--color-muted), var(--color-panel) 24%);
  }

  .range-nav-btn:focus-visible,
  .range-clear-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--color-background), 0 0 0 4px var(--color-primary);
  }

  .range-done-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: calc(var(--radius-md) - 0.15rem);
    border: 1px solid var(--color-primary);
    background: var(--color-primary);
    padding: 0.45rem 0.78rem;
    font-size: var(--text-xsm);
    font-weight: 600;
    color: white;
    transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
    cursor: pointer;
  }

  .range-done-btn:hover {
    background: color-mix(in srgb, var(--color-primary), black 12%);
    border-color: color-mix(in srgb, var(--color-primary), black 12%);
  }

  .range-done-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--color-background), 0 0 0 4px var(--color-primary);
  }

  .range-cell {
    appearance: none;
    position: relative;
    z-index: 1;
    display: block;
    min-height: 48px;
    padding: 0;
    overflow: hidden;
    border-right: 1px solid color-mix(in srgb, var(--color-border), transparent 18%);
    border-bottom: 1px solid color-mix(in srgb, var(--color-border), transparent 18%);
    background: var(--color-background);
    text-align: left;
    color: var(--color-foreground);
    transition: background 120ms ease;
  }

  .range-cell:focus {
    outline: none;
  }

  .range-cell:focus-visible {
    outline: none;
  }

  .range-cell:focus-visible .range-cell__day,
  .range-cell:focus-visible .range-cell__simple-day {
    box-shadow: 0 0 0 2px var(--color-background), 0 0 0 4px var(--color-primary);
  }

  .range-cell--simple {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border-right: 0;
    border-bottom: 0;
    min-height: 0;
    transition: none;
    z-index: 2;
  }

  .range-cell--simple {
    overflow: visible;
  }

  .range-cell--simple::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--range-band-cap);
    height: var(--range-band-cap);
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.92);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary), transparent 82%);
    transition: background 140ms ease, opacity 140ms ease, transform 140ms ease;
  }

  .range-cell--simple.range-cell--single::before,
  .range-cell--simple.range-cell--start::before,
  .range-cell--simple.range-cell--end::before,
  .range-cell--simple.range-cell--preview-start::before,
  .range-cell--simple.range-cell--preview-end::before {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }

  .grid:not(.selection-pending) .range-cell--simple.range-cell--single::before,
  .grid:not(.selection-pending) .range-cell--simple.range-cell--start::before,
  .grid:not(.selection-pending) .range-cell--simple.range-cell--end::before {
    box-shadow: 0 0 0 1.5px var(--color-background), 0 0 0 3px var(--color-primary);
  }

  .range-cell--simple.range-cell--preview-start::before,
  .range-cell--simple.range-cell--preview-end::before,
  .range-cell--simple.range-cell--hovered::before,
  .range-cell--simple:hover::before {
    background: color-mix(in srgb, var(--color-primary), transparent 88%);
  }

  .range-cell--simple:hover::before {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.04);
  }

  .range-cell:hover:not(.range-cell--simple):not(.range-cell--single):not(.range-cell--start):not(.range-cell--end):not(.range-cell--preview-start):not(.range-cell--preview-end) .range-cell__day {
    background: color-mix(in srgb, var(--color-primary), transparent 90%);
  }

  .range-cell--simple:hover:not(.range-cell--outside) {
    background: transparent;
  }

  .range-cell--outside {
    color: color-mix(in srgb, var(--color-muted-foreground), transparent 20%);
    background: color-mix(in srgb, var(--color-muted), transparent 68%);
  }

  .range-cell--in-range:not(.range-cell--simple),
  .range-cell--preview:not(.range-cell--simple),
  .range-cell--start:not(.range-cell--simple),
  .range-cell--end:not(.range-cell--simple),
  .range-cell--preview-start:not(.range-cell--simple),
  .range-cell--preview-end:not(.range-cell--simple) {
    background: color-mix(in srgb, var(--color-primary), transparent 90%);
  }

  .range-cell__day,
  .range-cell__simple-day {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    margin: 0.35rem;
    border-radius: 999px;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .range-cell__day {
    height: 2rem;
    width: 2rem;
    transition: background 120ms ease, color 120ms ease, box-shadow 120ms ease;
  }

  .range-cell__simple-day {
    min-width: 1.75rem;
    height: 1.75rem;
    margin: 0;
    font-size: var(--text-xsm);
  }

  .range-cell--single .range-cell__day,
  .range-cell--start .range-cell__day,
  .range-cell--end .range-cell__day,
  .range-cell--preview-start .range-cell__day,
  .range-cell--preview-end .range-cell__day {
    background: var(--color-primary);
    color: var(--color-primary-foreground);
  }

  .grid:not(.selection-pending) .range-cell--single .range-cell__day,
  .grid:not(.selection-pending) .range-cell--start .range-cell__day,
  .grid:not(.selection-pending) .range-cell--end .range-cell__day {
    box-shadow: 0 0 0 2px var(--color-background), 0 0 0 4px var(--color-primary);
  }

  .range-row-band {
    align-self: stretch;
    position: relative;
    justify-self: stretch;
    z-index: 1;
    pointer-events: none;
  }

  .range-row-band::before {
    content: '';
    position: absolute;
    top: 50%;
    height: var(--range-band-height);
    transform: translateY(-50%);
    left: var(--band-left);
    right: var(--band-right);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary), transparent 82%);
  }

  .range-row-band--preview::before {
    background: color-mix(in srgb, var(--color-primary), transparent 88%);
  }

  .range-row-band--left::before {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .range-row-band--right::before {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .range-row-band--middle::before {
    border-radius: 0;
  }

  .animate-fade-in {
    animation: fadeIn 0.15s ease-out forwards;
  }

  .animate-scale-in {
    animation: scaleIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes scaleIn {
    from { transform: scale(0.95); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }

  .scrollbar-hide {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
</style>
