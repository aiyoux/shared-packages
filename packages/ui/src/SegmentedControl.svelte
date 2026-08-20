<script lang="ts">
  import '@shared-packages/design-system/segmented.css';
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
    'ds-seg',
    fullWidth && 'grid w-full auto-cols-fr grid-flow-col',
    className
  )}
>
  {#each options as option (String(option.value))}
    {@const isSelected = value === option.value}
    {@const buttonClasses = cn(
      isSelected && 'selected',
      fullWidth && 'min-w-0 w-full',
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
