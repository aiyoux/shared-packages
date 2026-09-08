<script lang="ts">
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import { portal } from './portal.ts';

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

  const popoverGenerationAttr = 'data-popover-generation';
  let generationCounter = 0;
  const openStack: number[] = [];

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
  let panelElement = $state<HTMLDivElement | null>(null);
  let mounted = $state(false);
  let panelPosition = $state({ top: 0, left: 0, visibility: 'hidden' as 'hidden' | 'visible' });
  let lastFocusedElement = $state<HTMLElement | null>(null);
  let generation = $state<number | null>(null);

  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function bindTrigger(node: HTMLElement) {
    triggerElement = node;
    return {
      destroy() {
        if (triggerElement === node) {
          triggerElement = null;
        }
      }
    };
  }

  function closePopover() {
    if (!open) return;
    open = false;
    onClose?.();
  }

  function registerOpenPopover() {
    const nextGeneration = ++generationCounter;
    generation = nextGeneration;
    openStack.push(nextGeneration);
  }

  function unregisterOpenPopover() {
    if (generation === null) return;
    const index = openStack.indexOf(generation);
    if (index >= 0) {
      openStack.splice(index, 1);
    }
    generation = null;
  }

  function topOpenGeneration() {
    return openStack.at(-1) ?? null;
  }

  function generationForTarget(target: Node) {
    if (!(target instanceof Element)) return null;
    const popup = target.closest(`[${popoverGenerationAttr}]`);
    const raw = popup?.getAttribute(popoverGenerationAttr);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getFocusableElements() {
    if (!panelElement) return [] as HTMLElement[];
    return Array.from(panelElement.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden')
    );
  }

  function focusPanel() {
    if (!focusOnOpen) return;
    const focusable = getFocusableElements();
    (focusable[0] ?? panelElement)?.focus();
  }

  function computePlacement(rect: DOMRect, panelRect: DOMRect) {
    const margin = viewportMargin;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (mobileMode === 'center' && viewportWidth <= mobileBreakpoint) {
      return {
        top: Math.max(margin, (viewportHeight - panelRect.height) / 2),
        left: Math.max(margin, (viewportWidth - panelRect.width) / 2),
        visibility: 'visible' as const
      };
    }

    const placements: Placement[] =
      placement.startsWith('bottom')
        ? [
            placement,
            placement === 'bottom-start'
              ? 'top-start'
              : placement === 'bottom-end'
                ? 'top-end'
                : 'top-center',
            'right',
            'left'
          ]
        : placement.startsWith('top')
          ? [
              placement,
              placement === 'top-start'
                ? 'bottom-start'
                : placement === 'top-end'
                  ? 'bottom-end'
                  : 'bottom-center',
              'right',
              'left'
            ]
          : placement === 'left'
            ? ['left', 'right', 'bottom-start', 'top-start']
            : ['right', 'left', 'bottom-end', 'top-end'];

    for (const candidate of placements) {
      let top = 0;
      let left = 0;

      if (candidate === 'bottom-start') {
        top = rect.bottom + offset;
        left = rect.left;
      } else if (candidate === 'bottom-center') {
        top = rect.bottom + offset;
        left = rect.left + rect.width / 2 - panelRect.width / 2;
      } else if (candidate === 'bottom-end') {
        top = rect.bottom + offset;
        left = rect.right - panelRect.width;
      } else if (candidate === 'top-start') {
        top = rect.top - panelRect.height - offset;
        left = rect.left;
      } else if (candidate === 'top-center') {
        top = rect.top - panelRect.height - offset;
        left = rect.left + rect.width / 2 - panelRect.width / 2;
      } else if (candidate === 'top-end') {
        top = rect.top - panelRect.height - offset;
        left = rect.right - panelRect.width;
      } else if (candidate === 'left') {
        top = rect.top + rect.height / 2 - panelRect.height / 2;
        left = rect.left - panelRect.width - offset;
      } else {
        top = rect.top + rect.height / 2 - panelRect.height / 2;
        left = rect.right + offset;
      }

      const fitsVertically = top >= margin && top + panelRect.height <= viewportHeight - margin;
      const fitsHorizontally = left >= margin && left + panelRect.width <= viewportWidth - margin;

      if (fitsVertically && fitsHorizontally) {
        return {
          top,
          left,
          visibility: 'visible' as const
        };
      }
    }

    let fallbackTop = rect.bottom + offset;
    let fallbackLeft = rect.left;

    if (placement === 'bottom-center' || placement === 'top-center') {
      fallbackLeft = rect.left + rect.width / 2 - panelRect.width / 2;
    }
    if (placement === 'bottom-end' || placement === 'top-end') {
      fallbackLeft = rect.right - panelRect.width;
    }
    if (placement === 'top-start' || placement === 'top-center' || placement === 'top-end') {
      fallbackTop = rect.top - panelRect.height - offset;
    }
    if (placement === 'left') {
      fallbackTop = rect.top + rect.height / 2 - panelRect.height / 2;
      fallbackLeft = rect.left - panelRect.width - offset;
    }
    if (placement === 'right') {
      fallbackTop = rect.top + rect.height / 2 - panelRect.height / 2;
      fallbackLeft = rect.right + offset;
    }

    return {
      top: Math.min(Math.max(margin, fallbackTop), viewportHeight - panelRect.height - margin),
      left: Math.min(Math.max(margin, fallbackLeft), viewportWidth - panelRect.width - margin),
      visibility: 'visible' as const
    };
  }

  function updatePosition() {
    if (!open || !triggerElement || !panelElement || typeof window === 'undefined') return;
    const triggerRect = triggerElement.getBoundingClientRect();
    const panelRect = panelElement.getBoundingClientRect();
    panelPosition = computePlacement(triggerRect, panelRect);
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!open || !closeOnOutside) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (triggerElement?.contains(target) || panelElement?.contains(target)) return;

    const clickedGeneration = generationForTarget(target);
    if (clickedGeneration !== null && generation !== null) {
      if (clickedGeneration >= generation) return;
    }

    closePopover();
  }

  function handleDocumentKeyDown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape' && closeOnEscape) {
      if (generation !== topOpenGeneration()) return;
      event.preventDefault();
      closePopover();
      return;
    }

    if (!trapFocus || event.key !== 'Tab' || !panelElement) return;
    if (generation !== topOpenGeneration()) return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      panelElement.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (typeof window === 'undefined' || !open) return;

    mounted = true;
    registerOpenPopover();
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onReposition = () => updatePosition();
    const onScroll = (event: Event) => {
      const target = event.target;
      // Scroll inside the panel (date-grid recenter, month list, etc.) must
      // not re-anchor the popup — that jumps the whole calendar under the pointer.
      if (target instanceof Node && panelElement?.contains(target)) return;
      updatePosition();
    };
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onScroll, true);

    tick().then(() => {
      updatePosition();
      focusPanel();
    });

    return () => {
      mounted = false;
      panelPosition = { top: 0, left: 0, visibility: 'hidden' };
      unregisterOpenPopover();
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onScroll, true);
      if (restoreFocus) {
        lastFocusedElement?.focus();
      }
    };
  });
</script>

{#if trigger}
  {@render trigger({ ref: bindTrigger })}
{/if}

{#if open && mounted}
  <div
    use:portal
    bind:this={panelElement}
    tabindex="-1"
    data-popover-generation={generation}
    class={`pointer-events-auto fixed [z-index:var(--z-popover)] ${contentClass}`}
    style={`top: ${panelPosition.top}px; left: ${panelPosition.left}px; visibility: ${panelPosition.visibility}; ${contentStyle}`}
  >
    {#if content}
      {@render content()}
    {/if}
  </div>
{/if}
