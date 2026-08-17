<script lang="ts">
  /**
   * Design-system tooltip — the single owner of the terminal `[data-tooltip]`
   * pattern. Wraps content; shows a positioned label on hover/focus.
   */
  type Position = 'top' | 'bottom' | 'left' | 'right';

  let {
    content,
    position = 'top',
    class: className = '',
    children
  }: {
    content: string;
    position?: Position;
    class?: string;
    children?: import('svelte').Snippet;
  } = $props();

  let open = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="ds-tooltip-wrap {className}"
  onmouseenter={() => (open = true)}
  onmouseleave={() => (open = false)}
>
  {@render children?.()}
  {#if open}
    <span class="ds-tooltip ds-tooltip--{position}" role="tooltip">{content}</span>
  {/if}
</span>

<style>
  .ds-tooltip-wrap {
    position: relative;
    display: inline-flex;
  }
  .ds-tooltip {
    position: absolute;
    z-index: 1400;
    width: max-content;
    max-width: min(280px, 70vw);
    padding: 4px 8px;
    background: #090d16;
    color: #f1f5f9;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.3;
    white-space: normal;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.7);
    pointer-events: none;
  }
  .ds-tooltip--top {
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
  }
  .ds-tooltip--bottom {
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
  }
  .ds-tooltip--left {
    right: calc(100% + 6px);
    top: 50%;
    transform: translateY(-50%);
  }
  .ds-tooltip--right {
    left: calc(100% + 6px);
    top: 50%;
    transform: translateY(-50%);
  }
</style>
