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

  it('a read does NOT persist a default — a later write to a DIFFERENT status is still recorded', () => {
    // getSyncHealth must not auto-vivify: it is called from `$derived` blocks,
    // and writing to the SvelteMap during a derivation throws Svelte 5's
    // state_unsafe_mutation (dev mode) and aborts the flush. So a read before
    // any write returns a synthesized default but leaves the map empty; the
    // first real write (setStatus) still creates the entry. Confirms a read
    // doesn't interfere with a genuine subsequent transition to a status that
    // DIFFERS from the synthesized default.
    vi.stubGlobal('navigator', { onLine: true }); // synthesized default 'online'
    expect(getSyncHealth(NS).status).toBe('online');
    markSyncOffline(NS);
    expect(getSyncHealth(NS).status).toBe('offline');
    expect(getSyncHealth(NS).lastUnhealthyAt).not.toBeNull();
  });

  it('getSyncHealth does NOT persist the default across navigator.onLine flips (no auto-vivify)', () => {
    // The regression that broke the calendar's dev-mode reactivity: an earlier
    // version auto-vivified on read, so the first getSyncHealth STORED a
    // default built from the then-current navigator.onLine. Flipping
    // navigator.onLine afterward and reading the SAME namespace would then
    // return the STALE stored default instead of re-synthesizing — proving an
    // entry was persisted. With the no-write fix, no entry is stored, so the
    // second read re-synthesizes from the new navigator.onLine.
    vi.stubGlobal('navigator', { onLine: true });
    expect(getSyncHealth(NS).status).toBe('online');
    vi.stubGlobal('navigator', { onLine: false });
    expect(getSyncHealth(NS).status).toBe('offline');
    // Still no real entry: a later write is the first real observation.
    markSyncOffline(NS);
    expect(getSyncHealth(NS).lastUnhealthyAt).not.toBeNull();
  });
});
