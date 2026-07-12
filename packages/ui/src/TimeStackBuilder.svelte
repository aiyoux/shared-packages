<script lang="ts">
  import type { BaseOrVagueReference, TimeReference, WeekModeCode } from './date';
  import {
    VAGUE_MINUTES,
    VAGUE_MINUTE_ORDER,
    VAGUE_DAYS,
    VAGUE_DAY_ORDER,
    VAGUE_MONTHS,
    VAGUE_MONTH_ORDER
  } from './date';
  import Button from './Button.svelte';
  import NumberInput from './NumberInput.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import Select from './Select.svelte';
  import { cn } from './utils.ts';

  type TimeLevel = 'month' | 'week' | 'day' | 'time';
  type StackMode = 'exact' | 'vague' | 'iso' | 'row';
  type StackSide = 'start' | 'end';
  type StackAnchor = 'up' | 'pr';
  type ExactReferenceKind = 'offset' | 'base';
  type TimeReferenceStackField = 'm' | 'w' | 'd' | 'i';

  type StackRow = {
    id: string;
    level: TimeLevel;
    mode: StackMode;
    exactValue: string;
    vagueValue: string;
  };

  let {
    value = $bindable<TimeReference>({}),
    side = 'start',
    anchor = 'up',
    exactReferenceKind = 'offset',
    onValueChange,
    class: className = ''
  }: {
    value?: TimeReference;
    side?: StackSide;
    anchor?: StackAnchor;
    exactReferenceKind?: ExactReferenceKind;
    onValueChange?: (value: TimeReference) => void;
    class?: string;
  } = $props();

  const LEVEL_ORDER: TimeLevel[] = ['month', 'week', 'day', 'time'];
  const LEVEL_LABELS: Record<TimeLevel, string> = {
    month: 'month',
    week: 'week',
    day: 'day',
    time: 'time'
  };
  const LEVEL_FIELDS: Record<TimeLevel, TimeReferenceStackField> = {
    month: 'm',
    week: 'w',
    day: 'd',
    time: 'i'
  };

  function generateId() {
    return crypto.randomUUID();
  }

  function getNextLevel(current: TimeLevel): TimeLevel | null {
    const idx = LEVEL_ORDER.indexOf(current);
    return idx < LEVEL_ORDER.length - 1 ? LEVEL_ORDER[idx + 1] : null;
  }

  function getLevelLabel(level: TimeLevel): string {
    return LEVEL_LABELS[level];
  }

  function createRow(level: TimeLevel): StackRow {
    return {
      id: generateId(),
      level,
      mode: 'exact',
      exactValue: getDefaultExactValue(level),
      vagueValue: getDefaultVagueValue(level)
    };
  }

  function getDefaultVagueValue(level: TimeLevel): string {
    switch (level) {
      case 'month': return 'q1';
      case 'week': return '';
      case 'day': return 'em';
      case 'time': return 'mo';
    }
  }

  function getDefaultExactValue(level: TimeLevel): string {
    return exactReferenceKind === 'base' && level !== 'time' ? '1' : '0';
  }

  let rows = $state<StackRow[]>([createRow('day')]);
  let weekStartText = $state(typeof value?.ws === 'number' ? String(value.ws) : '1');

  function sideKey(): 's' | 'e' {
    return side === 'end' ? 'e' : 's';
  }

  function weekStackMode(weekMode?: WeekModeCode): StackMode {
    if (weekMode === 'iso') return 'iso';
    if (weekMode === 'row') return 'row';
    return 'exact';
  }

  function rowFromReference(level: TimeLevel, ref: BaseOrVagueReference<string, number>, weekMode?: WeekModeCode): StackRow {
    if (ref.type === 'vg') {
      return ensureValidVagueValue({
        id: generateId(),
        level,
        mode: 'vague',
        exactValue: getDefaultExactValue(level),
        vagueValue: String(ref.t)
      });
    }

    return {
      id: generateId(),
      level,
      mode: level === 'week' ? weekStackMode(weekMode) : 'exact',
      exactValue: String(ref.v ?? 0),
      vagueValue: getDefaultVagueValue(level)
    };
  }

  function rowsFromValue(next: TimeReference): StackRow[] {
    const key = sideKey();
    const nextRows = LEVEL_ORDER
      .map((level) => {
        const ref = next?.[LEVEL_FIELDS[level]]?.[key] as BaseOrVagueReference<string, number> | undefined;
        return ref ? rowFromReference(level, ref, next.wm) : null;
      })
      .filter((row): row is StackRow => Boolean(row));

    return nextRows.length ? nextRows : [createRow('day')];
  }

  function referenceFromRow(row: StackRow): BaseOrVagueReference<string, number> {
    if (row.mode === 'vague') {
      return { type: 'vg', t: ensureValidVagueValue(row).vagueValue };
    }

    const parsed = Number(row.exactValue);
    let value = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    if (row.level === 'week') value = Math.max(1, Math.min(60, value));
    if (row.level === 'time') value = Math.max(0, Math.min(1439, value));
    if (exactReferenceKind === 'base') {
      return { type: 'ba', v: value };
    }
    return { type: 'of', v: value, a: anchor };
  }

  function withSideReference(
    current: TimeReference[TimeReferenceStackField],
    ref: BaseOrVagueReference<string, number> | undefined
  ): TimeReference[TimeReferenceStackField] {
    const key = sideKey();
    const otherKey = key === 's' ? 'e' : 's';
    const other = current?.[otherKey] as BaseOrVagueReference<string, number> | undefined;

    if (!ref && !other) return undefined;
    return {
      ...(other ? { [otherKey]: { ...other } } : {}),
      ...(ref ? { [key]: { ...ref } } : {})
    };
  }

  function valueFromRows(nextRows: StackRow[]): TimeReference {
    const next: TimeReference = {
      ...(value?.y ? { y: { ...value.y } } : {}),
      ...(value?.m ? { m: { ...value.m } } : {}),
      ...(value?.w ? { w: { ...value.w } } : {}),
      ...(value?.d ? { d: { ...value.d } } : {}),
      ...(value?.i ? { i: { ...value.i } } : {}),
      ...(value?.wm ? { wm: value.wm } : {}),
      ...(typeof value?.ws === 'number' ? { ws: value.ws } : {})
    };

    for (const level of LEVEL_ORDER) {
      const field = LEVEL_FIELDS[level];
      next[field] = withSideReference(next[field], undefined);
      if (!next[field]) delete next[field];
    }

    for (const row of nextRows) {
      const field = LEVEL_FIELDS[row.level];
      next[field] = withSideReference(next[field], referenceFromRow(row));
    }

    applyWeekMetadata(next, nextRows);

    return next;
  }

  function currentWeekStart() {
    const parsed = Number(weekStartText);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(6, Math.trunc(parsed))) : 1;
  }

  function applyWeekMetadata(next: TimeReference, nextRows: StackRow[]) {
    const weekRow = nextRows.find((row) => row.level === 'week');
    if (!weekRow) {
      if (!next.w) {
        delete next.wm;
        delete next.ws;
      }
      return;
    }

    if (weekRow.mode === 'iso') {
      next.wm = 'iso' as WeekModeCode;
      delete next.ws;
      return;
    }

    if (weekRow.mode === 'row') {
      next.wm = 'row' as WeekModeCode;
      next.ws = currentWeekStart();
      return;
    }

    next.wm = 'ord' as WeekModeCode;
    delete next.ws;
  }

  function rowsSignature(nextRows: StackRow[]): string {
    return JSON.stringify(nextRows.map(({ level, mode, exactValue, vagueValue }) => ({ level, mode, exactValue, vagueValue })));
  }

  function applyRows(nextRows: StackRow[]) {
    const normalized = nextRows.map(ensureValidStackRow);
    const nextValue = valueFromRows(normalized);
    rows = normalized;
    value = nextValue;
    onValueChange?.(nextValue);
  }

  // Ensure vagueValue is valid for current level
  function ensureValidVagueValue(row: StackRow): StackRow {
    const validValues: readonly string[] = {
      month: VAGUE_MONTH_ORDER,
      week: [],
      day: VAGUE_DAY_ORDER,
      time: VAGUE_MINUTE_ORDER
    }[row.level];

    if (!validValues.includes(row.vagueValue)) {
      return { ...row, vagueValue: getDefaultVagueValue(row.level) };
    }
    return row;
  }

  function ensureValidStackRow(row: StackRow): StackRow {
    const mode = row.level === 'week'
      ? (row.mode === 'iso' || row.mode === 'row' ? row.mode : 'exact')
      : (row.mode === 'exact' || row.mode === 'vague' ? row.mode : 'exact');
    return ensureValidVagueValue(mode === row.mode ? row : { ...row, mode });
  }

  $effect(() => {
    const updatedRows = rows.map(ensureValidStackRow);
    if (updatedRows.some((r, i) => r.vagueValue !== rows[i].vagueValue || r.mode !== rows[i].mode)) {
      applyRows(updatedRows);
    }
  });

  $effect(() => {
    const nextRows = rowsFromValue(value ?? {});
    if (rowsSignature(nextRows) !== rowsSignature(rows)) {
      rows = nextRows;
    }
  });

  $effect(() => {
    if (typeof value?.ws === 'number') weekStartText = String(value.ws);
  });

  function addRow(level: TimeLevel) {
    applyRows([...rows, createRow(level)]);
  }

  function removeRow(index: number) {
    applyRows(rows.filter((_, i) => i !== index));
  }

  function updateRowLevel(index: number, level: TimeLevel) {
    applyRows(rows.map((row, i) => {
      if (i !== index) return row;
      return {
        ...row,
        level,
        mode: level === 'week'
          ? (row.mode === 'iso' || row.mode === 'row' ? row.mode : 'exact')
          : (row.mode === 'exact' || row.mode === 'vague' ? row.mode : 'exact'),
        vagueValue: getDefaultVagueValue(level)
      };
    }));
  }

  const modeOptions = [
    { value: 'exact', label: 'Exact' },
    { value: 'vague', label: 'Vague' }
  ] as const;
  const weekModeOptions = [
    { value: 'exact', label: 'Abstract' },
    { value: 'iso', label: 'ISO' },
    { value: 'row', label: 'Row' }
  ] as const;

  const monthOptions = VAGUE_MONTH_ORDER.map((code) => ({ value: code, label: VAGUE_MONTHS[code].label }));
  const dayOptions = VAGUE_DAY_ORDER.map((code) => ({ value: code, label: VAGUE_DAYS[code].label }));
  const minuteOptions = VAGUE_MINUTE_ORDER.map((code) => ({ value: code, label: VAGUE_MINUTES[code].label }));
  const levelOptions = [
    { value: 'month', label: 'month' },
    { value: 'week', label: 'week' },
    { value: 'day', label: 'day' },
    { value: 'time', label: 'time' }
  ];
</script>

<div class={cn('space-y-3', className)}>
  {#each rows as row, index (row.id)}
    <div class="flex items-center gap-2">
      {#if row.mode !== 'vague'}
        <NumberInput
          value={row.exactValue}
          onchange={(v) => {
            applyRows(rows.map((r, i) => i === index ? { ...r, exactValue: v } : r));
          }}
          min={row.level === 'time' ? 0 : row.level === 'week' ? 1 : undefined}
          max={row.level === 'time' ? 1439 : row.level === 'week' ? 60 : undefined}
          class="w-24"
        />
      {:else}
        {#key row.level}
          <div class="w-24">
            {#if row.level === 'month'}
              <Select
                value={row.vagueValue}
                options={monthOptions}
                onValueChange={(v) => { applyRows(rows.map((r, i) => i === index ? { ...r, vagueValue: String(v) } : r)); }}
                class="h-10 w-full px-2 py-1 text-sm"
              />
            {:else if row.level === 'day'}
              <Select
                value={row.vagueValue}
                options={dayOptions}
                onValueChange={(v) => { applyRows(rows.map((r, i) => i === index ? { ...r, vagueValue: String(v) } : r)); }}
                class="h-10 w-full px-2 py-1 text-sm"
              />
            {:else}
              <Select
                value={row.vagueValue}
                options={minuteOptions}
                onValueChange={(v) => { applyRows(rows.map((r, i) => i === index ? { ...r, vagueValue: String(v) } : r)); }}
                class="h-10 w-full px-2 py-1 text-sm"
              />
            {/if}
          </div>
        {/key}
      {/if}

      <Select
        value={row.level}
        options={levelOptions}
        onValueChange={(v) => { updateRowLevel(index, String(v) as TimeLevel); }}
        disabled={index !== 0}
        class="h-10 w-auto px-3 py-1 text-sm"
      />

      <SegmentedControl
        options={row.level === 'week' ? weekModeOptions : modeOptions}
        value={row.mode}
        onValueChange={(v) => { applyRows(rows.map((r, i) => i === index ? { ...r, mode: v as StackMode } : r)); }}
        ariaLabel="Mode"
      />

      {#if row.level === 'week' && row.mode === 'row'}
        <NumberInput
          value={weekStartText}
          onchange={(v) => {
            weekStartText = v;
            applyRows(rows);
          }}
          min={0}
          max={6}
          step={1}
          class="w-24"
        />
      {/if}

      {#if index > 0}
        <button
          type="button"
          class="rounded-[var(--radius-sm)] p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          onclick={() => removeRow(index)}
          aria-label="Remove"
          title="Remove"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    </div>

    {#if row.mode !== 'vague'}
      {@const next = getNextLevel(row.level)}
      {#if next}
        <div class="pl-4">
          <Button
            variant="ghost"
            size="sm"
            class="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            onclick={() => addRow(next)}
          >
            + Add {getLevelLabel(next)}
          </Button>
        </div>
      {/if}
    {/if}
  {/each}
</div>
