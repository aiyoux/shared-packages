<script lang="ts">
  import Popover from './Popover.svelte';
  import DateRangeCalendar from './DateRangeCalendar.svelte';
  import Pencil from '@lucide/svelte/icons/pencil';
import X from '@lucide/svelte/icons/x';
import Plus from '@lucide/svelte/icons/plus';
  import type { DateRangeValue } from './date-range.ts';
  import { formatRangeLabel } from './date-range.ts';
  import {
    VAGUE_YEARS,
    VAGUE_MONTHS,
    type WeekModeCode,
    type VagueYearCode,
    type VagueMonthCode,
    type VagueDayCode
  } from './date';

  let {
    value = $bindable<DateRangeValue>({ start: null, end: null }),
    firstDayOfWeek = 1,
    infiniteScrollEnabled = true,
    simpleCellMode = false,
    showMonthOutline = false,
    dualMonth = false,
    triggerLabel = 'Date range',
    placeholder = 'Pick a date range',
    showValue = true,
    open = $bindable(false),
    allowVague = false,
    vagueYear = $bindable<string | null>(null),
    vagueMonth = $bindable<string | null>(null),
    vagueDay = $bindable<string | null>(null),
    exactYear = $bindable<number | null>(null),
    exactMonth = $bindable<number | null>(null),
    exactDay = $bindable<number | null>(null),
    exactWeek = $bindable<number | null>(null),
    weekMode = $bindable<WeekModeCode>('ord'),
    weekStart = $bindable<number>(1)
  }: {
    value?: DateRangeValue;
    firstDayOfWeek?: number;
    infiniteScrollEnabled?: boolean;
    simpleCellMode?: boolean;
    showMonthOutline?: boolean;
    dualMonth?: boolean;
    triggerLabel?: string;
    placeholder?: string;
    showValue?: boolean;
    open?: boolean;
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
  } = $props();

  let viewing_date = $state({
    year: value.start?.getFullYear() ?? new Date().getFullYear(),
    month: (value.start?.getMonth() ?? new Date().getMonth()) + 1,
    day: value.start?.getDate() ?? new Date().getDate()
  });

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
      const year = exactYear ?? fallbackYear;
      const date = new Date(year, 0, 1);
      date.setDate(exactDay);
      monthPart = `Day ${exactDay} (${date.toLocaleString('default', { month: 'short', day: 'numeric' })})`;
    }

    if (monthPart && yearPart) {
      return `${monthPart}, ${yearPart}`;
    }
    return monthPart || yearPart;
  });

  const isVagueActive = $derived(vagueYear !== null || vagueMonth !== null || vagueDay !== null);
  const hasValue = $derived(value.start !== null || isVagueActive || exactWeek !== null || exactDay !== null);

  $effect(() => {
    if (open) {
      viewing_date = {
        year: value.start?.getFullYear() ?? new Date().getFullYear(),
        month: (value.start?.getMonth() ?? new Date().getMonth()) + 1,
        day: value.start?.getDate() ?? new Date().getDate()
      };
    }
  });

  const triggerText = $derived.by(() => {
    if (exactWeek !== null) {
      const weekType = weekMode === 'iso' ? 'ISO' : weekMode === 'row' ? 'Row' : 'Abstract';
      return `Week ${exactWeek} (${weekType})${exactYear ? `, ${exactYear}` : ''}`;
    }
    if (exactDay !== null && exactMonth === null) return vagueLabel;
    if (isVagueActive) return vagueLabel;
    const label = formatRangeLabel(value);
    return label === 'Pick a date range' ? placeholder : label;
  });
</script>

<Popover bind:open placement="bottom-start" contentClass={dualMonth ? "w-[min(56rem,calc(100vw-2rem)] max-w-[calc(100vw-2rem)]" : "w-[min(28rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]"}>
  {#snippet trigger({ ref })}
    {#if showValue}
      <div
        use:ref
        class="inline-flex min-w-[17rem] items-center gap-2"
      >
        <div class="min-w-0 flex-1 text-left">
          <p class="truncate text-[var(--text-sm)] font-semibold text-[var(--color-foreground)]">{triggerText}</p>
        </div>
        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] {open ? 'bg-[var(--color-muted)] text-[var(--color-foreground)]' : ''}"
          onclick={() => {
            open = !open;
          }}
          aria-expanded={open}
          aria-label={open ? 'Close date picker' : 'Edit date'}
        >
          {#if hasValue}
            <Pencil class="size-4" />
          {:else}
            <Plus class="size-4" />
          {/if}
        </button>
      </div>
    {:else}
      <button
        use:ref
        type="button"
        class="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] {open ? 'bg-[var(--color-muted)] text-[var(--color-foreground)]' : ''}"
        onclick={() => {
          open = !open;
        }}
        aria-expanded={open}
        aria-label={open ? 'Close date picker' : 'Edit date'}
      >
        {#if hasValue}
          <Pencil class="size-4" />
        {:else}
          <Plus class="size-4" />
        {/if}
      </button>
    {/if}
  {/snippet}

  {#snippet content()}
    <DateRangeCalendar
      bind:value
      bind:viewing_date
      bind:vagueYear
      bind:vagueMonth
      bind:vagueDay
      bind:exactYear
      bind:exactMonth
      bind:exactDay
      bind:exactWeek
      bind:weekMode
      bind:weekStart
      {allowVague}
      {firstDayOfWeek}
      {infiniteScrollEnabled}
      bufferRows={10}
      {simpleCellMode}
      {showMonthOutline}
      {dualMonth}
      onDone={() => open = false}
      class="shadow-[0_30px_80px_-35px_rgba(0,0,0,0.75)]"
      style="height: min(27.5rem, calc(100vh - 7rem)); max-height: min(27.5rem, calc(100vh - 7rem));"
    />
  {/snippet}
</Popover>
