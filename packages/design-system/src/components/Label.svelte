<script lang="ts">
  /**
   * Design-system label — token-driven form label. Optional `for` association
   * and required marker. Plain scoped CSS so it works in every consumer.
   */
  let {
    for: htmlFor,
    class: className = '',
    required = false,
    children
  }: {
    for?: string;
    class?: string;
    required?: boolean;
    children?: import('svelte').Snippet;
  } = $props();
</script>

<label for={htmlFor} class="ds-label {className}">
  {@render children?.()}
  {#if required}<span class="ds-label__req" aria-hidden="true">*</span>{/if}
</label>

<style>
  .ds-label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .ds-label__req {
    margin-left: 0.25rem;
    color: var(--danger);
  }
</style>
