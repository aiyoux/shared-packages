<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './utils.ts';

  type HandleVariant = 'overlay' | 'divider';
  type Orientation = 'horizontal' | 'vertical';

  let {
    widthPx = $bindable(320),
    isResizing = $bindable(false),
    storageKey,
    minPx = 260,
    maxPx = 720,
    defaultPx = 320,
    ariaLabel = 'Resize side panel',
    handleVariant = 'divider',
    panelClass = '',
    handleClass = '',
    showAriaValue = true,
    orientation = 'horizontal',
    collapsed = $bindable(false),
    resizeDisabled = false,
    onToggle,
    children,
    handle,
    maxViewportRatio = orientation === 'vertical' ? 0.95 : 0.7
  }: {
    widthPx?: number;
    isResizing?: boolean;
    storageKey?: string;
    minPx?: number;
    maxPx?: number;
    defaultPx?: number;
    ariaLabel?: string;
    handleVariant?: HandleVariant;
    panelClass?: string;
    handleClass?: string;
    showAriaValue?: boolean;
    orientation?: Orientation;
    collapsed?: boolean;
    resizeDisabled?: boolean;
    onToggle?: () => void;
    children?: Snippet;
    handle?: Snippet;
    maxViewportRatio?: number;
  } = $props();

  const browser = typeof window !== 'undefined';
  let dragState = $state<{ startX: number; startY: number; startWidth: number; startTime: number; lastY: number; lastTime: number; velocityY: number } | null>(null);
  let dragTarget: HTMLElement | null = null;
  let hydratedStorageKey = $state<string | null>(null);

  function clampWidth(value: number): number {
    if (!Number.isFinite(value)) return defaultPx;
    const maxByViewport =
      browser && typeof window !== 'undefined'
        ? Math.max(minPx, Math.floor((orientation === 'vertical' ? window.innerHeight : window.innerWidth) * maxViewportRatio))
        : maxPx;
    const upper = Math.min(maxPx, maxByViewport);
    return Math.min(upper, Math.max(minPx, Math.round(value)));
  }

  function persistWidth() {
    if (!browser || !storageKey) return;
    window.localStorage.setItem(storageKey, String(widthPx));
  }

  function setWidth(nextWidth: number) {
    widthPx = clampWidth(nextWidth);
  }

  function resetWidth() {
    widthPx = defaultPx;
    persistWidth();
  }

  function handleResizeStart(event: PointerEvent) {
    if (resizeDisabled) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement | null;
    try {
      target?.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is an optimization here — the window listeners below keep
      // the drag tracking (and ending) even without it.
    }
    dragTarget = target;
    const now = Date.now();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: widthPx,
      startTime: now,
      lastY: event.clientY,
      lastTime: now,
      velocityY: 0
    };
    isResizing = true;
  }

  // Track the active drag on the window, not the element: if pointer capture
  // silently failed (or was implicitly released), element-only listeners stop
  // seeing moves and — worse — never see the pointerup, leaving the drag
  // armed so that later mere hovers keep resizing the panel.
  $effect(() => {
    if (!isResizing) return;
    const move = (event: PointerEvent) => handleResizeMove(event);
    const end = (event: PointerEvent) => handleResizeEnd(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  });

  function handleResizeMove(event: PointerEvent) {
    if (!dragState || !isResizing) return;
    // A drag only exists while the primary button is down. Without this
    // guard, a pointerup missed elsewhere leaves the drag armed and every
    // later hover keeps resizing the panel.
    if (!(event.buttons & 1)) {
      handleResizeEnd(event);
      return;
    }
    const now = Date.now();
    const elapsed = Math.max(1, now - dragState.lastTime);
    dragState.velocityY = (event.clientY - dragState.lastY) / elapsed;
    dragState.lastY = event.clientY;
    dragState.lastTime = now;

    if (orientation === 'vertical') {
      const delta = dragState.startY - event.clientY;
      const nextWidth = dragState.startWidth + delta;
      if (nextWidth < minPx * 0.5 && onToggle) {
        // Snap closed mid-drag
        try {
          dragTarget?.releasePointerCapture?.(event.pointerId);
        } catch {
          // Capture may already be gone; never abort the state reset.
        }
        dragState = null;
        isResizing = false;
        onToggle();
        return;
      }
      setWidth(nextWidth);
    } else {
      const delta = event.clientX - dragState.startX;
      setWidth(dragState.startWidth - delta);
    }
  }

  function handleResizeEnd(event: PointerEvent) {
    if (!dragState) return;
    try {
      dragTarget?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be gone; never abort the state reset below.
    }
    dragTarget = null;
    if (orientation === 'vertical' && onToggle) {
      const now = Date.now();
      const elapsed = Math.max(1, now - dragState.startTime);
      const releaseElapsed = Math.max(1, now - dragState.lastTime);
      const releaseVelocityY = (event.clientY - dragState.lastY) / releaseElapsed;
      const downwardDistance = event.clientY - dragState.startY;
      const averageVelocityY = downwardDistance / elapsed;
      const isStillMovingDown = releaseVelocityY > 0.35 || dragState.velocityY > 0.45;
      const isQuickSwipeClose = downwardDistance > 72 && elapsed < 320 && averageVelocityY > 0.65 && isStillMovingDown;
      if (isQuickSwipeClose) {
        dragState = null;
        isResizing = false;
        onToggle();
        return;
      }
    }
    dragState = null;
    isResizing = false;
    persistWidth();
  }

  function handleResizeKey(event: KeyboardEvent) {
    if (resizeDisabled) return;
    const step = event.shiftKey ? 48 : 16;
    const isDecrease = orientation === 'vertical' ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
    const isIncrease = orientation === 'vertical' ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
    if (isIncrease) {
      event.preventDefault();
      setWidth(widthPx + step);
    } else if (isDecrease) {
      event.preventDefault();
      setWidth(widthPx - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetWidth();
      return;
    } else {
      return;
    }
    persistWidth();
  }

  function handleResizeDoubleClick() {
    if (resizeDisabled) return;
    resetWidth();
  }

  $effect(() => {
    if (!browser) {
      widthPx = clampWidth(widthPx);
      return;
    }

    const nextKey = storageKey ?? '__none__';
    if (hydratedStorageKey === nextKey) return;

    if (storageKey) {
      const stored = Number.parseInt(window.localStorage.getItem(storageKey) ?? '', 10);
      widthPx = Number.isFinite(stored) ? clampWidth(stored) : clampWidth(widthPx);
    } else {
      widthPx = clampWidth(widthPx);
    }

    hydratedStorageKey = nextKey;
  });

  $effect(() => {
    if (!isResizing && dragState) {
      dragState = null;
    }
  });
</script>

{#snippet resizeHandle()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="separator"
    aria-orientation={orientation}
    aria-label={ariaLabel}
    aria-valuemin={minPx}
    aria-valuemax={maxPx}
    aria-valuenow={showAriaValue ? widthPx : undefined}
    aria-disabled={resizeDisabled}
    tabindex="0"
    class={cn(
      'group shrink-0 flex items-center justify-center',
      'relative touch-none before:absolute before:-inset-5 before:content-[""]',
      handleClass
    )}
    onpointerdown={handleResizeStart}
    onkeydown={handleResizeKey}
    ondblclick={handleResizeDoubleClick}
  >
    {#if onToggle}
      <button
        type="button"
        class="relative z-[var(--z-raised)] flex items-center justify-center rounded-full bg-muted hover:brightness-95 transition-all shadow-sm"
        class:rotate-180={!collapsed}
        style={orientation === 'vertical' ? 'width: 40px; height: 28px;' : 'width: 28px; height: 40px;'}
        onclick={onToggle}
        onpointerdown={(e) => e.stopPropagation()}
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
    {/if}
    {#if handle}
      {@render handle()}
    {:else if orientation !== 'vertical'}
      <!-- full-height hairline -->
      <span class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border" aria-hidden="true"></span>
      <!-- centered pill -->
      <span
        aria-hidden="true"
        class="relative z-[var(--z-raised)] h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary group-active:bg-primary"
        class:bg-primary={isResizing}
      ></span>
    {/if}
  </div>
{/snippet}

{#if handleVariant === 'divider'}
  {@render resizeHandle()}
{/if}

<aside class={cn(panelClass)} style={orientation === 'vertical' ? `height: ${widthPx}px` : `width: ${widthPx}px`}>
    {#if handleVariant === 'overlay'}
      {@render resizeHandle()}
    {/if}
    {#if children}
      {@render children()}
    {/if}
  </aside>
