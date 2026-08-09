<script lang="ts">
  import Minus from '@lucide/svelte/icons/minus';
import Plus from '@lucide/svelte/icons/plus';
  import { cn } from './utils.ts';

  let {
    value = $bindable(''),
    min,
    max,
    step = 1,
    disabled = false,
    placeholder = '',
    class: className = '',
    onchange
  }: {
    value?: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    placeholder?: string;
    class?: string;
    onchange?: (value: string) => void;
  } = $props();

  // Internal state for the input, initialized from prop
  let inputValue = $state('');

  // Sync internal state when prop changes
  $effect(() => {
    if (value !== inputValue) {
      inputValue = value;
    }
  });

  function clamp(next: number) {
    let result = next;
    if (typeof min === 'number') result = Math.max(min, result);
    if (typeof max === 'number') result = Math.min(max, result);
    return result;
  }

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      inputValue = '';
      value = '';
      onchange?.('');
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      inputValue = '';
      value = '';
      onchange?.('');
      return;
    }
    const newValue = String(clamp(parsed));
    inputValue = newValue;
    value = newValue;
    onchange?.(newValue);
  }

  function nudge(direction: 1 | -1) {
    if (disabled) return;
    const base = inputValue.trim() ? Number(inputValue) : typeof min === 'number' ? min : 0;
    const safeBase = Number.isNaN(base) ? 0 : base;
    const newValue = String(clamp(safeBase + step * direction));
    inputValue = newValue;
    value = newValue;
    onchange?.(newValue);
  }
</script>

<div class={cn('inline-flex h-11 w-full items-stretch overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] shadow-sm', disabled && 'opacity-60', className)}>
  <button
    type="button"
    class="inline-flex w-9 shrink-0 appearance-none items-center justify-center border-r border-[var(--color-border)] text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    disabled={disabled}
    onclick={() => nudge(-1)}
    aria-label="Decrease value"
  >
    <Minus class="size-4" />
  </button>

  <input
    bind:value={inputValue}
    type="text"
    inputmode="decimal"
    {placeholder}
    {disabled}
    class="h-full min-w-[3ch] flex-1 bg-[var(--color-input)] px-2 text-center text-base font-bold text-[var(--color-foreground)] focus-visible:outline-none"
    onblur={() => commit(inputValue)}
    onkeydown={(event) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        nudge(1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        nudge(-1);
      } else if (event.key === 'Enter') {
        commit(inputValue);
      }
    }}
  />

  <button
    type="button"
    class="inline-flex w-9 shrink-0 appearance-none items-center justify-center border-l border-[var(--color-border)] text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    disabled={disabled}
    onclick={() => nudge(1)}
    aria-label="Increase value"
  >
    <Plus class="size-4" />
  </button>
</div>
