<script lang="ts">
  import { getActiveOverlay } from './overlay-state.svelte.ts';
  import { DEFAULT_PORTAL_ROOT_ID } from './portal.ts';
  import OverlayFrame from './OverlayFrame.svelte';

  const overlay = $derived(getActiveOverlay());
</script>

<div id={DEFAULT_PORTAL_ROOT_ID} class="pointer-events-none fixed inset-0 [z-index:var(--z-popover)]"></div>

{#if overlay}
  <OverlayFrame {overlay} />
{/if}
