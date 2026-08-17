<script lang="ts">
  /**
   * Design-system card — the single owner of the `.glass-card` pattern.
   */
  let {
    class: className = '',
    hover = true,
    children,
    ...rest
  }: {
    class?: string;
    hover?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();
</script>

<div class="ds-card {hover ? 'ds-card--hover' : ''} {className}" {...rest}>
  {@render children?.()}
</div>

<style>
  .ds-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease);
  }
  .ds-card--hover:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-hover);
  }
</style>
