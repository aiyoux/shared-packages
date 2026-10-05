<script lang="ts">
  import '@shared-packages/design-system/button.css';
  import { onMount } from 'svelte';
  import { browserModelStore } from '@shared-packages/model-store';
  let estimate = $state<StorageEstimate | null>(null);
  let persistent = $state<boolean | null>(null);
  let error = $state('');
  let busy = $state(false);
  let mounted = false;
  async function refresh() {
    try {
      const [next, kept] = await Promise.all([browserModelStore.estimate(), browserModelStore.persisted()]);
      if (mounted) { estimate = next; persistent = kept; }
    } catch (e) { if (mounted) error = e instanceof Error ? e.message : String(e); }
  }
  onMount(() => {
    mounted = true; void refresh();
    const off = browserModelStore.subscribe(() => void refresh());
    return () => { mounted = false; off(); };
  });
  async function persist() {
    busy = true; error = '';
    try {
      persistent = await browserModelStore.persist();
      if (!persistent) error = 'The browser did not grant persistent storage. You can request it again later.';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  const format = (bytes: number | undefined) => bytes == null ? 'unknown' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
</script>
<div class="model-storage" data-testid="model-storage">
  <p>Browser storage (all app data): {format(estimate?.usage)} used · {format(estimate?.quota)} quota. Persistence: {persistent == null ? 'checking' : persistent ? 'granted' : 'not granted'}.</p>
  {#if persistent === false}<button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={() => void persist()}>Keep models when space runs low</button>{/if}
  {#if error}<p role="status">{error}</p>{/if}
</div>
<style>.model-storage { font-size: 0.8rem; opacity: 0.85; margin-top: 1rem; }</style>
