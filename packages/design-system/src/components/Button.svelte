<script lang="ts">
  // Appearance lives in ../button.css so non-button elements (file-input
  // <label>s, pill <span>s) can share it without forking a copy. Imported
  // here so it ships with the component for every existing caller.
  import '../button.css';

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

