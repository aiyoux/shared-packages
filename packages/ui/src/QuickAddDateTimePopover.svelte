<script lang="ts">
  import {
    CalendarDays,
    CalendarRange,
    Check,
    ChevronDown,
    Clock3,
    Sparkles,
    X
  } from '@lucide/svelte';
  import type { TimeReference, VagueDayCode, VagueMinuteCode, VagueMonthCode } from './date';
  import {
    cleanupEmptyFields,
    formatTimeReferenceRangeLabel,
    VAGUE_DAYS,
    VAGUE_MINUTES,
    VAGUE_MONTHS
  } from './date';
  import Button from './Button.svelte';
  import Popover from './Popover.svelte';
  import TimeReferenceRangeEditor from './TimeReferenceRangeEditor.svelte';
  import {
    DEFAULT_QUICK_ADD_DATE_TIME_PRESETS,
    cloneQuickAddTimeReference,
    type QuickAddDateTimePreset
  } from './quick-add-date-time.ts';
  import { cn } from './utils.ts';

  type CommitMode = 'manual' | 'live';

  let {
    value = $bindable<TimeReference>({}),
    open = $bindable(false),
    now = new Date(),
    label = 'When',
    placeholder = 'Pick date and time',
    allowVague = true,
    allowEndDate = true,
    allowEndTime = true,
    compactCalendar = true,
    commitMode = 'manual',
    presets = DEFAULT_QUICK_ADD_DATE_TIME_PRESETS,
    class: className = '',
    contentClass = '',
    onApply,
    onCancel,
    onDraftChange
  }: {
    value?: TimeReference;
    open?: boolean;
    now?: Date;
    label?: string;
    placeholder?: string;
    allowVague?: boolean;
    allowEndDate?: boolean;
    allowEndTime?: boolean;
    compactCalendar?: boolean;
    commitMode?: CommitMode;
    presets?: QuickAddDateTimePreset[];
    class?: string;
    contentClass?: string;
    onApply?: (value: TimeReference) => void;
    onCancel?: () => void;
    onDraftChange?: (value: TimeReference) => void;
  } = $props();

  let draft = $state<TimeReference>(cloneQuickAddTimeReference(value));
  let wasOpen = $state(false);
  let activePresetId = $state<string | null>(null);

  const triggerLabel = $derived.by(() => {
    const formatted = formatTimeReferenceRangeLabel(value);
    return formatted === 'No date' ? placeholder : formatted;
  });

  const startDateLabel = $derived(formatDateSide(value, 's') ?? 'Start date');
  const startTimeLabel = $derived(formatTimeSide(value, 's') ?? 'Add time');
  const endLabel = $derived(formatEndLabel(value) ?? 'Add end');

  function applyPreset(preset: QuickAddDateTimePreset) {
    draft = cleanupEmptyFields(preset.build({ now }));
    activePresetId = preset.id;
  }

  function applyDraft() {
    const next = cleanupEmptyFields(cloneQuickAddTimeReference(draft));
    value = next;
    open = false;
    onApply?.(next);
  }

  function cancelDraft() {
    draft = cloneQuickAddTimeReference(value);
    activePresetId = null;
    open = false;
    onCancel?.();
  }

  function handleImplicitClose() {
    draft = cloneQuickAddTimeReference(value);
    activePresetId = null;
    onCancel?.();
  }

  function monthName(month: number) {
    return new Date(2026, month - 1, 1).toLocaleString('default', { month: 'short' });
  }

  function formatMinute(minutes: number) {
    const clamped = Math.min(Math.max(0, minutes), 1439);
    const hour24 = Math.floor(clamped / 60);
    const minute = clamped % 60;
    const meridiem = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
  }

  function formatDateSide(source: TimeReference, side: 's' | 'e') {
    const y = source.y?.[side];
    const m = source.m?.[side];
    const d = source.d?.[side];
    const year = y?.type === 'ba' ? y.v : null;

    if (m?.type === 'vg') {
      return `${VAGUE_MONTHS[m.t as VagueMonthCode]?.label ?? 'Vague month'}${year ? ` ${year}` : ''}`;
    }

    if (d?.type === 'vg') {
      const prefix = m?.type === 'ba' ? monthName(m.v) : '';
      const suffix = year ? `, ${year}` : '';
      return `${prefix} ${VAGUE_DAYS[d.t as VagueDayCode]?.label ?? 'Vague day'}${suffix}`.trim();
    }

    if (y?.type === 'ba' && m?.type === 'ba' && d?.type === 'ba') {
      return `${monthName(m.v)} ${d.v}, ${y.v}`;
    }

    if (y?.type === 'ba' && m?.type === 'ba') {
      return `${monthName(m.v)} ${y.v}`;
    }

    return null;
  }

  function formatTimeSide(source: TimeReference, side: 's' | 'e') {
    const time = source.i?.[side];
    if (!time) return null;
    if (time.type === 'vg') return VAGUE_MINUTES[time.t as VagueMinuteCode]?.label ?? 'Vague time';
    if (time.type === 'ba') return formatMinute(time.v);
    return null;
  }

  function formatEndLabel(source: TimeReference) {
    const date = formatDateSide(source, 'e');
    const time = formatTimeSide(source, 'e');
    if (date && time) return `${date} · ${time}`;
    return date ?? time;
  }

  $effect(() => {
    if (open && !wasOpen) {
      draft = cloneQuickAddTimeReference(value);
      activePresetId = null;
    }
    wasOpen = open;
  });

  $effect(() => {
    const next = cleanupEmptyFields(cloneQuickAddTimeReference(draft));
    onDraftChange?.(next);
    if (commitMode === 'live' && open) {
      value = next;
    }
  });
</script>

<Popover
  bind:open
  placement="bottom-start"
  offset={10}
  mobileMode="center"
  onClose={handleImplicitClose}
  contentClass={cn(
    'w-[min(48rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_28px_80px_-36px_rgba(0,0,0,0.82)]',
    contentClass
  )}
>
  {#snippet trigger({ ref })}
    <button
      use:ref
      type="button"
      class={cn(
        'group inline-flex min-w-[20rem] max-w-full flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-3 text-left shadow-[0_14px_34px_-24px_rgba(0,0,0,0.7)] transition hover:border-[color-mix(in_srgb,var(--color-primary),var(--color-border)_55%)] hover:bg-[var(--color-muted)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
        className
      )}
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={() => {
        open = !open;
      }}
    >
      <span class="flex w-full items-center justify-between gap-3">
        <span class="inline-flex items-center gap-2 text-[var(--text-xsm)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">
          <CalendarRange class="size-3.5" />
          {label}
        </span>
        <ChevronDown class={cn('size-4 text-[var(--color-muted-foreground)] transition-transform', open && 'rotate-180')} />
      </span>

      <span class="block max-w-full truncate text-[var(--text-sm)] font-semibold text-[var(--color-foreground)]">{triggerLabel}</span>

      <span class="grid w-full min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
        <span class="quick-pill">
          <CalendarDays class="size-3.5 shrink-0" />
          <span class="truncate">{startDateLabel}</span>
        </span>
        <span class="quick-pill">
          <Clock3 class="size-3.5 shrink-0" />
          <span class="truncate">{startTimeLabel}</span>
        </span>
        <span class="quick-pill quick-pill--muted">
          <CalendarRange class="size-3.5 shrink-0" />
          <span class="truncate">{endLabel}</span>
        </span>
      </span>
    </button>
  {/snippet}

  {#snippet content()}
    <div class="quick-popup" role="dialog" aria-label={`${label} popup`}>
      <div class="quick-popup__header">
        <div class="min-w-0">
          <div class="quick-popup__eyebrow">
            <Sparkles class="size-3.5" />
            Quick add date popup
          </div>
          <h3>{triggerLabel}</h3>
        </div>
        <button type="button" class="quick-popup__icon-btn" aria-label="Close popup" onclick={cancelDraft}>
          <X class="size-4" />
        </button>
      </div>

      <div class="quick-popup__body">
        <aside class="quick-popup__rail" aria-label="Quick date presets">
          {#each presets as preset (preset.id)}
            <button
              type="button"
              class={activePresetId === preset.id ? 'quick-popup__rail-button--active' : ''}
              onclick={() => applyPreset(preset)}
            >
              <span>{preset.label}</span>
              <small>{preset.hint}</small>
            </button>
          {/each}
        </aside>

        <section class="quick-popup__editor" aria-label="Date and time editor">
          <TimeReferenceRangeEditor
            bind:value={draft}
            {allowVague}
            {allowEndDate}
            {allowEndTime}
            {compactCalendar}
            startDateLabel="Start"
            startTimeLabel="Start time"
            endDateLabel="End"
            endTimeLabel="End time"
            density="compact"
          />
        </section>
      </div>

      <div class="quick-popup__footer">
        <p>{formatTimeReferenceRangeLabel(draft)}</p>
        <div class="flex items-center gap-2">
          {#if commitMode === 'manual'}
            <Button variant="ghost" size="sm" onclick={cancelDraft}>Cancel</Button>
            <Button variant="primary" size="sm" onclick={applyDraft}>
              <Check class="size-4" />
              Apply
            </Button>
          {:else}
            <Button variant="primary" size="sm" onclick={() => { open = false; }}>
              <Check class="size-4" />
              Done
            </Button>
          {/if}
        </div>
      </div>
    </div>
  {/snippet}
</Popover>

<style>
  .quick-pill {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 0.35rem;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--color-border), transparent 24%);
    background: color-mix(in srgb, var(--color-input), transparent 42%);
    padding: 0.4rem 0.55rem;
    color: var(--color-foreground);
    font-size: var(--text-xsm);
    font-weight: 600;
  }

  .quick-pill--muted {
    color: var(--color-muted-foreground);
  }

  .quick-popup {
    overflow: hidden;
    border-radius: var(--radius-lg);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-primary) 6%, transparent), transparent 12rem),
      var(--color-panel);
  }

  .quick-popup__header,
  .quick-popup__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-color: color-mix(in srgb, var(--color-border), transparent 25%);
    padding: 0.95rem 1rem;
  }

  .quick-popup__header {
    border-bottom: 1px solid color-mix(in srgb, var(--color-border), transparent 25%);
  }

  .quick-popup__header h3 {
    margin: 0.2rem 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: 0;
  }

  .quick-popup__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-muted-foreground);
    font-size: var(--text-xsm);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .quick-popup__icon-btn {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    color: var(--color-muted-foreground);
    transition: background-color 140ms ease, color 140ms ease;
  }

  .quick-popup__icon-btn:hover {
    background: var(--color-muted);
    color: var(--color-foreground);
  }

  .quick-popup__body {
    display: grid;
    grid-template-columns: 10rem minmax(0, 1fr);
    gap: 1rem;
    max-height: min(34rem, calc(100vh - 9rem));
    overflow: auto;
    padding: 1rem;
  }

  .quick-popup__rail {
    display: grid;
    align-content: start;
    gap: 0.5rem;
  }

  .quick-popup__rail button {
    display: flex;
    min-height: 3.45rem;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-background), transparent 18%);
    padding: 0.65rem 0.75rem;
    text-align: left;
    transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
  }

  .quick-popup__rail button:hover {
    border-color: color-mix(in srgb, var(--color-primary), var(--color-border) 52%);
    background: color-mix(in srgb, var(--color-primary) 10%, var(--color-background));
  }

  .quick-popup__rail button.quick-popup__rail-button--active {
    border-color: color-mix(in srgb, var(--color-primary), var(--color-border) 28%);
    background: color-mix(in srgb, var(--color-primary) 14%, var(--color-background));
  }

  .quick-popup__rail span {
    font-size: var(--text-sm);
    font-weight: 700;
    color: var(--color-foreground);
  }

  .quick-popup__rail small {
    margin-top: 0.1rem;
    color: var(--color-muted-foreground);
    font-size: var(--text-xsm);
  }

  .quick-popup__editor {
    min-width: 0;
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--color-border), transparent 22%);
    background: color-mix(in srgb, var(--color-background), transparent 8%);
    padding: 0.75rem;
  }

  .quick-popup__footer {
    border-top: 1px solid color-mix(in srgb, var(--color-border), transparent 25%);
    background: color-mix(in srgb, var(--color-panel), var(--color-background) 16%);
  }

  .quick-popup__footer p {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  @media (max-width: 720px) {
    .quick-popup__body {
      grid-template-columns: minmax(0, 1fr);
      max-height: min(38rem, calc(100vh - 7rem));
    }

    .quick-popup__rail {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .quick-popup__footer {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
