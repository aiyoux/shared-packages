<script lang="ts">
  /**
   * Design-system button — the single owner of the `.btn*` pattern.
   * Token-driven (var(--accent), var(--surface-*), var(--radius-*)) per §2,
   * plain scoped CSS (no Tailwind dependency) so it works in every consumer.
   * Renders an `<a>` when `href` is set, else a `<button>`.
   */
  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg' | 'icon';

  let {
    type = 'button',
    variant = 'primary',
    size = 'md',
    class: className = '',
    disabled = false,
    loading = false,
    href,
    onclick,
    children,
    ...rest
  }: {
    type?: 'button' | 'submit' | 'reset';
    variant?: Variant;
    size?: Size;
    class?: string;
    disabled?: boolean;
    loading?: boolean;
    href?: string;
    onclick?: (event: MouseEvent) => void;
    children?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();
</script>

{#if href}
  <!-- svelte-ignore a11y_missing_attribute -->
  <a
    {href}
    {onclick}
    {...rest}
    class="ds-btn ds-btn--{variant} ds-btn--{size} {className}"
  >
    {#if loading}<span class="ds-btn__spinner" aria-hidden="true"></span>{/if}
    {@render children?.()}
  </a>
{:else}
  <button
    {type}
    {disabled}
    {onclick}
    {...rest}
    class="ds-btn ds-btn--{variant} ds-btn--{size} {className}"
  >
    {#if loading}<span class="ds-btn__spinner" aria-hidden="true"></span>{/if}
    {@render children?.()}
  </button>
{/if}

<style>
  .ds-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
    user-select: none;
    cursor: pointer;
    border: 1px solid transparent;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .ds-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--surface-ground), 0 0 0 4px var(--accent);
  }
  .ds-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
  }
  .ds-btn:active:not(:disabled) {
    transform: scale(0.985);
  }

  /* sizes */
  .ds-btn--sm {
    height: var(--control-h-sm);
    padding: 0 0.625rem;
    font-size: 11px;
    border-radius: var(--radius-sm);
  }
  .ds-btn--md {
    height: var(--control-h);
    padding: 0 1rem;
    font-size: 12px;
    border-radius: var(--radius-md);
  }
  .ds-btn--lg {
    height: var(--control-h-lg);
    padding: 0 1.25rem;
    font-size: 14px;
    border-radius: var(--radius-md);
  }
  .ds-btn--icon {
    height: var(--control-h);
    width: var(--control-h);
    padding: 0;
    border-radius: var(--radius-md);
  }

  /* variants */
  .ds-btn--primary {
    background: var(--accent);
    color: var(--surface-ground);
  }
  .ds-btn--primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .ds-btn--secondary {
    background: var(--surface-2);
    color: var(--text-primary);
    border-color: var(--line-strong);
  }
  .ds-btn--secondary:hover:not(:disabled) {
    background: var(--surface-3);
  }
  .ds-btn--ghost {
    background: transparent;
    color: var(--text-secondary);
  }
  .ds-btn--ghost:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text-primary);
  }
  .ds-btn--danger {
    background: var(--danger);
    color: #ffffff;
  }
  .ds-btn--danger:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .ds-btn__spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: ds-btn-spin 0.8s linear infinite;
  }
  @keyframes ds-btn-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
