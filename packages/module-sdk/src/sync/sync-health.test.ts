import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  markSyncHealthy,
  markSyncDegraded,
  markSyncOffline,
  getSyncHealth,
  clearSyncHealth
} from './sync-health.svelte.ts';

describe('sync-health store', () => {
  const NS = 'test-health-ns';

  afterEach(() => {
    clearSyncHealth(NS);
    clearSyncHealth('never-touched-ns');
    clearSyncHealth('another-never-touched-ns');
    vi.unstubAllGlobals();
  });

  it("persists the first-ever status even when it matches navigator.onLine's default guess", () => {
    // Regression test: navigator.onLine is false here, so defaultHealth()
    // ALSO guesses 'offline' — the exact condition that used to make
    // setStatus() compare against an unstored default and skip the write
    // entirely, leaving the SvelteMap empty. A reactive `$derived` reading
    // this namespace while it was still absent would then never be notified
    // of the real transition (it would just keep re-deriving a fresh, and
    // soon stale, default). Flipping navigator.onLine AFTER recording proves
    // whether a real entry was stored: only a missing entry would follow it.
    vi.stubGlobal('navigator', { onLine: false });
    markSyncOffline(NS);

    vi.stubGlobal('navigator', { onLine: true });
    expect(getSyncHealth(NS).status).toBe('offline');
  });

  it('records lastUnhealthyAt on the first-ever offline observation', () => {
    vi.stubGlobal('navigator', { onLine: false });
    markSyncOffline(NS);
    expect(getSyncHealth(NS).lastUnhealthyAt).not.toBeNull();
  });

  it('transitions between statuses and updates timestamps accordingly', () => {
    markSyncHealthy(NS);
    expect(getSyncHealth(NS).status).toBe('online');
    const healthyAt = getSyncHealth(NS).lastHealthyAt;
    expect(healthyAt).not.toBeNull();

    markSyncDegraded(NS);
    expect(getSyncHealth(NS).status).toBe('degraded');
    // lastHealthyAt is preserved across the transition to degraded.
    expect(getSyncHealth(NS).lastHealthyAt).toBe(healthyAt);
  });

  it('a repeated identical status is a no-op (no spurious timestamp bump)', () => {
    markSyncOffline(NS);
    const first = getSyncHealth(NS).lastUnhealthyAt;
    markSyncOffline(NS);
    expect(getSyncHealth(NS).lastUnhealthyAt).toBe(first);
  });

  it('defaults to a value derived from navigator.onLine before anything is ever recorded', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(getSyncHealth('never-touched-ns').status).toBe('offline');
    vi.stubGlobal('navigator', { onLine: true });
    expect(getSyncHealth('another-never-touched-ns').status).toBe('online');
  });

  it('a read auto-vivifies the namespace, and a later write to a DIFFERENT status is still recorded', () => {
    // getSyncHealth auto-vivifies (bucketFor) so a reactive $derived that
    // reads a namespace before anything has ever happened to it still has a
    // real map entry to be notified through later. Confirms that
    // auto-vivification doesn't interfere with a genuine subsequent
    // transition to a status that DIFFERS from the vivified default.
    vi.stubGlobal('navigator', { onLine: true }); // vivifies as 'online'
    expect(getSyncHealth(NS).status).toBe('online');
    markSyncOffline(NS);
    expect(getSyncHealth(NS).status).toBe('offline');
    expect(getSyncHealth(NS).lastUnhealthyAt).not.toBeNull();
  });
});
