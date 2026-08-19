<script lang="ts">
  /**
   * Design-system text input — the single owner of the bare
   * `input[type=...]` / `textarea` / `select` form-control styles.
   *
   * `value` is declared explicitly (rather than left to `...rest`) and
   * marked `$bindable()` — Svelte 5 does not forward `bind:value` through a
   * rest-spread onto an inner element, so callers using `bind:value` would
   * silently lose two-way binding without this.
   *
   * `showPasswordToggle` / `error` / `prefix` / `suffix` are extracted so they
   * never leak onto the native control. The wrap + toggle only appear when
   * those extras are used; the default remains a bare input.
   */
  let {
    class: className = '',
    type = 'text',
    value = $bindable(),
    children,
    error = false,
    showPasswordToggle = false,
    prefix,
    suffix,
    ...rest
  }: {
    class?: string;
    type?: string;
    value?: any;
    children?: import('svelte').Snippet;
    error?: boolean;
    showPasswordToggle?: boolean;
    prefix?: import('svelte').Snippet;
    suffix?: import('svelte').Snippet;
    [key: string]: any;
  } = $props();

  let isVisible = $state(false);
  const currentType = $derived(type === 'password' && isVisible ? 'text' : type);
  const wrapped = $derived(
    Boolean(prefix || suffix || (type === 'password' && showPasswordToggle))
  );
</script>

{#if type === 'textarea'}
  <textarea class="ds-input {error ? 'ds-input--error' : ''} {className}" bind:value {...rest}></textarea>
{:else if type === 'select'}
  <select class="ds-input ds-input--select {error ? 'ds-input--error' : ''} {className}" bind:value {...rest}>
    {@render children?.()}
  </select>
{:else if wrapped}
  <div class="ds-input-wrap">
    {#if prefix}
      <span class="ds-input-affix ds-input-affix--prefix">{@render prefix()}</span>
    {/if}
    <input
      type={currentType}
      class="ds-input {error ? 'ds-input--error' : ''} {prefix ? 'ds-input--has-prefix' : ''} {(type === 'password' && showPasswordToggle) || suffix
        ? 'ds-input--has-suffix'
        : ''} {className}"
      bind:value
      {...rest}
    />
    {#if suffix && !(type === 'password' && showPasswordToggle)}
      <span class="ds-input-affix ds-input-affix--suffix">{@render suffix()}</span>
    {/if}
    {#if type === 'password' && showPasswordToggle}
      <button
        type="button"
        class="ds-input-toggle"
        onclick={() => (isVisible = !isVisible)}
        aria-label={isVisible ? 'Hide password' : 'Show password'}
        title={isVisible ? 'Hide password' : 'Show password'}
      >
        {isVisible ? 'Hide' : 'Show'}
      </button>
    {/if}
  </div>
{:else}
  <input {type} class="ds-input {error ? 'ds-input--error' : ''} {className}" bind:value {...rest} />
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
  .ds-input--error {
    border-color: var(--danger);
  }
  .ds-input--error:focus {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-glow);
  }
  .ds-input-wrap {
    position: relative;
    width: 100%;
  }
  .ds-input--has-prefix {
    padding-left: 2.25rem;
  }
  .ds-input--has-suffix {
    padding-right: 3.25rem;
  }
  .ds-input-affix {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }
  .ds-input-affix--prefix {
    left: 12px;
  }
  .ds-input-affix--suffix {
    right: 12px;
  }
  .ds-input-toggle {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    padding: 0;
  }
  .ds-input-toggle:hover,
  .ds-input-toggle:focus-visible {
    color: var(--text-primary);
    outline: none;
  }
</style>
