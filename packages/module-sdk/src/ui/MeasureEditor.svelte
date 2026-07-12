<script lang="ts">
  // Structured editor for the `distance` and `duration` additionals.
  //
  // The two are structurally identical (scalar value + display unit + canonical
  // SI quantity), so one component handles both, branching on `additional.type`
  // for the unit list. Fields live directly on the additional, so this editor
  // takes the whole additional and emits the next whole additional via
  // `onChange`. All mutations — including the manual-value vs rollup-MARKER
  // split and the unit↔canonical rescaling — delegate to the SDK
  // `measure-additional` helpers, which mirror the surql conversion factors.
  // Clients never write `computed:true`; the rollup opt-in IS the marker form.

  import type { AdditionalWithId } from '../types.ts';
  import {
    DISTANCE_UNITS,
    DURATION_UNITS,
    readMeasureAdditional,
    setMeasureComputed,
    setMeasureDesc,
    setMeasureUnit,
    setMeasureValue,
    setMeasureWeight
  } from '../measure-additional.ts';
  import { Checkbox, Label, NumberInput, Select, type SelectOption } from '@modular-app/ui';

  let {
    additional,
    onChange
  }: {
    additional: AdditionalWithId | Record<string, any>;
    onChange?: (next: AdditionalWithId | Record<string, any>) => void;
  } = $props();

  const shape = $derived(readMeasureAdditional(additional));

  const unitOptions: SelectOption<string>[] = $derived.by(() => {
    const units = shape?.kind === 'duration' ? DURATION_UNITS : DISTANCE_UNITS;
    const opts: SelectOption<string>[] = units.map((u) => ({ value: u.value, label: u.label }));
    // Preserve a custom/legacy unit so it stays selectable instead of clearing.
    const current = (additional as any)?.unit;
    if (current && !units.some((u) => u.value === current)) {
      opts.push({ value: current, label: current });
    }
    return opts;
  });

  const valueStr = $derived(shape && !shape.computed ? String(shape.value) : '');
  const weightStr = $derived(shape && Number.isFinite(shape.weight) ? String(shape.weight) : '');
  const descStr = $derived(shape?.desc ?? '');

  function emit(next: AdditionalWithId | Record<string, any>) {
    onChange?.(next);
  }
  function onValue(raw: string) {
    if (!shape || shape.computed) return;
    const n = Number(raw);
    emit(setMeasureValue(additional, Number.isFinite(n) ? n : 0));
  }
  function onUnit(u: string | number | null) {
    if (!shape) return;
    emit(setMeasureUnit(additional, typeof u === 'string' && u ? u : shape.unit));
  }
  function onComputed(checked: boolean) {
    emit(setMeasureComputed(additional, checked));
  }
  function onWeight(raw: string) {
    const n = Number(raw);
    emit(setMeasureWeight(additional, Number.isFinite(n) ? n : 100));
  }
  function onDesc(raw: string) {
    emit(setMeasureDesc(additional, raw || null));
  }
</script>

{#if shape}
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2 text-[var(--text-sm)]">
      <span class="text-[var(--color-muted-foreground)]">Current</span>
      {#if shape.computed}
        <span class="font-medium">auto from descendants</span>
      {:else}
        <span class="font-medium tabular-nums">{shape.value} {shape.unit}</span>
      {/if}
    </div>

    <Checkbox checked={shape.computed} onchange={onComputed}>
      Auto-calculate from descendants
    </Checkbox>

    <div class="flex items-center gap-2" class:opacity-50={shape.computed}>
      <div class="flex flex-col gap-1.5 flex-1">
        <Label class="text-[var(--text-xs)] font-semibold">Value</Label>
        <NumberInput
          value={valueStr}
          onchange={onValue}
          min={0}
          placeholder="0"
          class="w-32"
        />
      </div>
      <div class="flex flex-col gap-1.5 flex-1">
        <Label class="text-[var(--text-xs)] font-semibold">Unit</Label>
        <Select
          value={shape.unit}
          options={unitOptions}
          onValueChange={onUnit}
          ariaLabel="Unit"
          class="flex-1"
        />
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label class="text-[var(--text-xs)] font-semibold">Weight</Label>
      <NumberInput value={weightStr} onchange={onWeight} min={0} class="w-28" />
      <p class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">
        Relative contribution when this measure rolls up into a computed parent.
      </p>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label class="text-[var(--text-xs)] font-semibold">Description</Label>
      <input
        type="text"
        value={descStr}
        placeholder="Optional note"
        oninput={(e) => onDesc((e.currentTarget as HTMLInputElement).value)}
        class="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      />
    </div>
  </div>
{:else}
  <div class="text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
    Not a distance or duration additional.
  </div>
{/if}