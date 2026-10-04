<script lang="ts">
  import type { Snippet } from 'svelte';
  import { anchoredPopup } from '@shared-packages/design-system';

  type Placement =
    | 'top-start'
    | 'top-center'
    | 'top-end'
    | 'bottom-start'
    | 'bottom-center'
    | 'bottom-end'
    | 'left'
    | 'right';
  type MobileMode = 'popover' | 'center';
  type TriggerSnippetProps = {
    ref: (node: HTMLElement) => { destroy(): void };
  };

  let {
    open = $bindable(false),
    onClose,
    placement = 'bottom-start',
    offset = 8,
    viewportMargin = 12,
    mobileMode = 'popover',
    mobileBreakpoint = 720,
    closeOnOutside = true,
    closeOnEscape = true,
    trapFocus = true,
    focusOnOpen = true,
    restoreFocus = true,
    contentClass = '',
    contentStyle = '',
    trigger,
    content
  }: {
    open?: boolean;
    onClose?: () => void;
    placement?: Placement;
    offset?: number;
    viewportMargin?: number;
    mobileMode?: MobileMode;
    mobileBreakpoint?: number;
    closeOnOutside?: boolean;
    closeOnEscape?: boolean;
    trapFocus?: boolean;
    focusOnOpen?: boolean;
    restoreFocus?: boolean;
    contentClass?: string;
    contentStyle?: string;
    trigger?: Snippet<[TriggerSnippetProps]>;
    content?: Snippet;
  } = $props();

  let triggerElement = $state<HTMLElement | null>(null);
  function bindTrigger(node: HTMLElement) {
    triggerElement = node;
    return { destroy() { if (triggerElement === node) triggerElement = null; } };
  }
  function closePopover() { if (open) { open = false; onClose?.(); } }
</script>

{#if trigger}
  {@render trigger({ ref: bindTrigger })}
{/if}

{#if open}
  <div
    use:anchoredPopup={{ portal: true, anchor: () => triggerElement, onClose: closePopover, placement, offset, viewportMargin, mobileMode, mobileBreakpoint, closeOnOutside, closeOnEscape, trapFocus, focusOnOpen, restoreFocus }}
    tabindex="-1"
    class={`pointer-events-auto fixed ${contentClass}`}
    style={contentStyle}
  >
    {#if content}
      {@render content()}
    {/if}
  </div>
{/if}
