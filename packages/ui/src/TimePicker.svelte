<script lang="ts">
  import type { BaseOrVagueReference, VagueMinuteCode } from './date';
  import {
    VAGUE_MINUTES,
    VAGUE_MINUTE_ORDER,
    vagueMinuteForMinuteOfDay,
    vagueMinuteValue
  } from './date';
  import Button from './Button.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import { cn } from './utils.ts';

  type PickerMode = 'exact' | 'vague';
  type PickerPreference = PickerMode | 'auto';
  type ClockFormat = '12h' | '24h';
  type MinuteParts = {
    hour: string;
    minute: string;
    meridiem: 'AM' | 'PM';
  };

  let {
    value = $bindable<BaseOrVagueReference<VagueMinuteCode, number> | null>(),
    mode = 'auto',
    side = 'start',
    format = '12h',
    class: className = ''
  }: {
    value?: BaseOrVagueReference<VagueMinuteCode, number> | null;
    mode?: PickerPreference;
    side?: 'start' | 'end';
    format?: ClockFormat;
    class?: string;
  } = $props();

  function initialMode(): PickerMode {
    return mode === 'vague' || (mode === 'auto' && value?.type === 'vg') ? 'vague' : 'exact';
  }

  let internalMode = $state<PickerMode>(initialMode());
  let hourText = $state('09');
  let minuteText = $state('00');
  let meridiem = $state<'AM' | 'PM'>('AM');

  function toConcreteMinute(reference: BaseOrVagueReference<VagueMinuteCode, number> | null): number | null {
    if (!reference) return null;
    if (reference.type === 'ba') return reference.v;
    if (reference.type === 'vg') return vagueMinuteValue(reference.t, 'start');
    return null;
  }

  function pad(value: number) {
    return String(value).padStart(2, '0');
  }

  function minuteToParts(minutes: number): MinuteParts {
    const clamped = Math.min(Math.max(0, minutes), 1439);
    const hour24 = Math.floor(clamped / 60);
    const minute = clamped % 60;
    if (format === '24h') {
      return {
        hour: pad(hour24),
        minute: pad(minute),
        meridiem: 'AM' as const
      };
    }
    const meridiemValue = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 || 12;
    return {
      hour: pad(hour12),
      minute: pad(minute),
      meridiem: meridiemValue
    };
  }

  function syncExactFields() {
    const concreteMinute = toConcreteMinute(value) ?? 9 * 60;
    const parts = minuteToParts(concreteMinute);
    hourText = parts.hour;
    minuteText = parts.minute;
    meridiem = parts.meridiem;
  }

  function commitExact() {
    const parsedHour = Number(hourText);
    const parsedMinute = Number(minuteText);
    if (Number.isNaN(parsedHour) || Number.isNaN(parsedMinute)) {
      syncExactFields();
      return;
    }

    const minute = Math.min(Math.max(0, parsedMinute), 59);
    let hour24 = 0;

    if (format === '24h') {
      hour24 = Math.min(Math.max(0, parsedHour), 23);
    } else {
      const hour12 = Math.min(Math.max(1, parsedHour), 12);
      hour24 = hour12 % 12;
      if (meridiem === 'PM') hour24 += 12;
    }

    const total = hour24 * 60 + minute;
    value = { type: 'ba', v: total };
    const parts = minuteToParts(total);
    hourText = parts.hour;
    minuteText = parts.minute;
    meridiem = parts.meridiem;
  }

  function setMode(nextMode: PickerMode) {
    if (mode !== 'auto') {
      internalMode = nextMode;
      return;
    }

    if (nextMode === 'exact') {
      if (value?.type === 'vg') {
        value = { type: 'ba', v: vagueMinuteValue(value.t, 'start') };
      } else if (!value || value.type !== 'ba') {
        value = { type: 'ba', v: 9 * 60 };
      }
      syncExactFields();
    } else {
      const minute = toConcreteMinute(value) ?? 9 * 60;
      value = { type: 'vg', t: vagueMinuteForMinuteOfDay(minute) ?? 'mo' };
    }

    internalMode = nextMode;
  }

  function formatMinuteOfDay(minutes: number) {
    const clamped = Math.min(Math.max(0, minutes), 1439);
    const hour = Math.floor(clamped / 60);
    const minute = clamped % 60;
    if (format === '24h') {
      return `${pad(hour)}:${pad(minute)}`;
    }
    const meridiemValue = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${pad(minute)} ${meridiemValue}`;
  }

  const selectedVague = $derived(value?.type === 'vg' ? value.t : null);

  const timeState = $derived.by(() => {
    const total = toConcreteMinute(value) ?? 9 * 60;
    const h24 = Math.floor(total / 60);
    const dHour = format === '12h' ? (h24 % 12 || 12) : h24;
    const min = total % 60;
    return { total, h24, dHour, min };
  });

  $effect(() => {
    if (mode === 'exact' || mode === 'vague') {
      internalMode = mode;
      if (mode === 'exact') {
        syncExactFields();
      }
      return;
    }

    internalMode = value?.type === 'vg' ? 'vague' : 'exact';
    if (internalMode === 'exact') {
      syncExactFields();
    }
  });

  const selectedButtonClass =
    'border-[color-mix(in_srgb,var(--color-primary),var(--color-border)_55%)] bg-[color-mix(in_srgb,var(--color-primary),var(--color-panel)_84%)] text-[var(--color-foreground)] shadow-sm hover:bg-[color-mix(in_srgb,var(--color-primary),var(--color-panel)_78%)]';
  const unselectedButtonClass =
    'border-[var(--color-border)] bg-transparent text-[var(--color-foreground)] hover:bg-[var(--color-muted)]';

  let exactDialMode = $state<'hour' | 'minute'>('hour');

  function setDialHour(h: number) {
    let hour24 = h;
    if (format === '12h') {
      const isPm = meridiem === 'PM';
      hour24 = h === 12 ? (isPm ? 12 : 0) : h + (isPm ? 12 : 0);
    }
    const currentMinute = Number(minuteText) || 0;
    const total = hour24 * 60 + currentMinute;
    value = { type: 'ba', v: total };
    syncExactFields();
    exactDialMode = 'minute';
  }

  function setDialMinute(m: number) {
    const concreteMinute = toConcreteMinute(value) ?? 9 * 60;
    const hour24 = Math.floor(concreteMinute / 60);
    const total = hour24 * 60 + m;
    value = { type: 'ba', v: total };
    syncExactFields();
  }

  const hours12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const hours24 = [0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5);

  function getAngle(index: number, total: number) {
    return (index / total) * 360 - 90;
  }
</script>

<div class={cn('grid gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background)] p-4', className)} style="width: 100%; max-width: 320px; box-sizing: border-box;">
  {#if mode === 'auto'}
    <div class="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        size="sm"
        class={internalMode === 'exact' ? selectedButtonClass : unselectedButtonClass}
        onclick={() => setMode('exact')}
      >
        Exact
      </Button>
      <Button
        variant="secondary"
        size="sm"
        class={internalMode === 'vague' ? selectedButtonClass : unselectedButtonClass}
        onclick={() => setMode('vague')}
      >
        Vague
      </Button>
    </div>
  {/if}

  {#if internalMode === 'exact'}
    <div class="flex flex-wrap items-center gap-2">
      <div class="inline-flex items-center gap-1.5">
        <input
          bind:value={hourText}
          inputmode="numeric"
          aria-label="Hour"
          class="h-11 w-20 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 text-center text-[var(--text-md)] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          onblur={commitExact}
          onkeydown={(event) => {
            if (event.key === 'Enter') commitExact();
          }}
        />
        <span class="w-3 text-center text-[var(--text-lg)] font-semibold text-[var(--color-muted-foreground)]">:</span>
        <input
          bind:value={minuteText}
          inputmode="numeric"
          aria-label="Minute"
          class="h-11 w-20 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 text-center text-[var(--text-md)] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          onblur={commitExact}
          onkeydown={(event) => {
            if (event.key === 'Enter') commitExact();
          }}
        />
      </div>
      {#if format === '12h'}
        <SegmentedControl
          ariaLabel="Meridiem"
          options={[{ value: 'AM', label: 'AM' }, { value: 'PM', label: 'PM' }]}
          bind:value={meridiem}
          onValueChange={() => commitExact()}
          class="w-fit"
        />
      {/if}
    </div>

    <div class="mt-4 flex flex-col items-center select-none bg-[var(--color-input)]/10 rounded-[var(--radius-lg)] p-4 border border-[var(--color-border)]">
      <div class="flex gap-4 mb-4">
        <SegmentedControl
          ariaLabel="Dial Mode"
          options={[{ value: 'hour', label: 'Hour' }, { value: 'minute', label: 'Minute' }]}
          bind:value={exactDialMode}
        />
      </div>
      
      <div class="relative w-48 h-48 rounded-full bg-[var(--color-input)]/40 flex items-center justify-center">
        <div class="w-2 h-2 rounded-full bg-[var(--color-primary)] absolute z-[var(--z-raised)]" style="left: calc(50% - 4px); top: calc(50% - 4px);"></div>

        {#if exactDialMode === 'hour'}
          {@const isInner24 = format === '24h' && (timeState.h24 === 0 || timeState.h24 > 12)}
          {@const hourRadius = isInner24 ? 55 : 85}
          {@const hourAngle = format === '12h' ? getAngle(timeState.dHour % 12, 12) : getAngle(timeState.h24 % 12, 12)}
          {@const lineLength = isInner24 ? '25%' : '38%'}
          
          <div class="absolute w-0.5 bg-[var(--color-primary)] origin-bottom transition-transform duration-300 z-[var(--z-raised)]" style="height: {lineLength}; bottom: 50%; left: calc(50% - 1px); transform: rotate({(format === '12h' ? timeState.dHour % 12 : timeState.h24 % 12) * 30}deg);"></div>
          <div class="absolute w-8 h-8 rounded-full bg-[var(--color-primary)]/20 border-2 border-[var(--color-primary)] transition-transform duration-300 pointer-events-none z-[var(--z-raised)]" style="left: calc(50% - 16px); top: calc(50% - 16px); transform: rotate({hourAngle}deg) translate({hourRadius}px);"></div>

          {#each (format === '12h' ? hours12 : hours24) as h, i}
            {@const isInner = format === '24h' && i < 12}
            {@const angle = getAngle(i % 12, 12)}
            {@const radius = isInner ? 55 : 85}
            {@const isActive = format === '12h' ? (timeState.dHour % 12 === h % 12) : (timeState.h24 === h)}
            <button
              type="button"
              aria-label="Select hour {h}"
              class={cn("absolute w-8 h-8 rounded-full flex items-center justify-center text-[var(--text-xsm)] font-medium transition-colors cursor-pointer z-[var(--z-floating)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]", isActive ? "bg-[var(--color-primary)] text-primary-foreground shadow-md" : "hover:bg-[var(--color-muted)] text-[var(--color-foreground)]")}
              style="left: calc(50% - 16px); top: calc(50% - 16px); transform: rotate({angle}deg) translate({radius}px) rotate({-angle}deg);"
              onclick={() => setDialHour(h)}
            >
              {h}
            </button>
          {/each}
        {:else}
          {@const currentMinuteAngle = getAngle(timeState.min, 60)}

          <div class="absolute w-0.5 bg-[var(--color-primary)] origin-bottom transition-transform duration-300 z-[var(--z-raised)]" style="height: 38%; bottom: 50%; left: calc(50% - 1px); transform: rotate({timeState.min * 6}deg);"></div>
          <div class="absolute w-8 h-8 rounded-full bg-[var(--color-primary)]/20 border-2 border-[var(--color-primary)] transition-transform duration-300 pointer-events-none z-[var(--z-raised)]" style="left: calc(50% - 16px); top: calc(50% - 16px); transform: rotate({currentMinuteAngle}deg) translate(85px);"></div>

          {#each minuteOptions as m, i}
            {@const angle = getAngle(i, 12)}
            <button
              type="button"
              aria-label="Select minute {m}"
              class={cn("absolute w-8 h-8 rounded-full flex items-center justify-center text-[var(--text-xsm)] font-medium transition-colors cursor-pointer z-[var(--z-floating)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]", timeState.min === m ? "bg-[var(--color-primary)] text-primary-foreground shadow-md" : "hover:bg-[var(--color-muted)] text-[var(--color-foreground)]")}
              style="left: calc(50% - 16px); top: calc(50% - 16px); transform: rotate({angle}deg) translate(85px) rotate({-angle}deg);"
              onclick={() => setDialMinute(m)}
            >
              {m}
            </button>
          {/each}        {/if}
      </div>
    </div>
  {:else}
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {#each VAGUE_MINUTE_ORDER as code (code)}
        {@const info = VAGUE_MINUTES[code]}
        <Button
          variant="secondary"
          size="sm"
          class={cn(
            'h-auto justify-start py-3 text-left',
            selectedVague === code ? selectedButtonClass : unselectedButtonClass
          )}
          onclick={() => {
            value = { type: 'vg', t: code };
          }}
        >
          <span>{info.label}</span>
        </Button>
      {/each}
    </div>
  {/if}
</div>
