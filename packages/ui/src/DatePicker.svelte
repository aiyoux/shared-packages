<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    BaseOrVagueReference,
    VagueDayCode,
    VagueMonthCode,
    VagueYearCode
  } from './date';
  import {
    VAGUE_DAYS,
    VAGUE_DAY_ORDER,
    VAGUE_MONTHS,
    VAGUE_MONTH_ORDER,
    vagueDayValue,
    vagueMonthValue,
    weekCountFor,
    type WeekModeCode
  } from './date';
  import DateRangeCalendar from './DateRangeCalendar.svelte';
  import type { DateRangeValue } from './date-range.ts';
  import { sameDay, stripTime } from './date-range.ts';
  import type { DatePickerValue } from './date-picker.ts';
  import Button from './Button.svelte';
  import NumberInput from './NumberInput.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import { cn } from './utils.ts';

  type PickerMode = 'exact' | 'exact-week' | 'vague-day' | 'vague-month';
  type PickerLayout = 'mode-tabs' | 'progressive';
  type PrecisionMode = 'exact' | 'vague';

  let {
    value = $bindable<DatePickerValue>({}),
    anchorYear = new Date().getFullYear(),
    side = 'start',
    class: className = '',
    exactOnly = false,
    showYearInput = true,
    compactCalendar = false,
    layout = 'mode-tabs'
  }: {
    value?: DatePickerValue;
    anchorYear?: number;
    side?: 'start' | 'end';
    class?: string;
    exactOnly?: boolean;
    showYearInput?: boolean;
    compactCalendar?: boolean;
    layout?: PickerLayout;
  } = $props();

  function inferMode(next: DatePickerValue): PickerMode {
    if (next.m?.type === 'vg') return 'vague-month';
    if (next.w?.type === 'ba') return 'exact-week';
    if (next.d?.type === 'vg') return 'vague-day';
    return 'exact';
  }

  function initialYearText() {
    return value.y?.type === 'ba' ? String(value.y.v) : '';
  }

  function initialViewingDate() {
    return {
      year: value.y?.type === 'ba' ? value.y.v : anchorYear,
      month: value.m?.type === 'ba' ? value.m.v : new Date().getMonth() + 1,
      day: value.d?.type === 'ba' ? value.d.v : 1
    };
  }

  let mode = $state<PickerMode>(inferMode(value));
  let monthPrecision = $state<PrecisionMode>(value.m?.type === 'vg' ? 'vague' : 'exact');
  let dayPrecision = $state<PrecisionMode>(value.d?.type === 'vg' ? 'vague' : 'exact');
  let weekText = $state(value.w?.type === 'ba' ? String(value.w.v) : '1');
  let weekMode = $state<WeekModeCode>(value.wm ?? 'ord');
  let weekStartText = $state(typeof value.ws === 'number' ? String(value.ws) : '1');
  let yearText = $state(initialYearText());
  let viewing_date = $state(initialViewingDate());
  let exactRange = $state<DateRangeValue>({ start: null, end: null });
  let calVagueYear = $state<string | null>(null);
  let calVagueMonth = $state<string | null>(null);
  let calVagueDay = $state<string | null>(null);
  let calExactYear = $state<number | null>(value.y?.type === 'ba' ? value.y.v : null);
  const monthOptions = Array.from({ length: 12 }, (_, index) => ({
    value: index + 1,
    label: new Date(2026, index, 1).toLocaleString('default', { month: 'short' })
  }));

  function currentYear() {
    const parsed = Number(yearText);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : anchorYear;
  }

  function currentMonthBase() {
    if (value.m?.type === 'ba') return value.m.v;
    if (value.m?.type === 'vg') return vagueMonthValue(value.m.t, side);
    return viewing_date.month;
  }

  function currentDayBase() {
    if (value.d?.type === 'ba') return value.d.v;
    if (value.d?.type === 'vg') return vagueDayValue(value.d.t, side);
    return viewing_date.day ?? 1;
  }

  function currentWeekMode(): WeekModeCode {
    return value.wm ?? weekMode ?? 'ord';
  }

  function currentWeekStart() {
    const parsed = Number(value.ws ?? weekStartText);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(6, Math.trunc(parsed))) : 1;
  }

  function currentWeekBase() {
    if (value.w?.type === 'ba') return value.w.v;
    const parsed = Number(weekText);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1;
  }

  function primaryVagueDayFor(day: number): VagueDayCode {
    if (day <= 10) return 'em';
    if (day <= 20) return 'mm';
    return 'lm';
  }

  function quarterForMonth(month: number): VagueMonthCode {
    if (month <= 3) return 'q1';
    if (month <= 6) return 'q2';
    if (month <= 9) return 'q3';
    return 'q4';
  }

  function setExactDate(date: Date) {
    const day = stripTime(date);
    yearText = String(day.getFullYear());
    viewing_date = { year: day.getFullYear(), month: day.getMonth() + 1, day: day.getDate() };
    exactRange = { start: day, end: day };
    value = {
      y: { type: 'ba', v: day.getFullYear() } as BaseOrVagueReference<VagueYearCode, number>,
      m: { type: 'ba', v: day.getMonth() + 1 } as BaseOrVagueReference<VagueMonthCode, number>,
      d: { type: 'ba', v: day.getDate() } as BaseOrVagueReference<VagueDayCode, number>
    };
  }

  function setExactMonth(month: number) {
    const yearVal = value.y;
    if (value.m?.type === 'ba' && value.m.v === month) {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: undefined,
        d: undefined
      };
    } else {
      const existingDay = value.d?.type === 'ba' ? value.d.v : undefined;
      const yearNum = yearVal?.type === 'ba' ? yearVal.v : currentYear();
      const daysInMonth = new Date(yearNum, month, 0).getDate();
      viewing_date = { year: yearNum, month, day: Math.min(existingDay ?? viewing_date.day ?? 1, daysInMonth) };
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: { type: 'ba', v: month } as BaseOrVagueReference<VagueMonthCode, number>,
        ...(existingDay
          ? {
              d: {
                type: 'ba',
                v: Math.min(existingDay, daysInMonth)
              } as BaseOrVagueReference<VagueDayCode, number>
            }
          : {})
      };
      monthPrecision = 'exact';
    }
  }

  function setVagueMonth(code: VagueMonthCode) {
    const yearVal = value.y;
    if (value.m?.type === 'vg' && value.m.t === code) {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: undefined
      };
    } else {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: { type: 'vg', t: code }
      };
      const yearNum = yearVal?.type === 'ba' ? yearVal.v : currentYear();
      viewing_date = { year: yearNum, month: vagueMonthValue(code, side), day: 1 };
      monthPrecision = 'vague';
      dayPrecision = 'exact';
    }
  }

  function weekMetadata() {
    const mode = currentWeekMode();
    return {
      wm: mode,
      ...(mode === 'row' ? { ws: currentWeekStart() } : {})
    };
  }

  function setExactWeek(week: number) {
    const yearVal = value.y;
    const month = value.m?.type === 'ba' ? value.m : undefined;
    const safeWeek = Math.max(1, Math.trunc(week));
    if (value.w?.type === 'ba' && value.w.v === safeWeek) {
      weekText = '';
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        ...(month ? { m: month } : {}),
        w: undefined,
        wm: undefined,
        ws: undefined
      };
    } else {
      weekText = String(safeWeek);
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        ...(month ? { m: month } : {}),
        w: { type: 'ba', v: safeWeek } as BaseOrVagueReference<string, number>,
        ...weekMetadata()
      };
    }
  }

  function updateWeekMode(next: WeekModeCode) {
    weekMode = next;
    const parsedWeek = currentWeekBase();
    value = {
      ...value,
      wm: next,
      ...(next === 'row' ? { ws: currentWeekStart() } : { ws: undefined })
    };
    if (value.w?.type === 'ba') weekText = String(parsedWeek);
  }

  function setVagueDay(code: VagueDayCode) {
    const yearVal = value.y;
    const month = value.m?.type === 'ba' ? value.m.v : currentMonthBase();
    if (value.d?.type === 'vg' && value.d.t === code) {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: value.m,
        d: undefined
      };
    } else {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: { type: 'ba', v: month } as BaseOrVagueReference<VagueMonthCode, number>,
        d: { type: 'vg', t: code }
      };
      const yearNum = yearVal?.type === 'ba' ? yearVal.v : currentYear();
      viewing_date = { year: yearNum, month, day: vagueDayValue(code, side) };
      dayPrecision = 'vague';
    }
  }

  function setProgressiveDayPrecision(next: PrecisionMode) {
    if (next === 'exact') {
      const yearVal = value.y;
      const yearNum = yearVal?.type === 'ba' ? yearVal.v : currentYear();
      const month = value.m?.type === 'ba' ? value.m.v : currentMonthBase();
      const day = currentDayBase();
      setExactDate(new Date(yearNum, month - 1, day));
      dayPrecision = 'exact';
      return;
    }

    setVagueDay(value.d?.type === 'vg' ? value.d.t : primaryVagueDayFor(currentDayBase()));
  }

  function setProgressiveMonthPrecision(next: PrecisionMode) {
    if (next === 'exact') {
      setExactMonth(currentMonthBase());
      return;
    }

    setVagueMonth(value.m?.type === 'vg' ? value.m.t : quarterForMonth(currentMonthBase()));
  }

  function switchMode(next: PickerMode) {
    const yearVal = value.y;
    const yearNum = yearVal?.type === 'ba' ? yearVal.v : currentYear();
    const month = currentMonthBase();
    const day = currentDayBase();

    if (next === 'exact') {
      setExactDate(new Date(yearNum, month - 1, day));
      mode = next;
      return;
    }

    if (next === 'vague-day') {
      value = {
        ...(yearVal ? { y: yearVal } : {}),
        m: { type: 'ba', v: month } as BaseOrVagueReference<VagueMonthCode, number>,
        d: { type: 'vg', t: value.d?.type === 'vg' ? value.d.t : primaryVagueDayFor(day) }
      };
      viewing_date = { year: yearNum, month, day };
      mode = next;
      return;
    }

    if (next === 'exact-week') {
      setExactWeek(currentWeekBase());
      mode = next;
      return;
    }

    value = {
      ...(yearVal ? { y: yearVal } : {}),
      m: { type: 'vg', t: value.m?.type === 'vg' ? value.m.t : quarterForMonth(month) }
    };
    viewing_date = { year: yearNum, month, day: 1 };
    mode = next;
  }

  const exactPreview = $derived.by(() => {
    if (value.y?.type !== 'ba' || value.m?.type !== 'ba' || value.d?.type !== 'ba') return null;
    return new Date(value.y.v, value.m.v - 1, value.d.v);
  });

  const vagueDayHint = $derived.by(() => {
    if (value.d?.type !== 'vg') return null;
    const info = VAGUE_DAYS[value.d.t];
    const month = value.m?.type === 'ba' ? value.m.v : null;
    const year = value.y?.type === 'ba' ? value.y.v : currentYear();
    if (!month) {
      return {
        title: info.label,
        body: 'Pick or preserve an exact month to interpret the vague-day range.'
      };
    }
    return {
      title: info.label,
      body: `${new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' })} · days ${info.range[0]}–${info.range[1]}`
    };
  });

  const weekHint = $derived.by(() => {
    if (value.w?.type !== 'ba') return null;
    const year = value.y?.type === 'ba' ? value.y.v : currentYear();
    const month = value.m?.type === 'ba' ? value.m.v : null;
    const count = weekCountFor(year, month, currentWeekMode(), currentWeekStart());
    return { title: `Week ${value.w.v}`, body: `${currentWeekMode().toUpperCase()} weeks 1-${count}` };
  });

  const vagueMonthHint = $derived.by(() => {
    if (value.m?.type !== 'vg') return null;
    const info = VAGUE_MONTHS[value.m.t];
    const year = value.y?.type === 'ba' ? value.y.v : currentYear();
    return {
      title: info.label,
      body: info.wraps
        ? `${year} → ${year + 1} · months ${info.range[0]}–${info.range[1]}`
        : `${year} · months ${info.range[0]}–${info.range[1]}`
    };
  });

  $effect(() => {
    mode = inferMode(value);
    monthPrecision = value.m?.type === 'vg' ? 'vague' : 'exact';
    dayPrecision = value.d?.type === 'vg' ? 'vague' : 'exact';
    weekMode = value.wm ?? 'ord';
    if (value.w?.type === 'ba') {
      weekText = String(value.w.v);
    } else if (!value.w) {
      weekText = '';
    }
    if (typeof value.ws === 'number') weekStartText = String(value.ws);
    if (value.y?.type === 'ba') {
      yearText = String(value.y.v);
    } else if (!value.y) {
      yearText = '';
    }
    // Read the current viewing_date fallbacks inside untrack — otherwise
    // writing `viewing_date = {...}` below would re-trigger this effect
    // infinitely for any DatePickerValue missing m/d (e.g. parent-offset
    // drafts with only a minute field).
    const prevVD = untrack(() => viewing_date);
    let next: { year: number; month: number; day: number };
    if (value.y?.type === 'ba' && value.m?.type === 'ba' && value.d?.type === 'ba') {
      const nextDate = new Date(value.y.v, value.m.v - 1, value.d.v);
      if (!sameDay(exactRange.start, nextDate) || !sameDay(exactRange.end, nextDate)) {
        exactRange = { start: nextDate, end: nextDate };
      }
      next = { year: value.y.v, month: value.m.v, day: value.d.v };
    } else {
      next = {
        year: value.y?.type === 'ba' ? value.y.v : untrack(() => currentYear()),
        month: value.m?.type === 'ba' ? value.m.v : prevVD.month,
        day: value.d?.type === 'ba' ? value.d.v : prevVD.day ?? 1
      };

      if (value.m?.type === 'ba' && value.d?.type === 'ba') {
        const targetYear = value.y?.type === 'ba' ? value.y.v : next.year;
        const nextDate = new Date(targetYear, value.m.v - 1, value.d.v);
        if (!exactRange.start || !sameDay(exactRange.start, nextDate) || !exactRange.end || !sameDay(exactRange.end, nextDate)) {
          exactRange = { start: nextDate, end: nextDate };
        }
      } else {
        if (exactRange.start !== null || exactRange.end !== null) {
          exactRange = { start: null, end: null };
        }
      }
    }
    if (
      prevVD.year !== next.year ||
      prevVD.month !== next.month ||
      (prevVD.day ?? 1) !== (next.day ?? 1)
    ) {
      viewing_date = next;
    }
  });

  $effect(() => {
    if (!exactOnly) return;
    if (mode === 'exact') return;
    switchMode('exact');
  });

  $effect(() => {
    if (value.y?.type === 'vg') return;
    if (!yearText) {
      if (calExactYear !== null) {
        calExactYear = null;
      }
      return;
    }
    const parsed = Number(yearText);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (calExactYear === parsed) return;
    calExactYear = parsed;
  });

  $effect(() => {
    if (mode !== 'exact-week') return;
    if (!weekText) {
      if (value.w !== undefined) {
        value = {
          ...value,
          w: undefined
        };
      }
      return;
    }
    const parsed = Number(weekText);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (value.w?.type === 'ba' && value.w.v === parsed) return;
    const yearVal = value.y;
    const month = value.m?.type === 'ba' ? value.m : undefined;
    value = {
      ...(yearVal ? { y: yearVal } : {}),
      ...(month ? { m: month } : {}),
      w: { type: 'ba', v: parsed } as BaseOrVagueReference<string, number>,
      ...weekMetadata()
    };
  });

  $effect(() => {
    calExactYear = value.y?.type === 'ba' ? value.y.v : null;
  });

  $effect(() => {
    if (calExactYear !== (value.y?.type === 'ba' ? value.y.v : null)) {
      if (calExactYear !== null) {
        value = {
          ...value,
          y: { type: 'ba', v: calExactYear }
        };
      } else {
        if (value.y?.type === 'ba') {
          value = {
            ...value,
            y: undefined
          };
        }
      }
    }
  });

  $effect(() => {
    calVagueYear = value.y?.type === 'vg' ? value.y.t : null;
  });

  $effect(() => {
    calVagueMonth = value.m?.type === 'vg' ? value.m.t : null;
  });

  $effect(() => {
    calVagueDay = value.d?.type === 'vg' ? value.d.t : null;
  });

  $effect(() => {
    if (calVagueDay !== (value.d?.type === 'vg' ? value.d.t : null)) {
      if (calVagueDay) {
        value = {
          ...value,
          d: { type: 'vg', t: calVagueDay as VagueDayCode }
        };
      } else {
        value = {
          ...value,
          d: undefined
        };
      }
    }
  });

  $effect(() => {
    if (calVagueYear !== (value.y?.type === 'vg' ? value.y.t : null)) {
      if (calVagueYear) {
        value = {
          ...value,
          y: { type: 'vg', t: calVagueYear as VagueYearCode }
        };
      } else {
        const yrNum = Number(yearText);
        if (yrNum > 0) {
          value = {
            ...value,
            y: { type: 'ba', v: yrNum }
          };
        } else {
          value = {
            ...value,
            y: undefined
          };
        }
      }
    }
  });

  $effect(() => {
    if (calVagueMonth !== (value.m?.type === 'vg' ? value.m.t : null)) {
      if (calVagueMonth) {
        value = {
          ...value,
          m: { type: 'vg', t: calVagueMonth as VagueMonthCode }
        };
      } else {
        value = {
          ...value,
          m: undefined
        };
      }
    }
  });

  $effect(() => {
    if (mode !== 'exact') return;
    const selected = exactRange.end ?? exactRange.start;
    if (!selected) {
      if (value.d?.type === 'ba' || value.m?.type === 'ba') {
        value = {
          ...value,
          d: undefined,
          m: undefined
        };
      }
      return;
    }
    if (!sameDay(exactRange.start, exactRange.end)) {
      exactRange = { start: selected, end: selected };
    }
    if (!exactPreview || !sameDay(exactPreview, selected)) {
      setExactDate(selected);
    }
  });
</script>

<div class={cn('grid gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-4', className)}>
  {#if layout === 'progressive'}
    <div class="grid gap-4">
      {#if showYearInput}
        <div class="max-w-[8rem] space-y-2">
          <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Year</span>
          <NumberInput bind:value={yearText} min={1} max={9999} step={1} />
        </div>
      {/if}

      <section class="grid gap-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Month</span>
          {#if !exactOnly}
            <SegmentedControl
              ariaLabel="Month precision"
              options={[
                { value: 'exact', label: 'Exact' },
                { value: 'vague', label: 'Approx' }
              ]}
              value={monthPrecision}
              onValueChange={(next) => setProgressiveMonthPrecision(next as PrecisionMode)}
              class="w-fit"
            />
          {/if}
        </div>

        {#if monthPrecision === 'vague' && !exactOnly}
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {#each VAGUE_MONTH_ORDER as code (code)}
              {@const info = VAGUE_MONTHS[code]}
              <Button
                variant={value.m?.type === 'vg' && value.m.t === code ? 'primary' : 'secondary'}
                size="sm"
                class="h-auto justify-start py-3 text-left"
                onclick={() => setVagueMonth(code)}
              >
                <span class="flex flex-col items-start">
                  <span>{info.label}</span>
                  <span class="text-[10px] opacity-75">Months {info.range[0]}-{info.range[1]}</span>
                </span>
              </Button>
            {/each}
          </div>
          {#if vagueMonthHint}
            <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
              <span class="font-medium text-[var(--color-foreground)]">{vagueMonthHint.title}</span>
              <span> · {vagueMonthHint.body}</span>
            </div>
          {/if}
        {:else}
          <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {#each monthOptions as option (option.value)}
              <Button
                variant={value.m?.type === 'ba' && value.m.v === option.value ? 'primary' : 'secondary'}
                size="sm"
                class="h-9 px-2"
                onclick={() => setExactMonth(option.value)}
              >
                {option.label}
              </Button>
            {/each}
          </div>
        {/if}
      </section>

      {#if monthPrecision === 'exact'}
        <section class="grid gap-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Week</span>
          </div>

          <div class="flex flex-wrap items-end gap-2">
            <SegmentedControl
              ariaLabel="Week mode"
              options={[
                { value: 'ord', label: 'Abstract' },
                { value: 'iso', label: 'ISO' },
                { value: 'row', label: 'Row' }
              ]}
              value={weekMode}
              onValueChange={(next) => updateWeekMode(next as WeekModeCode)}
              class="w-fit"
            />
            {#if weekMode === 'row'}
              <div class="w-24">
                <NumberInput
                  bind:value={weekStartText}
                  min={0}
                  max={6}
                  step={1}
                  onchange={(next) => {
                    weekStartText = next;
                    if (value.w) updateWeekMode('row');
                  }}
                />
              </div>
            {/if}
          </div>

          <div class="flex max-w-[10rem] items-center gap-2">
            <NumberInput
              bind:value={weekText}
              min={1}
              max={60}
              step={1}
              onchange={(next) => {
                const parsed = Number(next);
                if (Number.isFinite(parsed)) setExactWeek(parsed);
              }}
            />
          </div>
          {#if weekHint}
            <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
              <span class="font-medium text-[var(--color-foreground)]">{weekHint.title}</span>
              <span> · {weekHint.body}</span>
            </div>
          {/if}
        </section>
      {/if}

      {#if monthPrecision === 'exact' && value.m?.type === 'ba' && !value.w}
        <section class="grid gap-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Day</span>
            {#if !exactOnly}
              <SegmentedControl
                ariaLabel="Day precision"
                options={[
                  { value: 'exact', label: 'Exact' },
                  { value: 'vague', label: 'Approx' }
                ]}
                value={dayPrecision}
                onValueChange={(next) => setProgressiveDayPrecision(next as PrecisionMode)}
                class="w-fit"
              />
            {/if}
          </div>

          {#if dayPrecision === 'vague' && !exactOnly}
            <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {#each VAGUE_DAY_ORDER as code (code)}
                {@const info = VAGUE_DAYS[code]}
                <Button
                  variant={value.d?.type === 'vg' && value.d.t === code ? 'primary' : 'secondary'}
                  size="sm"
                  class="h-auto justify-start py-3 text-left"
                  onclick={() => setVagueDay(code)}
                >
                  <span class="flex flex-col items-start">
                    <span>{info.label}</span>
                    <span class="text-[10px] opacity-75">Days {info.range[0]}-{info.range[1]}</span>
                  </span>
                </Button>
              {/each}
            </div>
            {#if vagueDayHint}
              <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
                <span class="font-medium text-[var(--color-foreground)]">{vagueDayHint.title}</span>
                <span> · {vagueDayHint.body}</span>
              </div>
            {/if}
          {:else}
            <DateRangeCalendar
              bind:value={exactRange}
              bind:viewing_date
              bind:vagueYear={calVagueYear}
              bind:vagueMonth={calVagueMonth}
              bind:vagueDay={calVagueDay}
              bind:exactYear={calExactYear}
              allowVague={!exactOnly}
              infiniteScrollEnabled={compactCalendar}
              showHeader={!compactCalendar}
              showFooter={false}
              showMonthOutline={compactCalendar}
              simpleCellMode={compactCalendar}
              rows={6}
              class={compactCalendar ? 'max-h-[280px]' : 'min-h-[28rem]'}
            />
          {/if}
        </section>
      {/if}
  </div>
  {:else}
  {#if !exactOnly || showYearInput}
    <div class="flex flex-wrap items-end gap-4">
      {#if !exactOnly}
        <div class="space-y-2">
          <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Mode</span>
          <SegmentedControl
            ariaLabel="Date picker mode"
            options={[
              { value: 'exact', label: 'Exact' },
              { value: 'exact-week', label: 'Week' },
              { value: 'vague-day', label: 'Vague day' },
              { value: 'vague-month', label: 'Vague mo' }
            ]}
            bind:value={mode}
            class="w-fit"
          />
        </div>
      {/if}
      {#if showYearInput}
        <div class="space-y-2 max-w-[8rem]">
          <span class="text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">Year</span>
          <NumberInput bind:value={yearText} min={1} max={9999} step={1} />
        </div>
      {/if}
    </div>
  {/if}

  {#if mode === 'exact'}
    <DateRangeCalendar
      bind:value={exactRange}
      bind:viewing_date
      bind:vagueYear={calVagueYear}
      bind:vagueMonth={calVagueMonth}
      bind:vagueDay={calVagueDay}
      bind:exactYear={calExactYear}
      allowVague={!exactOnly}
      infiniteScrollEnabled={compactCalendar}
      showHeader={!compactCalendar}
      showFooter={false}
      showMonthOutline={compactCalendar}
      simpleCellMode={compactCalendar}
      rows={6}
      class={compactCalendar ? 'max-h-[280px]' : 'min-h-[28rem]'}
    />
  {:else if mode === 'exact-week'}
    <div class="grid gap-3">
      <div class="flex flex-wrap items-end gap-2">
        <SegmentedControl
          ariaLabel="Week mode"
          options={[
            { value: 'ord', label: 'Abstract' },
            { value: 'iso', label: 'ISO' },
            { value: 'row', label: 'Row' }
          ]}
          value={weekMode}
          onValueChange={(next) => updateWeekMode(next as WeekModeCode)}
          class="w-fit"
        />
        {#if weekMode === 'row'}
          <div class="w-24">
            <NumberInput
              bind:value={weekStartText}
              min={0}
              max={6}
              step={1}
              onchange={(next) => {
                weekStartText = next;
                updateWeekMode('row');
              }}
            />
          </div>
        {/if}
      </div>

      <div class="max-w-[10rem]">
        <NumberInput
          bind:value={weekText}
          min={1}
          max={60}
          step={1}
          onchange={(next) => {
            const parsed = Number(next);
            if (Number.isFinite(parsed)) setExactWeek(parsed);
          }}
        />
      </div>
      {#if weekHint}
        <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
          <span class="font-medium text-[var(--color-foreground)]">{weekHint.title}</span>
          <span> · {weekHint.body}</span>
        </div>
      {/if}
    </div>
  {:else if mode === 'vague-day'}
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {#each VAGUE_DAY_ORDER as code (code)}
        {@const info = VAGUE_DAYS[code]}
        <Button
          variant={value.d?.type === 'vg' && value.d.t === code ? 'primary' : 'secondary'}
          size="sm"
          class="justify-start h-auto py-3 text-left"
          onclick={() => setVagueDay(code)}
        >
          <span class="flex flex-col items-start">
            <span>{info.label}</span>
            <span class="text-[10px] opacity-75">Days {info.range[0]}–{info.range[1]}</span>
          </span>
        </Button>
      {/each}
    </div>
    {#if vagueDayHint}
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
        <span class="font-medium text-[var(--color-foreground)]">{vagueDayHint.title}</span>
        <span> · {vagueDayHint.body}</span>
      </div>
    {/if}
  {:else}
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {#each VAGUE_MONTH_ORDER as code (code)}
        {@const info = VAGUE_MONTHS[code]}
        <Button
          variant={value.m?.type === 'vg' && value.m.t === code ? 'primary' : 'secondary'}
          size="sm"
          class="justify-start h-auto py-3 text-left"
          onclick={() => setVagueMonth(code)}
        >
          <span class="flex flex-col items-start">
            <span>{info.label}</span>
            <span class="text-[10px] opacity-75">Months {info.range[0]}–{info.range[1]}</span>
          </span>
        </Button>
      {/each}
    </div>
    {#if vagueMonthHint}
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]/70 bg-[var(--color-muted)]/35 px-3 py-2 text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">
        <span class="font-medium text-[var(--color-foreground)]">{vagueMonthHint.title}</span>
        <span> · {vagueMonthHint.body}</span>
      </div>
    {/if}
  {/if}
  {/if}
</div>
