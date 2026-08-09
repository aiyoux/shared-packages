<script lang="ts">
  import { cn } from './utils.ts';
  import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';

  let {
    id,
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    class: className = '',
    disabled = false,
    name,
    autocomplete,
    inputmode,
    required = false,
    error = false,
    showPasswordToggle = false,
    prefix,
    suffix,
    onkeydown
  }: {
    id?: string;
    value?: string;
    type?: string;
    placeholder?: string;
    class?: string;
    disabled?: boolean;
    name?: string;
    autocomplete?: any;
    inputmode?: any;
    required?: boolean;
    error?: boolean;
    showPasswordToggle?: boolean;
    prefix?: import('svelte').Snippet;
    suffix?: import('svelte').Snippet;
    onkeydown?: (event: KeyboardEvent) => void;
  } = $props();

  let isVisible = $state(false);
  const currentType = $derived(type === 'password' && isVisible ? 'text' : type);
</script>

<div class="relative w-full">
  {#if prefix}
    <div class="pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-[var(--color-muted-foreground)]">
      {@render prefix()}
    </div>
  {/if}
  <input
    {id}
    bind:value
    type={currentType}
    {placeholder}
    {disabled}
    {name}
    {autocomplete}
    {inputmode}
    {required}
    {onkeydown}
    class={cn(
      'flex h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-foreground)] shadow-sm transition placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50',
      error && 'border-[var(--color-destructive)] focus-visible:ring-[var(--color-destructive)]',
      prefix && 'pl-10',
      (type === 'password' && showPasswordToggle) || suffix ? 'pr-10' : '',
      className
    )}
  />
  {#if suffix && !(type === 'password' && showPasswordToggle)}
    <div class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)]">
      {@render suffix()}
    </div>
  {/if}
  {#if type === 'password' && showPasswordToggle}
    <button
      type="button"
      class="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      onclick={() => (isVisible = !isVisible)}
      aria-label={isVisible ? 'Hide password' : 'Show password'}
      title={isVisible ? 'Hide password' : 'Show password'}
    >
      {#if isVisible}
        <EyeOff class="size-4" />
      {:else}
        <Eye class="size-4" />
      {/if}
    </button>
  {/if}
</div>
