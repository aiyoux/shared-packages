<script lang="ts">
  import { cn } from './utils.ts';
  import type { SegmentedControlOption } from './segmented-control.ts';

  let {
    value = $bindable<string | number>(),
    options = [],
    ariaLabel,
    class: className = '',
    optionClass = '',
    fullWidth = false,
    onValueChange
  }: {
    value?: string | number;
    options?: readonly SegmentedControlOption<string | number>[];
    ariaLabel?: string;
    class?: string;
    optionClass?: string;
    fullWidth?: boolean;
    onValueChange?: (value: string | number) => void;
  } = $props();

  function selectOption(nextValue: string | number, disabled = false) {
    if (disabled) return;
    value = nextValue;
    onValueChange?.(nextValue);
  }
</script>

<div
  role="radiogroup"
  aria-label={ariaLabel}
  class={cn(
    'inline-flex items-center gap-1 border border-border/25 bg-background p-0.5',
    fullWidth && 'grid w-full auto-cols-fr grid-flow-col',
    className
  )}
  style="border-radius: calc(var(--radius-sm, 6px) + 2px);"
>
  {#each options as option (String(option.value))}
    {@const isSelected = value === option.value}
    {@const buttonClasses = cn(
      'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-45',
      fullWidth && 'min-w-0 w-full',
      isSelected
        ? 'bg-primary/15 text-primary font-semibold'
        : 'text-muted-foreground hover:text-foreground',
      optionClass
    )}

    {#if option.href}
      <a
        href={option.href}
        role="radio"
        aria-checked={isSelected}
        aria-label={option.hideLabel ? option.label : undefined}
        title={option.hideLabel ? option.label : undefined}
        class={buttonClasses}
        onclick={() => selectOption(option.value, option.disabled)}
      >
        {#if option.icon}
          {@const Icon = option.icon}
          <Icon class={option.hideLabel ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
        {/if}
        {#if !option.hideLabel}
          {option.label}
        {/if}
      </a>
    {:else}
      <button
        type="button"
        role="radio"
        aria-checked={isSelected}
        aria-label={option.hideLabel ? option.label : undefined}
        title={option.hideLabel ? option.label : undefined}
        disabled={option.disabled}
        class={buttonClasses}
        onclick={() => selectOption(option.value, option.disabled)}
      >
        {#if option.icon}
          {@const Icon = option.icon}
          <Icon class={option.hideLabel ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
        {/if}
        {#if !option.hideLabel}
          {option.label}
        {/if}
      </button>
    {/if}
  {/each}
</div>
