<script lang="ts">
  // Structured editor for the `pg` (progress) additional.
  //
  // The progress additional's fields live directly ON the additional (not
  // nested under `value`), so this editor takes the whole additional and emits
  // the next whole additional via `onChange`. All mutations delegate to the
  // SDK progress helpers (`@modular-app/module-sdk`), which own the wire shape
  // — including the manual-value vs rollup-MARKER split — so this component is
  // pure UI glue and never hand-rolls `prog_type` / `mode` / `base_prog_type`.
  //
  // Two authored shapes:
  //  - Manual value:  `{ id, type:'pg', prog_type:{ch|pct}, weight, desc }`
  //  - Rollup marker: `{ id, type:'pg', mode:'rollup', base_prog_type, weight, desc, offset_base? }`
  // Clients never write `computed:true`; the rollup opt-in IS the marker form.

  import type { AdditionalWithId } from '../types.ts';
  import {
    readProgressAdditional,
    setProgressAdditionalComputed,
    setProgressAdditionalDesc,
    setProgressAdditionalKind,
    setProgressAdditionalValue,
    setProgressAdditionalWeight,
    type CheckProgressValue,
    type ProgressKind
  } from '../progress-additional.ts';
  import { Checkbox, Label, NumberInput, SegmentedControl, type SegmentedControlOption } from '@modular-app/ui';

  let {
    additional,
    onChange
  }: {
    additional: AdditionalWithId | Record<string, any>;
    onChange?: (next: AdditionalWithId | Record<string, any>) => void;
  } = $props();

  const shape = $derived(readProgressAdditional(additional));

  const KIND_OPTIONS: SegmentedControlOption<ProgressKind>[] = [
    { value: 'check', label: 'Check' },
    { value: 'percentage', label: 'Percentage' }
  ];

  // Check values in display order with human labels.
  const CHECK_OPTIONS: { value: CheckProgressValue; label: string }[] = [
    { value: 'False', label: 'Not done' },
    { value: 'Partial', label: 'In progress' },
    { value: 'NA', label: 'N/A' },
    { value: 'WontDo', label: "Won't do" },
    { value: 'True', label: 'Done' }
  ];

  const weightStr = $derived(
    shape && Number.isFinite(shape.weight) ? String(shape.weight) : ''
  );
  const descStr = $derived(shape?.desc ?? '');
  const pctValue = $derived(
    shape?.kind === 'percentage' && typeof shape.value === 'number' ? shape.value : 0
  );

  function emit(next: AdditionalWithId | Record<string, any>) {
    onChange?.(next);
  }

  function onKind(v: string | number | null) {
    if (!shape) return;
    emit(setProgressAdditionalKind(additional, v as ProgressKind));
  }
  function onComputed(checked: boolean) {
    emit(setProgressAdditionalComputed(additional, checked));
  }
  function onCheckValue(v: CheckProgressValue) {
    emit(setProgressAdditionalValue(additional, v));
  }
  function onPercentage(raw: string) {
    const n = Number(raw);
    emit(setProgressAdditionalValue(additional, Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0));
  }
  function onPercentageRange(v: number) {
    emit(setProgressAdditionalValue(additional, Math.max(0, Math.min(100, Math.round(v)))));
  }
  function onWeight(raw: string) {
    const n = Number(raw);
    emit(setProgressAdditionalWeight(additional, Number.isFinite(n) ? n : 100));
  }
  function onDesc(raw: string) {
    emit(setProgressAdditionalDesc(additional, raw || null));
  }
</script>

{#if shape}
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-2 text-[var(--text-sm)]">
      <span class="text-[var(--color-muted-foreground)]">Current</span>
      {#if shape.kind === 'check'}
        <span class="font-medium">{CHECK_OPTIONS.find((o) => o.value === shape.value)?.label ?? 'Not done'}</span>
      {:else}
        <span class="font-medium tabular-nums">{pctValue}%</span>
      {/if}
      {#if shape.computed}
        <span class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">· auto from descendants</span>
      {/if}
    </div>

    <SegmentedControl
      value={shape.kind}
      options={KIND_OPTIONS}
      fullWidth
      ariaLabel="Progress kind"
      onValueChange={onKind}
    />

    <Checkbox checked={shape.computed} onchange={onComputed}>
      Auto-calculate from descendants
    </Checkbox>

    {#if shape.kind === 'check'}
      <div class="flex flex-wrap items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-muted)] p-0.5 text-[var(--text-xs)]" class:opacity-50={shape.computed}>
        {#each CHECK_OPTIONS as opt}
          <button
            type="button"
            disabled={shape.computed}
            onclick={() => onCheckValue(opt.value)}
            class="flex-1 rounded px-2 py-1 transition-colors {shape.value === opt.value ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)] font-semibold' : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'} {shape.computed ? 'cursor-not-allowed' : ''}"
          >{opt.label}</button>
        {/each}
      </div>
    {:else}
      <div class="flex flex-col gap-2" class:opacity-50={shape.computed}>
        <div class="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={pctValue}
            disabled={shape.computed}
            oninput={(e) => onPercentageRange(Number((e.currentTarget as HTMLInputElement).value))}
            class="flex-1"
          />
          <NumberInput
            value={String(pctValue)}
            onchange={onPercentage}
            min={0}
            max={100}
            class="w-20"
          />
          <span class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">%</span>
        </div>
      </div>
    {/if}

    <div class="flex flex-col gap-1.5">
      <Label class="text-[var(--text-xs)] font-semibold">Weight</Label>
      <NumberInput value={weightStr} onchange={onWeight} min={0} class="w-28" />
      <p class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">
        Relative contribution when this progress rolls up into a computed parent.
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
    Not a progress additional.
  </div>
{/if}