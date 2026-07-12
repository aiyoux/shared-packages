<script lang="ts">
  // Structured editor for the `quantity_delta` additional.
  //
  // Shape: `{ id, type:'quantity_delta', delta }`. The single `delta` field
  // lives directly on the additional (positive = inbound, negative = outbound).
  // The rebuild goes through the SDK `buildQuantityDeltaAdditional` builder so
  // the wire shape stays canonical. Takes the whole additional and emits the
  // next whole additional via `onChange`.

  import type { AdditionalWithId } from '../types.ts';
  import { buildQuantityDeltaAdditional } from '../scheduler/inventory.ts';
  import { Label, NumberInput } from '@modular-app/ui';

  let {
    additional,
    onChange
  }: {
    additional: AdditionalWithId | Record<string, any>;
    onChange?: (next: AdditionalWithId | Record<string, any>) => void;
  } = $props();

  const deltaStr = $derived(String((additional as any).delta ?? ''));

  function onDelta(raw: string) {
    const n = Number(raw);
    const next = buildQuantityDeltaAdditional(
      Number.isFinite(n) ? n : 0,
      (additional as any).id
    );
    onChange?.(next);
  }
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-[var(--text-xs)] font-semibold">Delta</Label>
  <NumberInput value={deltaStr} onchange={onDelta} placeholder="0" class="w-36" />
  <p class="text-[var(--text-xs)] text-[var(--color-muted-foreground)]">
    Positive for inbound stock, negative for outbound.
  </p>
</div>