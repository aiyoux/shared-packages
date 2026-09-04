<script lang="ts">
  /**
   * Compact zoom cluster for a timeline bar: zoom out / percentage (click to
   * reset to fit) / zoom in, then an optional minimap toggle. Presentational
   * only — the host owns the zoom value and does the maths. Structural CSS just
   * lays the buttons out in a row; colour comes from `currentColor` and theme
   * tokens, and the `class` passthrough plus stable class names let a host
   * restyle every part with `:global()`.
   */
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';
  import MapIcon from '@lucide/svelte/icons/map';
  import { MAX_ZOOM, MIN_ZOOM } from '@shared-packages/composition';
  import { cn } from '../utils.ts';

  let {
    zoom,
    minZoom = MIN_ZOOM,
    maxZoom = MAX_ZOOM,
    minimapOpen = false,
    iconSize = 13,
    class: className = '',
    testidPrefix = 'tl-zoom',
    onZoomIn,
    onZoomOut,
    onReset,
    onToggleMinimap
  }: {
    /** Current zoom multiplier over fit-to-width (1 = whole duration visible). */
    zoom: number;
    minZoom?: number;
    maxZoom?: number;
    /** Reflected on the minimap toggle's pressed state. */
    minimapOpen?: boolean;
    iconSize?: number;
    class?: string;
    testidPrefix?: string;
    onZoomIn: () => void;
    onZoomOut: () => void;
    /** Reset to fit-to-width (zoom = 1). */
    onReset: () => void;
    /** Omit to hide the minimap toggle entirely. */
    onToggleMinimap?: () => void;
  } = $props();

  const pct = $derived(`${Math.round(zoom * 100)}%`);
  const atMin = $derived(zoom <= minZoom + 1e-6);
  const atMax = $derived(zoom >= maxZoom - 1e-6);
</script>

<div class={cn('tl-zoom', className)} role="group" aria-label="Timeline zoom">
  <button
    type="button"
    class="tl-zoom-btn"
    data-testid={`${testidPrefix}-out`}
    title="Zoom out"
    aria-label="Zoom out"
    disabled={atMin}
    onclick={onZoomOut}
  >
    <ZoomOut size={iconSize} />
  </button>
  <button
    type="button"
    class="tl-zoom-btn tl-zoom-pct"
    data-testid={`${testidPrefix}-pct`}
    title="Reset zoom to fit"
    aria-label="Reset zoom to fit"
    onclick={onReset}
  >
    {pct}
  </button>
  <button
    type="button"
    class="tl-zoom-btn"
    data-testid={`${testidPrefix}-in`}
    title="Zoom in"
    aria-label="Zoom in"
    disabled={atMax}
    onclick={onZoomIn}
  >
    <ZoomIn size={iconSize} />
  </button>
  {#if onToggleMinimap}
    <span class="tl-zoom-divider" aria-hidden="true"></span>
    <button
      type="button"
      class="tl-zoom-btn tl-zoom-map"
      class:active={minimapOpen}
      data-testid={`${testidPrefix}-minimap`}
      title={minimapOpen ? 'Hide minimap' : 'Show minimap'}
      aria-label="Toggle minimap"
      aria-pressed={minimapOpen}
      onclick={onToggleMinimap}
    >
      <MapIcon size={iconSize} />
    </button>
  {/if}
</div>

<style>
  .tl-zoom {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .tl-zoom-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    opacity: 0.75;
  }
  .tl-zoom-btn:hover {
    opacity: 1;
  }
  .tl-zoom-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .tl-zoom-btn.active {
    opacity: 1;
  }
  .tl-zoom-pct {
    min-width: 38px;
  }
  .tl-zoom-divider {
    width: 1px;
    height: 14px;
    margin: 0 2px;
    background: currentColor;
    opacity: 0.25;
  }
</style>
