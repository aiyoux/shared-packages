<script lang="ts">
  /**
   * A thin overview strip under a timeline: the whole duration squashed to fit,
   * with a draggable rectangle marking the slice currently visible in the main
   * view. The host paints the track content through the `content` snippet (it is
   * handed a `toX` mapper and the strip's pixel size), so the minimap stays
   * agnostic about what a "clip" looks like.
   *
   * Click or drag anywhere on the strip to recentre the main view there.
   */
  import type { Snippet } from 'svelte';
  import {
    clampScrollX,
    createTimelineViewport,
    viewportWindowFraction
  } from '@shared-packages/composition';
  import { cn } from '../utils.ts';

  let {
    durationMs,
    viewportPx,
    zoom,
    scrollX,
    playheadMs = null,
    height = 40,
    class: className = '',
    testid = 'tl-minimap',
    content,
    onScroll
  }: {
    durationMs: number;
    /** Width of the main timeline window, in px — sets the viewport rect size. */
    viewportPx: number;
    zoom: number;
    scrollX: number;
    /** Draw a playhead marker at this time. `null` to omit. */
    playheadMs?: number | null;
    height?: number;
    class?: string;
    testid?: string;
    /** Host-drawn overview content, positioned with the supplied mapper. */
    content?: Snippet<[{ toX: (ms: number) => number; width: number; height: number }]>;
    /** Commit a new main-view scroll offset (content px), already clamped. */
    onScroll: (scrollX: number) => void;
  } = $props();

  let el = $state<HTMLDivElement>();
  let width = $state(0);
  let dragging = $state(false);

  $effect(() => {
    const node = el;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => (width = node.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  });

  const dur = $derived(Math.max(0, durationMs));
  const toX = $derived((ms: number) => (dur > 0 ? (Math.min(dur, Math.max(0, ms)) / dur) * width : 0));
  const win = $derived(
    viewportWindowFraction(createTimelineViewport({ durationMs: dur, viewportPx, zoom, scrollX }))
  );
  const playheadPct = $derived(dur > 0 && playheadMs != null ? (playheadMs / dur) * 100 : null);

  function scrollToClientX(clientX: number) {
    if (!el || dur <= 0 || width <= 0) return;
    const frac = (clientX - el.getBoundingClientRect().left) / width;
    const vp = createTimelineViewport({ durationMs: dur, viewportPx, zoom, scrollX });
    // Centre the visible window on the clicked instant.
    onScroll(clampScrollX(vp, frac * vp.contentPx - viewportPx / 2));
  }

  function onpointerdown(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    el?.setPointerCapture(e.pointerId);
    scrollToClientX(e.clientX);
  }
  function onpointermove(e: PointerEvent) {
    if (dragging) scrollToClientX(e.clientX);
  }
  function onpointerup(e: PointerEvent) {
    dragging = false;
    el?.releasePointerCapture?.(e.pointerId);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={el}
  class={cn('tl-minimap', className)}
  data-testid={testid}
  style="height:{height}px"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
>
  {#if content && width > 0}
    <div class="tl-minimap-content">
      {@render content({ toX, width, height })}
    </div>
  {/if}

  {#if playheadPct != null}
    <span class="tl-minimap-playhead" style="left:{playheadPct}%" aria-hidden="true"></span>
  {/if}

  <span
    class="tl-minimap-window"
    class:dragging
    style="left:{win.left * 100}%;width:{win.width * 100}%"
    data-testid={`${testid}-window`}
    aria-hidden="true"
  ></span>
</div>

<style>
  .tl-minimap {
    position: relative;
    width: 100%;
    overflow: hidden;
    user-select: none;
    touch-action: none;
    cursor: pointer;
    background: var(--tl-minimap-bg, rgb(128 128 128 / 0.12));
  }
  .tl-minimap-content {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .tl-minimap-window {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 6px;
    border: 1px solid var(--tl-minimap-window-border, currentColor);
    background: var(--tl-minimap-window-fill, currentColor);
    opacity: 0.16;
    pointer-events: none;
  }
  .tl-minimap-window.dragging {
    opacity: 0.26;
  }
  .tl-minimap-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    transform: translateX(-1px);
    background: var(--tl-playhead-color, currentColor);
    pointer-events: none;
  }
</style>
