<script lang="ts">
  /**
   * Design-system form group — the single owner of the `.form-group` /
   * `.checkbox-label` layout pattern. Optional label + hint around children.
   */
  let {
    label,
    hint,
    class: className = '',
    children
  }: {
    label?: string;
    hint?: string;
    class?: string;
    children?: import('svelte').Snippet;
  } = $props();
</script>

<div class="ds-form-group {className}">
  {#if label}<span class="ds-form-group__label">{label}</span>{/if}
  {@render children?.()}
  {#if hint}<p class="ds-form-group__hint">{hint}</p>{/if}
</div>

<style>
  .ds-form-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ds-form-group__label {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
  .ds-form-group__hint {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
</style>
