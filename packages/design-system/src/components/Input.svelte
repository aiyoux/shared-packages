<script lang="ts">
  /**
   * Design-system text input — the single owner of the bare
   * `input[type=...]` / `textarea` / `select` form-control styles.
   *
   * `value` is declared explicitly (rather than left to `...rest`) and
   * marked `$bindable()` — Svelte 5 does not forward `bind:value` through a
   * rest-spread onto an inner element, so callers using `bind:value` would
   * silently lose two-way binding without this.
   */
  let {
    class: className = '',
    type = 'text',
    value = $bindable(),
    children,
    ...rest
  }: {
    class?: string;
    type?: string;
    value?: any;
    children?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();
</script>

{#if type === 'textarea'}
  <textarea class="ds-input {className}" bind:value {...rest}></textarea>
{:else if type === 'select'}
  <select class="ds-input ds-input--select {className}" bind:value {...rest}>
    {@render children?.()}
  </select>
{:else}
  <input {type} class="ds-input {className}" bind:value {...rest} />
{/if}

<style>
  .ds-input {
    width: 100%;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.9rem;
    padding: 8px 12px;
    transition:
      border-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease);
  }
  .ds-input::placeholder {
    color: var(--text-muted);
  }
  .ds-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
    background: var(--bg-secondary);
  }
  .ds-input--select {
    appearance: auto;
  }
</style>
