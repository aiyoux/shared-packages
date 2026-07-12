<script lang="ts">
  import type { StartOrEnd, VagueMinuteCode, BaseOrVagueReference } from './date';
  import TimePicker from './TimePicker.svelte';
  import Checkbox from './Checkbox.svelte';

  let {
    value = $bindable<StartOrEnd<VagueMinuteCode, number>>({}),
    format = '12h',
    class: className = ''
  }: {
    value?: StartOrEnd<VagueMinuteCode, number>;
    format?: '12h' | '24h';
    class?: string;
  } = $props();

  const hasEnd = $derived(value.e !== undefined);

  function setHasEnd(next: boolean) {
    if (!next) {
      value.e = undefined;
      return;
    }

    if (value.e === undefined && value.s !== undefined) {
      value.e = { ...value.s } as BaseOrVagueReference<VagueMinuteCode, number>;
      return;
    }

    value.e = { type: 'ba', v: 9 * 60 };
  }
</script>

<div class="flex flex-col gap-4 {className}">
  <div class="flex items-center justify-between">
    <div class="text-[var(--text-sm)] font-medium">Start Time</div>
    <Checkbox
      checked={hasEnd}
      onchange={(checked) => setHasEnd(checked)}
    >
      Different end time
    </Checkbox>
  </div>
  
  <div class="grid gap-4 md:grid-cols-2 items-start">
    <div class="flex flex-col gap-2">
      <TimePicker
        bind:value={value.s}
        side="start"
        format={format}
      />
    </div>
    
    {#if hasEnd}
      <div class="flex flex-col gap-2">
        <TimePicker
          bind:value={value.e}
          side="end"
          format={format}
        />
      </div>
    {/if}
  </div>
</div>
