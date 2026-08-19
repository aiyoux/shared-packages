<script lang="ts">
  /**
   * Design-system select — native <select> primitive matching the options /
   * bind:value / onValueChange API used by the former ui Select. Token-driven
   * (same control chrome as Input), no Popover / Tailwind / icon dependency.
   */
  import type { SelectOption } from './select.ts';

  let {
    value = $bindable<string | number | null>(null),
    options = [],
    placeholder = 'Select an option',
    ariaLabel,
    disabled = false,
    class: className = '',
    contentClass = '',
    onValueChange
  }: {
    value?: string | number | null;
    options?: SelectOption<string | number>[];
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    class?: string;
    contentClass?: string;
    onValueChange?: (value: string | number | null) => void;
  } = $props();

  const stringValue = $derived(value == null ? '' : String(value));
  const hasMatchingOption = $derived(options.some((option) => String(option.value) === stringValue));

  function handleChange(event: Event) {
    const raw = (event.currentTarget as HTMLSelectElement).value;
    if (raw === '') {
      value = null;
      onValueChange?.(null);
      return;
    }
    const option = options.find((candidate) => String(candidate.value) === raw);
    value = option ? option.value : raw;
    onValueChange?.(value);
  }
</script>

<select
  class="ds-select {className} {contentClass}"
  aria-label={ariaLabel}
  {disabled}
  value={stringValue}
  onchange={handleChange}
>
  {#if !hasMatchingOption}
    <option value="" disabled={value != null}>{placeholder}</option>
  {/if}
  {#each options as option (String(option.value))}
    <option value={String(option.value)} disabled={option.disabled}>
      {option.label}{option.hint ? ` — ${option.hint}` : ''}
    </option>
  {/each}
</select>

<style>
  .ds-select {
    width: 100%;
    appearance: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.9rem;
    padding: 8px 12px;
    transition:
      border-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .ds-select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
    background: var(--bg-secondary);
  }
  .ds-select:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
</style>
