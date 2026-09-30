<script lang="ts">
 import { getMonitorLink, type MonitorLink, type MonitorLinkStatus } from '../services/monitorLink.js';
 import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
 let { profile }: { profile: MonitorConnectionProfileV1 } = $props();
 let status = $state<MonitorLinkStatus>({ state: 'connecting', jobs: false });
 let link = $state<MonitorLink>();
 $effect(() => {
  const current = profile;
  let disposed = false;
  let stop: (() => void) | undefined;
  void getMonitorLink(current).then((service) => {
   if (disposed) return;
   link = service;
   const refresh = () => { status = service.status(); };
   stop = service.subscribe(refresh); refresh();
  }).catch((error) => { if (!disposed) status = { state: 'unreachable', jobs: false, reason: String(error) }; });
  return () => { disposed = true; stop?.(); };
 });
</script>
<div class="monitor-status" data-testid="monitor-status" data-profile={profile.id}>
 <span>{status.state === 'reachable' ? 'Connected' : status.state === 'connecting' ? 'Connecting…' : 'Unreachable'}{status.version ? ` · ${status.version}` : ''}</span>
 {#if status.reason}<span>{status.reason}</span>{/if}
 {#if status.state === 'reachable'}
  <span>{status.jobs ? 'Background jobs supported' : 'Background jobs unavailable'}</span>
  <details><summary>Capabilities</summary><pre>{JSON.stringify(status.capabilities ?? {}, null, 2)}</pre></details>
 {:else if link}<button type="button" onclick={() => link?.retry()}>Retry</button>{/if}
</div>
<style>
 .monitor-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); }
 pre { overflow: auto; max-height: 12rem; }
</style>
