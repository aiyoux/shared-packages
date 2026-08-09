<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Popover from './Popover.svelte';
  import { cn } from './utils.ts';
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

  let open = $state(false);
  let highlightedIndex = $state(-1);

  const enabledOptions = $derived(options.filter((option) => !option.disabled));
  const selectedOption = $derived(options.find((option) => option.value === value) ?? null);

  function syncHighlight() {
    const selectedIndex = enabledOptions.findIndex((option) => option.value === value);
    highlightedIndex = selectedIndex >= 0 ? selectedIndex : enabledOptions.length > 0 ? 0 : -1;
  }

  function selectOption(option: SelectOption<string | number>) {
    if (option.disabled) return;
    value = option.value;
    open = false;
    onValueChange?.(option.value);
  }

  function moveHighlight(direction: 1 | -1) {
    if (enabledOptions.length === 0) return;
    if (highlightedIndex < 0) {
      highlightedIndex = direction === 1 ? 0 : enabledOptions.length - 1;
      return;
    }
    highlightedIndex = (highlightedIndex + direction + enabledOptions.length) % enabledOptions.length;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
      } else {
        moveHighlight(1);
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
      } else {
        moveHighlight(-1);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
        return;
      }
      const option = enabledOptions[highlightedIndex];
      if (option) {
        selectOption(option);
      }
    }
  }

  $effect(() => {
    if (!open) return;
    syncHighlight();
  });
</script>

<Popover bind:open placement="bottom-start" contentClass={cn('min-w-[14rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.65)]', contentClass)}>
  {#snippet trigger({ ref })}
    <button
      use:ref
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled}
      class={cn(
        'inline-flex h-11 w-full appearance-none items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-left text-[var(--text-sm)] text-[var(--color-foreground)] shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      onclick={() => {
        open = !open;
      }}
      onkeydown={handleKeyDown}
    >
      <span class={cn('truncate', !selectedOption && 'text-[var(--color-muted-foreground)]')}>
        {selectedOption?.label ?? placeholder}
      </span>
      <ChevronDown class={cn('size-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform', open && 'rotate-180')} />
    </button>
  {/snippet}

  {#snippet content()}
    <div role="listbox" aria-label={ariaLabel} class="max-h-72 overflow-auto py-1" onkeydown={handleKeyDown} tabindex="-1">
      {#each options as option, index (String(option.value))}
        {@const enabledIndex = enabledOptions.findIndex((candidate) => candidate.value === option.value)}
        {@const highlighted = enabledIndex >= 0 && enabledIndex === highlightedIndex}
        <button
          type="button"
          role="option"
          aria-selected={value === option.value}
          disabled={option.disabled}
          class={cn(
            'flex w-full appearance-none items-start justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left text-[var(--text-sm)] transition disabled:cursor-not-allowed disabled:opacity-50',
            highlighted || value === option.value
              ? 'bg-[var(--color-primary)]/10 text-[var(--color-foreground)]'
              : 'hover:bg-[var(--color-muted)]'
          )}
          onclick={() => selectOption(option)}
          onmouseenter={() => {
            if (enabledIndex >= 0) {
              highlightedIndex = enabledIndex;
            }
          }}
        >
          <span class="grid gap-0.5">
            <span class="font-medium">{option.label}</span>
            {#if option.hint}
              <span class="text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">{option.hint}</span>
            {/if}
          </span>
          {#if value === option.value}
            <Check class="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" />
          {/if}
        </button>
      {/each}
    </div>
  {/snippet}
</Popover>
