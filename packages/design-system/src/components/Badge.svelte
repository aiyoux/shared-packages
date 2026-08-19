<script lang="ts">
  /**
   * Design-system badge — categorical status/tag chip. Token-driven
   * (var(--accent), var(--success), var(--danger), …), plain scoped CSS.
   */
  type Variant = 'info' | 'success' | 'warn' | 'error' | 'neutral';
  type Size = 'sm' | 'md';

  let {
    variant = 'info',
    size = 'md',
    class: className = '',
    children,
    ...rest
  }: {
    variant?: Variant;
    size?: Size;
    class?: string;
    children?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();
</script>

<span class="ds-badge ds-badge--{variant} ds-badge--{size} {className}" {...rest}>
  {@render children?.()}
</span>

<style>
  .ds-badge {
    display: inline-flex;
    align-items: center;
    font-weight: 500;
    border-radius: var(--radius-full);
    line-height: 1.2;
    white-space: nowrap;
  }
  .ds-badge--sm {
    padding: 0.125rem 0.5rem;
    font-size: 10px;
  }
  .ds-badge--md {
    padding: 0.25rem 0.625rem;
    font-size: var(--text-xsm);
  }
  .ds-badge--info {
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--accent);
  }
  .ds-badge--success {
    background: rgba(var(--success-rgb), 0.15);
    color: var(--success);
  }
  .ds-badge--warn {
    background: var(--warning-bg);
    color: var(--text-primary);
  }
  .ds-badge--error {
    background: rgba(var(--danger-rgb), 0.15);
    color: var(--danger);
  }
  .ds-badge--neutral {
    background: var(--surface-2);
    color: var(--text-muted);
  }
</style>
