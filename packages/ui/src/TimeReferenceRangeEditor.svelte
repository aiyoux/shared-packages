<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    TimeReference,
    BaseOrVagueReference,
    TimeReferenceValidationResult,
    TimeReferenceField
  } from './date';
  import {
    cleanupEmptyFields,
    cloneTimeReference,
    refsEqual,
    setSideRef,
    validateTimeReferenceStructure
  } from './date';
  import DatePicker from './DatePicker.svelte';
  import TimePicker from './TimePicker.svelte';
  import TimeStackBuilder from './TimeStackBuilder.svelte';
  import Button from './Button.svelte';
  import NumberInput from './NumberInput.svelte';
  import type { DatePickerValue } from './date-picker.ts';
  import { cn } from './utils.ts';

  type EditorDensity = 'default' | 'compact';

  let {
    value = $bindable<TimeReference>({}),
    requireStartDate = true,
    allowVague = true,
    allowEndDate = true,
    allowEndTime = true,
    allowOffsets = false,
    startDateLabel = 'Start date',
    startTimeLabel = 'Start time',
    endDateLabel = 'End date',
    endTimeLabel = 'End time',
    compactCalendar = false,
    stackedBuilder = false,
    density = 'default',
    class: className = '',
    onValidationChange
  }: {
    value?: TimeReference;
    requireStartDate?: boolean;
    allowVague?: boolean;
    allowEndDate?: boolean;
    allowEndTime?: boolean;
    allowOffsets?: boolean;
    startDateLabel?: string;
    startTimeLabel?: string;
    endDateLabel?: string;
    endTimeLabel?: string;
    compactCalendar?: boolean;
    stackedBuilder?: boolean;
    density?: EditorDensity;
    class?: string;
    onValidationChange?: (result: TimeReferenceValidationResult) => void;
  } = $props();

  // Local proxy states for pickers
  let startDateValue = $state<DatePickerValue>({});
  let endDateValue = $state<DatePickerValue>({});
  let startTimeValue = $state<BaseOrVagueReference<string, number> | null>(null);
  let endTimeValue = $state<BaseOrVagueReference<string, number> | null>(null);
  let startYearText = $state('');
  let endYearText = $state('');

  // Derived flags
  const hasStartTime = $derived(value.i?.s !== undefined);
  const hasEndDate = $derived(value.y?.e !== undefined || value.m?.e !== undefined || value.w?.e !== undefined || value.d?.e !== undefined);
  const hasEndTime = $derived(value.i?.e !== undefined);

  const isStartVagueYear = $derived(value.y?.s?.type === 'vg');
  const isStartVagueMonth = $derived(value.m?.s?.type === 'vg');
  const isStartVagueDay = $derived(value.d?.s?.type === 'vg');
  const isEndVagueYear = $derived(value.y?.e?.type === 'vg');
  const isEndVagueMonth = $derived(value.m?.e?.type === 'vg');
  const isEndVagueDay = $derived(value.d?.e?.type === 'vg');

  const validation = $derived(validateTimeReferenceStructure(value, { allowOffsets, requireStartDate }));
  const isCompact = $derived(density === 'compact');
  const rootClass = $derived(cn(isCompact ? 'space-y-3' : 'space-y-4', className));
  const sectionClass = $derived(isCompact ? 'space-y-1.5' : 'space-y-2');
  const labelClass = $derived(
    cn(
      'text-[var(--text-xsm)] font-semibold uppercase text-[var(--color-muted-foreground)]',
      isCompact ? 'tracking-[0.1em]' : 'tracking-[0.14em]'
    )
  );
  const pickerSurfaceClass = $derived(isCompact ? 'gap-3 rounded-[var(--radius-md)] p-3' : '');
  const datePickerLayout = $derived(isCompact ? 'progressive' : 'mode-tabs');

  // Sync external value -> local picker states
  $effect(() => {
    startDateValue = {
      y: value.y?.s as any,
      m: value.m?.s as any,
      w: value.w?.s as any,
      wm: value.wm,
      ws: value.ws,
      d: value.d?.s as any
    };
  });
  $effect(() => {
    endDateValue = {
      y: value.y?.e as any,
      m: value.m?.e as any,
      w: value.w?.e as any,
      wm: value.wm,
      ws: value.ws,
      d: value.d?.e as any
    };
  });
  $effect(() => {
    startTimeValue = value.i?.s as any ?? null;
  });
  $effect(() => {
    endTimeValue = value.i?.e as any ?? null;
  });
  $effect(() => {
    const year = value.y?.s;
    startYearText = year?.type === 'ba' ? String(year.v) : String(new Date().getFullYear());
  });
  $effect(() => {
    const year = value.y?.e;
    endYearText = year?.type === 'ba' ? String(year.v) : (value.y?.s?.type === 'ba' ? String(value.y.s.v) : String(new Date().getFullYear()));
  });

  // Emit validation whenever it changes
  $effect(() => {
    onValidationChange?.(validation);
  });

  // Sync local picker states -> external value
  $effect(() => {
    const next = startDateValue;
    untrack(() => {
      const current: DatePickerValue = {
        y: value.y?.s as any,
        m: value.m?.s as any,
        w: value.w?.s as any,
        wm: value.wm,
        ws: value.ws,
        d: value.d?.s as any
      };
      if (datePickerValuesEqual(current, next)) return;
      handleStartDateChange(next);
    });
  });
  $effect(() => {
    const next = endDateValue;
    untrack(() => {
      const current: DatePickerValue = {
        y: value.y?.e as any,
        m: value.m?.e as any,
        w: value.w?.e as any,
        wm: value.wm,
        ws: value.ws,
        d: value.d?.e as any
      };
      if (datePickerValuesEqual(current, next)) return;
      handleEndDateChange(next);
    });
  });
  $effect(() => {
    const next = startTimeValue;
    untrack(() => {
      if (refsEqual(value.i?.s, next ?? undefined)) return;
      handleStartTimeChange(next);
    });
  });
  $effect(() => {
    const next = endTimeValue;
    untrack(() => {
      if (refsEqual(value.i?.e, next ?? undefined)) return;
      handleEndTimeChange(next);
    });
  });

  function datePickerValuesEqual(a: DatePickerValue, b: DatePickerValue): boolean {
    return (
      refsEqual(a.y as any, b.y as any) &&
      refsEqual(a.m as any, b.m as any) &&
      refsEqual(a.w as any, b.w as any) &&
      refsEqual(a.d as any, b.d as any) &&
      a.wm === b.wm &&
      a.ws === b.ws
    );
  }

  function nextWithSide(
    field: TimeReferenceField,
    side: 's' | 'e',
    ref: BaseOrVagueReference<string, number> | undefined
  ): TimeReference {
    const next = cloneTimeReference(value);
    setSideRef(next, field, side, ref);
    return cleanupEmptyFields(next);
  }

  function handleStartDateChange(next: DatePickerValue) {
    let nextValue = cloneTimeReference(value);
    
    let cleanY = next.y;
    let cleanM = next.m;
    let cleanW = next.w;
    let cleanD = next.d;
    let cleanI = value.i?.s;

    if (cleanY?.type === 'vg') {
      cleanM = undefined;
      cleanW = undefined;
      cleanD = undefined;
      cleanI = undefined;
    } else if (cleanM?.type === 'vg') {
      cleanW = undefined;
      cleanD = undefined;
      cleanI = undefined;
    } else if (cleanD?.type === 'vg') {
      cleanI = undefined;
    }

    setSideRef(nextValue, 'y', 's', cleanY as any);
    setSideRef(nextValue, 'm', 's', cleanM as any);
    setSideRef(nextValue, 'w', 's', cleanW as any);
    setSideRef(nextValue, 'd', 's', cleanD as any);
    setSideRef(nextValue, 'i', 's', cleanI as any);

    nextValue.wm = cleanW ? next.wm ?? nextValue.wm ?? 'ord' : undefined;
    nextValue.ws = next.wm === 'row' ? next.ws ?? nextValue.ws ?? 1 : undefined;

    value = cleanupEmptyFields(nextValue);
  }

  function handleEndDateChange(next: DatePickerValue) {
    let nextValue = cloneTimeReference(value);

    let cleanY = next.y;
    let cleanM = next.m;
    let cleanW = next.w;
    let cleanD = next.d;
    let cleanI = value.i?.e;

    if (cleanY?.type === 'vg') {
      cleanM = undefined;
      cleanW = undefined;
      cleanD = undefined;
      cleanI = undefined;
    } else if (cleanM?.type === 'vg') {
      cleanW = undefined;
      cleanD = undefined;
      cleanI = undefined;
    } else if (cleanD?.type === 'vg') {
      cleanI = undefined;
    }

    setSideRef(nextValue, 'y', 'e', cleanY as any);
    setSideRef(nextValue, 'm', 'e', cleanM as any);
    setSideRef(nextValue, 'w', 'e', cleanW as any);
    setSideRef(nextValue, 'd', 'e', cleanD as any);
    setSideRef(nextValue, 'i', 'e', cleanI as any);

    nextValue.wm = cleanW ? next.wm ?? nextValue.wm ?? 'ord' : nextValue.wm;
    nextValue.ws = next.wm === 'row' ? next.ws ?? nextValue.ws ?? 1 : nextValue.ws;

    value = cleanupEmptyFields(nextValue);
  }

  function handleStartTimeChange(next: BaseOrVagueReference<string, number> | null) {
    value = nextWithSide('i', 's', next ?? undefined);
  }

  function handleEndTimeChange(next: BaseOrVagueReference<string, number> | null) {
    value = nextWithSide('i', 'e', next ?? undefined);
  }

  function setStackYear(side: 's' | 'e', raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    value = nextWithSide('y', side, { type: 'ba', v: Math.trunc(parsed) } as BaseOrVagueReference<string, number>);
  }

  function addStartTime() {
    const defaultMinute: BaseOrVagueReference<string, number> = { type: 'ba', v: 540 };
    value = nextWithSide('i', 's', defaultMinute);
  }

  function removeStartTime() {
    value = nextWithSide('i', 's', undefined);
  }

  function addEndDate() {
    const ys = value.y?.s;
    const ms = value.m?.s;
    const ws = value.w?.s;
    const ds = value.d?.s;
    const next = cloneTimeReference(value);
    if (ys) setSideRef(next, 'y', 'e', ys as any);
    if (ms) setSideRef(next, 'm', 'e', ms as any);
    if (ws) setSideRef(next, 'w', 'e', ws as any);
    if (ds) setSideRef(next, 'd', 'e', ds as any);
    value = cleanupEmptyFields(next);
  }

  function removeEndDate() {
    let next = cloneTimeReference(value);
    setSideRef(next, 'y', 'e', undefined);
    setSideRef(next, 'm', 'e', undefined);
    setSideRef(next, 'w', 'e', undefined);
    setSideRef(next, 'd', 'e', undefined);
    value = cleanupEmptyFields(next);
  }

  function addEndTime() {
    const startMinute = value.i?.s?.type === 'ba' ? value.i.s.v : null;
    const defaultMinute: BaseOrVagueReference<string, number> = {
      type: 'ba',
      v: startMinute !== null ? startMinute + 60 : 600
    };
    value = nextWithSide('i', 'e', defaultMinute);
  }

  function removeEndTime() {
    value = nextWithSide('i', 'e', undefined);
  }
</script>

<div class={rootClass}>
  {#if stackedBuilder}
    <div class={sectionClass}>
      <span class={labelClass}>{startDateLabel}</span>
      <div class="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
        <NumberInput
          value={startYearText}
          onchange={(next) => setStackYear('s', next)}
          min={1}
          max={9999}
          step={1}
          class="h-10"
        />
        <TimeStackBuilder bind:value exactReferenceKind="base" side="start" />
      </div>
    </div>

    {#if allowEndDate || allowEndTime}
      <div class="flex flex-wrap gap-2">
        {#if !hasEndDate && !hasEndTime}
          <Button variant="secondary" size="sm" onclick={addEndDate}>Add end value</Button>
        {:else}
          <Button variant="ghost" size="sm" onclick={() => { removeEndDate(); removeEndTime(); }}>Remove end value</Button>
        {/if}
      </div>
    {/if}

    {#if hasEndDate || hasEndTime}
      <div class={sectionClass}>
        <span class={labelClass}>{endDateLabel}</span>
        <div class="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
          <NumberInput
            value={endYearText}
            onchange={(next) => setStackYear('e', next)}
            min={1}
            max={9999}
            step={1}
            class="h-10"
          />
          <TimeStackBuilder bind:value exactReferenceKind="base" side="end" />
        </div>
      </div>
    {/if}
  {:else}
    <!-- Start date -->
    <div class={sectionClass}>
      <span class={labelClass}>{startDateLabel}</span>
      <DatePicker bind:value={startDateValue} exactOnly={!allowVague} side="start" {compactCalendar} class={pickerSurfaceClass} layout={datePickerLayout} />
    </div>

    <!-- Start time -->
    {#if hasStartTime && !isStartVagueYear && !isStartVagueMonth && !isStartVagueDay}
      <div class={sectionClass}>
        <div class="flex items-center justify-between">
          <span class={labelClass}>{startTimeLabel}</span>
          <Button variant="ghost" size="sm" onclick={removeStartTime}>Remove time</Button>
        </div>
        <TimePicker bind:value={startTimeValue as any} mode={allowVague ? 'auto' : 'exact'} side="start" class={pickerSurfaceClass} />
      </div>
    {:else if !isStartVagueYear && !isStartVagueMonth && !isStartVagueDay}
      <Button variant="secondary" size="sm" onclick={addStartTime}>Add time</Button>
    {/if}

    <!-- End controls -->
    {#if allowEndDate || allowEndTime}
      <div class="flex flex-wrap gap-2">
        {#if allowEndDate && !hasEndDate}
          <Button variant="secondary" size="sm" onclick={addEndDate}>Add end date</Button>
        {/if}
        {#if allowEndDate && hasEndDate}
          <Button variant="ghost" size="sm" onclick={removeEndDate}>Remove end date</Button>
        {/if}
        {#if allowEndTime && !hasEndTime}
          {#if (hasEndDate && !isEndVagueYear && !isEndVagueMonth && !isEndVagueDay) || (!hasEndDate && !isStartVagueYear && !isStartVagueMonth && !isStartVagueDay)}
            <Button variant="secondary" size="sm" onclick={addEndTime}>Add end time</Button>
          {/if}
        {/if}
        {#if allowEndTime && hasEndTime}
          {#if (hasEndDate && !isEndVagueYear && !isEndVagueMonth && !isEndVagueDay) || (!hasEndDate && !isStartVagueYear && !isStartVagueMonth && !isStartVagueDay)}
            <Button variant="ghost" size="sm" onclick={removeEndTime}>Remove end time</Button>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- End date -->
    {#if hasEndDate}
      <div class={sectionClass}>
        <span class={labelClass}>{endDateLabel}</span>
        <DatePicker bind:value={endDateValue} exactOnly={!allowVague} side="end" {compactCalendar} class={pickerSurfaceClass} layout={datePickerLayout} />
      </div>
    {/if}

    <!-- End time -->
    {#if hasEndTime}
      {#if (hasEndDate && !isEndVagueYear && !isEndVagueMonth && !isEndVagueDay) || (!hasEndDate && !isStartVagueYear && !isStartVagueMonth && !isStartVagueDay)}
        <div class={sectionClass}>
          <span class={labelClass}>{endTimeLabel}</span>
          <TimePicker bind:value={endTimeValue as any} mode={allowVague ? 'auto' : 'exact'} side="end" class={pickerSurfaceClass} />
        </div>
      {/if}
    {/if}
  {/if}

  <!-- Validation -->
  {#if !validation.valid}
    <div class="rounded-[var(--radius-md)] border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 px-3 py-2 text-[var(--text-sm)] text-[var(--color-destructive)]">
      {#each validation.issues as issue}
        <div>{issue.message}</div>
      {/each}
    </div>
  {/if}
</div>
