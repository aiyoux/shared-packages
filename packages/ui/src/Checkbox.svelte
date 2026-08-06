<script lang="ts">
  import { Ban, Check, Minus } from '@lucide/svelte';
  import { cn } from './utils.ts';
  import {
    CHECKBOX_STATE_LABELS,
    DEFAULT_CHECKBOX_CYCLE,
    checkboxAriaChecked,
    checkboxStateFromBoolean,
    nextCheckboxState,
    type CheckboxState
  } from './checkbox.ts';

  let {
    checked = $bindable(false),
    indeterminate = $bindable(false),
    /**
     * Multi-state value (progress-aligned). When set, takes precedence over
     * `checked` / `indeterminate` for display and click cycling.
     *
     * Named `checkState` (not `state`) so it never collides with Svelte's
     * `$state` rune / legacy `$store` auto-subscription syntax.
     */
    checkState = $bindable(undefined as CheckboxState | undefined),
    /**
     * Order used when the control is clicked in multi-state mode.
     * Default: False ↔ True. Pass FULL_CHECKBOX_CYCLE for all five states.
     */
    cycle = DEFAULT_CHECKBOX_CYCLE as readonly CheckboxState[],
    disabled = false,
    size = 'md' as 'sm' | 'md',
    class: className = '',
    boxClass = '',
    labelClass = '',
    hint = '',
    title = '',
    children,
    onchange,
    onStateChange
  }: {
    checked?: boolean;
    indeterminate?: boolean;
    checkState?: CheckboxState | undefined;
    cycle?: readonly CheckboxState[];
    disabled?: boolean;
    size?: 'sm' | 'md';
    class?: string;
    /** Extra classes on the visual box. */
    boxClass?: string;
    labelClass?: string;
    hint?: string;
    title?: string;
    children?: import('svelte').Snippet;
    /** Binary callback — true only when the resolved state is `True`. */
    onchange?: (checked: boolean) => void;
    /** Fires on every state change (multi-state or binary). */
    onStateChange?: (next: CheckboxState) => void;
  } = $props();

  let inputRef = $state<HTMLInputElement | null>(null);

  const multiState = $derived(checkState !== undefined);
  const resolved = $derived(
    multiState ? (checkState as CheckboxState) : checkboxStateFromBoolean(checked, indeterminate)
  );
  const ariaChecked = $derived(checkboxAriaChecked(resolved));
  const resolvedTitle = $derived(title || CHECKBOX_STATE_LABELS[resolved]);
  // Slightly lighter strokes read cleaner at small sizes than Lucide defaults.
  const stroke = $derived(size === 'sm' ? 2.4 : 2.35);

  // Keep native input in sync for binary mode (form / a11y).
  $effect(() => {
    if (!inputRef || multiState) return;
    inputRef.indeterminate = indeterminate;
  });

  function applyState(next: CheckboxState) {
    if (multiState) {
      checkState = next;
    } else {
      checked = next === 'True';
      indeterminate = next === 'Partial';
    }
    onStateChange?.(next);
    onchange?.(next === 'True');
  }

  function handleChange(e: Event) {
    if (disabled || multiState) return;
    const target = e.target as HTMLInputElement;
    const next: CheckboxState = target.checked ? 'True' : 'False';
    applyState(next);
  }

  function handleActivate(e: MouseEvent | KeyboardEvent) {
    if (disabled) return;
    if (!multiState) return; // native input handles binary
    e.preventDefault();
    e.stopPropagation();
    applyState(nextCheckboxState(resolved, cycle));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!multiState || disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      handleActivate(e);
    }
  }
</script>

<label
  class={cn(
    'ui-checkbox group inline-flex items-start gap-2.5 select-none',
    size === 'sm' && 'ui-checkbox--sm',
    size === 'md' && 'ui-checkbox--md',
    disabled ? 'ui-checkbox--disabled cursor-not-allowed' : 'cursor-pointer',
    className
  )}
  title={resolvedTitle}
  data-checkbox-state={resolved}
>
  {#if multiState}
    <button
      type="button"
      role="checkbox"
      aria-checked={ariaChecked}
      aria-label={resolvedTitle}
      data-state={resolved}
      {disabled}
      {title}
      onclick={handleActivate}
      onkeydown={handleKeydown}
      class={cn('ui-checkbox__box', boxClass)}
    >
      <span class="ui-checkbox__icon" class:ui-checkbox__icon--on={resolved !== 'False'} aria-hidden="true">
        {#if resolved === 'True'}
          <Check strokeWidth={stroke} />
        {:else if resolved === 'Partial'}
          <Minus strokeWidth={stroke} />
        {:else if resolved === 'NA'}
          <Minus strokeWidth={stroke} />
        {:else if resolved === 'WontDo'}
          <Ban strokeWidth={stroke} />
        {/if}
      </span>
    </button>
  {:else}
    <input
      bind:this={inputRef}
      type="checkbox"
      {checked}
      {disabled}
      onchange={handleChange}
      class="ui-checkbox__input peer sr-only"
    />
    <span
      aria-hidden="true"
      data-state={resolved}
      class={cn('ui-checkbox__box peer-focus-visible:ui-checkbox__box--focus', boxClass)}
    >
      <span class="ui-checkbox__icon" class:ui-checkbox__icon--on={resolved !== 'False'}>
        {#if resolved === 'Partial'}
          <Minus strokeWidth={stroke} />
        {:else}
          <Check strokeWidth={stroke} />
        {/if}
      </span>
    </span>
  {/if}

  {#if children || hint}
    <span class={cn('ui-checkbox__label grid gap-0.5', labelClass)}>
      {#if children}
        <span class="font-medium leading-snug text-[var(--color-foreground)]">
          {@render children()}
        </span>
      {/if}
      {#if hint}
        <span class="text-[var(--text-xsm)] leading-snug text-[var(--color-muted-foreground)]">{hint}</span>
      {/if}
    </span>
  {/if}
</label>

<style>
  /*
   * Flat style — solid fills, 1px border, no gradients / inset / elevation.
   * Tuned for tree rows (sm) and form labels (md).
   */
  .ui-checkbox {
    --cb-size: 1.125rem;
    --cb-radius: calc(var(--radius-xs, 0.35rem) - 0.05rem);
    --cb-icon: 0.72rem;
    --cb-ring: color-mix(in srgb, var(--color-primary, #3b82f6) 45%, transparent);
  }

  .ui-checkbox--sm {
    --cb-size: 0.95rem;
    --cb-radius: 0.28rem;
    --cb-icon: 0.62rem;
  }

  .ui-checkbox--md {
    --cb-size: 1.125rem;
    --cb-icon: 0.72rem;
  }

  .ui-checkbox--disabled {
    opacity: 0.5;
  }

  .ui-checkbox--disabled .ui-checkbox__box {
    cursor: not-allowed;
  }

  .ui-checkbox__box {
    box-sizing: border-box;
    position: relative;
    margin-top: 0.1rem;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: var(--cb-size);
    height: var(--cb-size);
    padding: 0;
    border: 1.5px solid color-mix(in srgb, var(--color-muted-foreground, #64748b) 40%, transparent);
    border-radius: var(--cb-radius);
    background: transparent;
    color: transparent;
    box-shadow: none;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      color 0.12s ease;
  }

  button.ui-checkbox__box {
    appearance: none;
    font: inherit;
    cursor: inherit;
  }

  button.ui-checkbox__box:focus-visible,
  :global(.peer:focus-visible) + .ui-checkbox__box,
  .ui-checkbox__box--focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
    box-shadow:
      0 0 0 2px var(--color-background, #fff),
      0 0 0 3.5px var(--cb-ring);
  }

  .ui-checkbox:not(.ui-checkbox--disabled):hover .ui-checkbox__box[data-state='False'] {
    border-color: color-mix(in srgb, var(--color-primary, #3b82f6) 55%, transparent);
    background: color-mix(in srgb, var(--color-primary, #3b82f6) 8%, transparent);
  }

  .ui-checkbox:not(.ui-checkbox--disabled) .ui-checkbox__box:active {
    opacity: 0.85;
  }

  /* —— Done —— solid success, flat */
  .ui-checkbox__box[data-state='True'] {
    border-color: var(--color-success, #22c55e);
    background: var(--color-success, #22c55e);
    color: #fff;
    box-shadow: none;
  }

  .ui-checkbox:not(.ui-checkbox--disabled):hover .ui-checkbox__box[data-state='True'] {
    border-color: color-mix(in srgb, var(--color-success, #22c55e) 88%, #000);
    background: color-mix(in srgb, var(--color-success, #22c55e) 88%, #000);
  }

  /* —— Partial —— flat tint + dash */
  .ui-checkbox__box[data-state='Partial'] {
    border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 65%, transparent);
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 18%, transparent);
    color: color-mix(in srgb, var(--color-warning, #d97706) 92%, #422006);
    box-shadow: none;
  }

  .ui-checkbox:not(.ui-checkbox--disabled):hover .ui-checkbox__box[data-state='Partial'] {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 26%, transparent);
    border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 78%, transparent);
  }

  /* —— NA —— flat brand tint + dash */
  .ui-checkbox__box[data-state='NA'] {
    border-color: color-mix(in srgb, var(--color-primary, #3b82f6) 55%, transparent);
    background: color-mix(in srgb, var(--color-primary, #3b82f6) 12%, transparent);
    color: var(--color-primary, #2563eb);
    box-shadow: none;
  }

  .ui-checkbox:not(.ui-checkbox--disabled):hover .ui-checkbox__box[data-state='NA'] {
    background: color-mix(in srgb, var(--color-primary, #3b82f6) 18%, transparent);
    border-color: color-mix(in srgb, var(--color-primary, #3b82f6) 70%, transparent);
  }

  /* —— Won't do —— flat amber + ban */
  .ui-checkbox__box[data-state='WontDo'] {
    border-color: color-mix(in srgb, #b45309 50%, transparent);
    background: color-mix(in srgb, #b45309 12%, transparent);
    color: #a16207;
    box-shadow: none;
  }

  .ui-checkbox:not(.ui-checkbox--disabled):hover .ui-checkbox__box[data-state='WontDo'] {
    background: color-mix(in srgb, #b45309 18%, transparent);
    border-color: color-mix(in srgb, #b45309 62%, transparent);
    color: #92400e;
  }

  .ui-checkbox__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--cb-icon);
    height: var(--cb-icon);
    opacity: 0;
    transform: scale(0.6);
    transition:
      opacity 0.12s ease,
      transform 0.12s ease;
    margin-top: 0.5px;
  }

  .ui-checkbox__icon--on {
    opacity: 1;
    transform: scale(1);
  }

  .ui-checkbox__icon :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ui-checkbox__label {
    padding-top: 0.02rem;
  }
</style>
