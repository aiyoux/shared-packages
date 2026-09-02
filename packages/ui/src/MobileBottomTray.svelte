<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import ResizableSidePanel from './ResizableSidePanel.svelte';
  import { cn } from './utils.ts';

  let {
    heightPx = $bindable(320),
    collapsed = $bindable(true),
    isResizing = $bindable(false),
    storageKey,
    minPx = 160,
    maxPx = 9999,
    defaultPx = 320,
    maxViewportRatio = 0.95,
    ariaLabel = 'Resize bottom tray',
    collapsedPeekSelector = '[data-mobile-bottom-tray-peek]',
    collapsedFallbackPx = 32,
    class: className = '',
    trayClass = '',
    panelClass = '',
    handleClass = '',
    children
  }: {
    heightPx?: number;
    collapsed?: boolean;
    isResizing?: boolean;
    storageKey?: string;
    minPx?: number;
    maxPx?: number;
    defaultPx?: number;
    maxViewportRatio?: number;
    ariaLabel?: string;
    collapsedPeekSelector?: string;
    collapsedFallbackPx?: number;
    class?: string;
    trayClass?: string;
    panelClass?: string;
    handleClass?: string;
    children?: Snippet;
  } = $props();

  const browser = typeof window !== 'undefined';

  let trayRef = $state<HTMLDivElement | null>(null);
  let measuredPeekHeight = $state(0);
  let dragPointerId = $state<number | null>(null);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragStartOffset = $state(0);
  let dragStartHeight = $state(0);
  let manualOffset = $state<number | null>(null);
  let trayHeight = $state(0);
  let dragEndRaf = $state<number | null>(null);
  let dragLastY = $state(0);
  let dragLastTime = $state(0);
  let dragStartTime = $state(0);
  let dragVelocityY = $state(0);
  let dragClickTarget = $state<HTMLElement | null>(null);
  let suppressTransition = $state(false);
  let suppressToggleClick = $state(false);
  let lastCollapsed = $state(collapsed);

  let dragSamples = $state<Array<{ x: number; y: number; time: number }>>([]);

  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let observedPeekEl: HTMLElement | null = null;

  const defaultHandleClass =
    "cursor-row-resize relative z-[var(--z-raised)] flex items-center justify-center before:absolute before:inset-x-0 before:-top-5 before:-bottom-5 before:content-['']";
  const quickSwipeRecentWindowMs = 140;
  const quickSwipeVerticalBias = 1.2;
  const quickSwipeOpen = {
    minDistancePx: 72,
    primaryDistancePx: 128,
    recentDistancePx: 112,
    maxDurationMs: 260,
    minAverageVelocity: 0.85,
    minConfirmRecentVelocity: 0.45,
    minRecentVelocity: 1.2
  };
  const quickSwipeOpenFromCollapsed = {
    minDistancePx: 64,
    primaryDistancePx: 120,
    recentDistancePx: 64,
    maxDurationMs: 340,
    minAverageVelocity: 0.7,
    minConfirmRecentVelocity: 0,
    minRecentVelocity: 0.9
  };
  const quickSwipeClose = {
    minDistancePx: 48,
    primaryDistancePx: 72,
    recentDistancePx: 48,
    maxDurationMs: 420,
    minAverageVelocity: 0.55,
    minConfirmRecentVelocity: 0,
    minRecentVelocity: 0.8
  };

  const activeHandleClass = $derived(handleClass || defaultHandleClass);
  const collapsedVisiblePx = $derived(Math.max(0, measuredPeekHeight || collapsedFallbackPx));
  const activeVisibleHeight = $derived(
    manualOffset !== null ? Math.max(collapsedVisiblePx, trayHeight - manualOffset) : collapsed ? collapsedVisiblePx : heightPx
  );
  const openAttemptThresholdPx = $derived(
    Math.max(collapsedVisiblePx + 24, Math.min(minPx, maximumOpenHeight()) - 100)
  );
  const isOpenBackdropVisible = $derived(
    !collapsed || (dragPointerId !== null && activeVisibleHeight >= openAttemptThresholdPx)
  );
  const transformStyle = $derived(
    manualOffset !== null
      ? `${manualOffset}px`
      : collapsed
        ? `calc(100% - ${collapsedVisiblePx}px)`
        : '0'
  );

  function clampHeight(value: number): number {
    if (!Number.isFinite(value)) return defaultPx;
    const viewportMax =
      browser && typeof window !== 'undefined'
        ? Math.max(minPx, Math.floor(window.innerHeight * maxViewportRatio))
        : maxPx;
    return Math.min(Math.min(maxPx, viewportMax), Math.max(minPx, Math.round(value)));
  }

  function maximumOpenHeight(): number {
    return clampHeight(maxPx);
  }

  function measurePeek() {
    const tray = trayRef;
    if (!tray) {
      measuredPeekHeight = collapsedFallbackPx;
      return;
    }

    trayHeight = tray.getBoundingClientRect().height;

    const peekEl = tray.querySelector(collapsedPeekSelector) as HTMLElement | null;
    if (resizeObserver && observedPeekEl !== peekEl) {
      if (observedPeekEl) resizeObserver.unobserve(observedPeekEl);
      if (peekEl) resizeObserver.observe(peekEl);
      observedPeekEl = peekEl;
    }

    if (!peekEl) {
      measuredPeekHeight = collapsedFallbackPx;
      return;
    }

    const trayRect = tray.getBoundingClientRect();
    const peekRect = peekEl.getBoundingClientRect();
    measuredPeekHeight = Math.max(
      collapsedFallbackPx,
      Math.ceil(peekRect.bottom - trayRect.top)
    );
  }

  function openTray() {
    manualOffset = null;
    heightPx = clampHeight(heightPx || defaultPx);
    collapsed = false;
  }

  function closeTray() {
    manualOffset = null;
    collapsed = true;
  }

  function toggleTray() {
    manualOffset = null;
    if (collapsed) {
      openTray();
    } else {
      closeTray();
    }
  }

  function handleToggleClick() {
    if (suppressToggleClick) {
      suppressToggleClick = false;
      return;
    }
    toggleTray();
  }

  function shouldIgnoreDrag(event: PointerEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-mobile-bottom-tray-toggle]')) return false;

    // Peek is a drag handle, but interactive controls inside it must keep
    // their native click. Capturing the pointer and replaying `click()` on
    // tap double-fires handlers (calendar "Add Event" opened two New Event
    // tabs per press). Same ignore list as the rest of the tray.
    return Boolean(
      target?.closest(
        'button, a, input, textarea, select, [contenteditable="true"], [data-mobile-bottom-tray-ignore-drag]'
      )
    );
  }

  function recordDragSample(event: PointerEvent, time = Date.now()) {
    dragSamples = [...dragSamples.slice(-8), { x: event.clientX, y: event.clientY, time }];
  }

  function isQuickVerticalSwipe(
    event: PointerEvent,
    direction: 'up' | 'down',
    options: typeof quickSwipeOpen,
    time = Date.now()
  ) {
    const totalDx = event.clientX - dragStartX;
    const totalDy = event.clientY - dragStartY;
    const signedDistance = direction === 'down' ? totalDy : -totalDy;
    const verticalDistance = Math.abs(totalDy);
    const horizontalDistance = Math.abs(totalDx);

    if (signedDistance < options.minDistancePx) return false;
    if (verticalDistance < horizontalDistance * quickSwipeVerticalBias) return false;

    const elapsed = Math.max(1, time - dragStartTime);
    if (elapsed > options.maxDurationMs) return false;

    const averageVelocity = signedDistance / elapsed;
    let recentVelocity = 0;
    for (let index = dragSamples.length - 1; index >= 0; index -= 1) {
      const sample = dragSamples[index];
      const sampleAge = time - sample.time;
      if (sampleAge < 24) continue;
      if (sampleAge > quickSwipeRecentWindowMs && recentVelocity !== 0) break;

      const sampleDistance = direction === 'down' ? event.clientY - sample.y : sample.y - event.clientY;
      recentVelocity = sampleDistance / Math.max(1, sampleAge);
      if (sampleAge <= quickSwipeRecentWindowMs) break;
    }

    return (
      (signedDistance >= options.primaryDistancePx &&
        averageVelocity >= options.minAverageVelocity &&
        recentVelocity >= options.minConfirmRecentVelocity) ||
      (signedDistance >= options.recentDistancePx && recentVelocity >= options.minRecentVelocity)
    );
  }

  function onTrayPointerDown(event: PointerEvent) {
    if (shouldIgnoreDrag(event)) return;
    if (dragEndRaf !== null) {
      cancelAnimationFrame(dragEndRaf);
      dragEndRaf = null;
    }

    // When collapsed, only grab near the bottom edge
    if (collapsed) {
      const visibleGrabArea = Math.max(48, collapsedVisiblePx);
      const distFromBottom = window.innerHeight - event.clientY;
      if (distFromBottom > visibleGrabArea + 16) return;
    }

    event.preventDefault();
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(event.pointerId);
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragLastY = event.clientY;
    dragStartTime = Date.now();
    dragLastTime = dragStartTime;
    dragVelocityY = 0;
    dragSamples = [];
    recordDragSample(event, dragStartTime);
    dragClickTarget = (event.target as HTMLElement | null)?.closest('[data-mobile-bottom-tray-toggle], [data-mobile-bottom-tray-peek] button, [data-mobile-bottom-tray-peek] a') as HTMLElement | null;
    trayHeight = el.getBoundingClientRect().height;
    dragStartHeight = clampHeight(heightPx || defaultPx);
    dragStartOffset = collapsed ? Math.max(trayHeight - collapsedVisiblePx, 0) : 0;
    manualOffset = dragStartOffset;
    isResizing = true;
  }

  function onTrayPointerMove(event: PointerEvent) {
    if (dragPointerId === null || event.pointerId !== dragPointerId) return;
    event.preventDefault();

    const now = Date.now();
    const elapsed = Math.max(1, now - dragLastTime);
    dragVelocityY = (event.clientY - dragLastY) / elapsed;
    dragLastY = event.clientY;
    dragLastTime = now;
    recordDragSample(event, now);

    const el = event.currentTarget as HTMLElement;
    const pointerDelta = event.clientY - dragStartY;
    const rawOffset = dragStartOffset + pointerDelta;
    const maxOffset = Math.max(trayHeight - collapsedVisiblePx, 0);
    const nextOffset = Math.max(0, Math.min(maxOffset, rawOffset));
    manualOffset = nextOffset;

    if (rawOffset < 0) {
      heightPx = clampHeight(dragStartHeight - rawOffset);
      trayHeight = el.getBoundingClientRect().height;
    }
  }

  function onTrayPointerUp(event: PointerEvent) {
    if (dragPointerId === null || event.pointerId !== dragPointerId) return;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be gone after browser gesture cancellation.
    }
    isResizing = false;

    const delta = Math.abs(dragStartY - event.clientY);
    if (delta < 5) {
      const clickTarget = dragClickTarget;
      if (dragEndRaf !== null) {
        cancelAnimationFrame(dragEndRaf);
        dragEndRaf = null;
      }
      dragPointerId = null;
      dragClickTarget = null;
      manualOffset = null;
      if (clickTarget?.matches('[data-mobile-bottom-tray-toggle]')) {
        suppressToggleClick = true;
        toggleTray();
        if (browser) window.setTimeout(() => (suppressToggleClick = false), 0);
      } else if (clickTarget) {
        // Replay the captured tap, then swallow the native `click` that
        // still follows pointerup in some browsers even when pointerdown
        // was canceled (same reason as suppressToggleClick).
        clickTarget.click();
        const swallowNativeClick = (e: Event) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          clickTarget.removeEventListener('click', swallowNativeClick, true);
        };
        clickTarget.addEventListener('click', swallowNativeClick, true);
        if (browser) {
          window.setTimeout(() => {
            clickTarget.removeEventListener('click', swallowNativeClick, true);
          }, 0);
        }
      }
      return;
    }

    const currentOffset = manualOffset ?? dragStartOffset;
    const visibleHeight = Math.max(collapsedVisiblePx, trayHeight - currentOffset);
    const now = Date.now();
    recordDragSample(event, now);
    const isQuickSwipeOpen = isQuickVerticalSwipe(
      event,
      'up',
      collapsed ? quickSwipeOpenFromCollapsed : quickSwipeOpen,
      now
    );
    const isQuickSwipeClose = !collapsed && isQuickVerticalSwipe(event, 'down', quickSwipeClose, now);
    const shouldOpen = !isQuickSwipeClose && (visibleHeight >= openAttemptThresholdPx || isQuickSwipeOpen);

    if (isQuickSwipeOpen) {
      const nextHeight = maximumOpenHeight();
      heightPx = nextHeight;
      trayHeight = nextHeight;
      manualOffset = null;
    } else if (isQuickSwipeClose) {
      manualOffset = null;
    } else if (shouldOpen) {
      heightPx = clampHeight(visibleHeight);
      trayHeight = heightPx;
      suppressTransition = true;
      manualOffset = null;
    }

    collapsed = !shouldOpen;

    dragPointerId = null;
    dragClickTarget = null;
    dragSamples = [];
    dragEndRaf = requestAnimationFrame(() => {
      if (suppressTransition) {
        dragEndRaf = requestAnimationFrame(() => {
          suppressTransition = false;
          dragEndRaf = null;
        });
      } else {
        manualOffset = null;
        dragEndRaf = null;
      }
    });
  }

  $effect(() => {
    if (dragPointerId !== null || !browser) return;
    if (isResizing && manualOffset !== null && !collapsed) {
      const visibleHeight = trayHeight - manualOffset;
      heightPx = clampHeight(visibleHeight - 4);
      manualOffset = null;
    }
  });

  $effect(() => {
    if (collapsed === lastCollapsed) return;
    manualOffset = null;
    if (!collapsed) {
      heightPx = clampHeight(heightPx || defaultPx);
    }
    lastCollapsed = collapsed;
  });

  $effect(() => {
    collapsedPeekSelector;
    collapsedFallbackPx;
    void tick().then(measurePeek);
  });

  onMount(() => {
    if (!trayRef) return;

    resizeObserver = new ResizeObserver(() => measurePeek());
    resizeObserver.observe(trayRef);

    mutationObserver = new MutationObserver(() => {
      void tick().then(measurePeek);
    });
    mutationObserver.observe(trayRef, { childList: true, subtree: true });

    void tick().then(measurePeek);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (dragEndRaf !== null) cancelAnimationFrame(dragEndRaf);
    };
  });
</script>

<div class={cn('fixed inset-0 [z-index:var(--z-popover)] pointer-events-none', className)}>
  <button
    type="button"
    class="absolute inset-0 bg-black/40 pointer-events-auto transition-opacity duration-300"
    class:opacity-0={!isOpenBackdropVisible}
    class:pointer-events-none={!isOpenBackdropVisible}
    onclick={closeTray}
    aria-label="Close tray"
  ></button>

  <div
    bind:this={trayRef}
    role="presentation"
    class={cn('absolute inset-x-0 bottom-0 pointer-events-auto bg-panel shadow-xl', trayClass)}
    style={`will-change: transform; touch-action: none; transition: ${dragPointerId === null && !suppressTransition ? 'transform 300ms ease-out' : 'none'}; transform: translateY(${transformStyle})`}
    onpointerdown={onTrayPointerDown}
    onpointermove={onTrayPointerMove}
    onpointerup={onTrayPointerUp}
    onpointercancel={onTrayPointerUp}
  >
    <button
      type="button"
      data-mobile-bottom-tray-toggle
      class="absolute left-1/2 top-0 z-[var(--z-floating)] flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-muted shadow-sm transition-all hover:brightness-95"
      class:rotate-180={!collapsed}
      style="width: 40px; height: 28px;"
      onclick={handleToggleClick}
      aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="width: 24px; height: 24px;"
      >
        <path d="m18 15-6-6-6 6"/>
      </svg>
    </button>

    {#snippet trayHandle()}
      <span class="absolute inset-x-0 top-0 h-px bg-border" aria-hidden="true"></span>
    {/snippet}

    <ResizableSidePanel
      bind:widthPx={heightPx}
      bind:isResizing
      orientation="vertical"
      {minPx}
      {maxPx}
      {defaultPx}
      {storageKey}
      {ariaLabel}
      handleVariant="overlay"
      handleClass={activeHandleClass + ' h-0'}
      handle={trayHandle}
      panelClass={cn('flex flex-col w-full', panelClass)}
      {collapsed}
      resizeDisabled={collapsed}
      {maxViewportRatio}
    >
      {#if children}
        {@render children()}
      {/if}
    </ResizableSidePanel>
  </div>
</div>
