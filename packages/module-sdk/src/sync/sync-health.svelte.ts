import { SvelteMap } from 'svelte/reactivity';

/**
 * Reactive, per-namespace connectivity signal for the sync engine + live
 * connection. Distinct from `ops-store` (durable op lifecycle) and
 * `fetch-store` (in-flight reads) — this answers "can we currently reach the
 * server," which the host UI needs for an offline banner / reconnect
 * transition (see connectivity.svelte.ts in app-build, which combines this
 * with pending-op counts into a richer online/offline/reconnecting/synced
 * state machine).
 *
 * Three states, in order of confidence:
 *  - `online`: the last push or live-socket handshake actually succeeded.
 *  - `degraded`: `navigator.onLine` may say true, but a push or the live
 *    socket just failed for network reasons (captive portal, VPN blip, flaky
 *    wifi) — reachability is currently in doubt.
 *  - `offline`: the browser's own `navigator.onLine` says false, or the
 *    engine explicitly skipped a push attempt because of it. The most
 *    trustworthy of the three (browsers rarely lie about "definitely offline").
 *
 * Deliberately does NOT flip back to `online` on the browser's `online`
 * event alone — that event only means the OS thinks a network interface is
 * up, not that the server is reachable. Status only improves on a genuine
 * success (op accepted, live socket ready), so a stale "online" never masks
 * a still-failing reconnect.
 */

export type SyncHealthStatus = 'online' | 'offline' | 'degraded';

export interface SyncHealthState {
  status: SyncHealthStatus;
  /** epoch ms of the last successful push accept or live-socket ready event. */
  lastHealthyAt: number | null;
  /** epoch ms of the last offline/degraded transition. */
  lastUnhealthyAt: number | null;
}

const stores = new SvelteMap<string, SyncHealthState>();

function defaultHealth(): SyncHealthState {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return {
    status: offline ? 'offline' : 'online',
    lastHealthyAt: null,
    lastUnhealthyAt: null
  };
}

/**
 * Reactive read of a namespace's health — call inside a `$derived`/`$effect`
 * to track it. Returns the stored entry, or a synthesized `defaultHealth()`
 * when the namespace has never been written.
 *
 * Deliberately does NOT auto-vivify (it must not write to the SvelteMap): this
 * function is called from `$derived` blocks (e.g. the host layout's
 * `activeHealthStatus`), and mutating reactive state inside a derivation
 * throws Svelte 5's `state_unsafe_mutation` in dev mode — which aborts the
 * flush and breaks every other reactive update in the same tick (the calendar's
 * "Add Event" create-tab open and day-cell selection both died this way).
 * Reactivity is preserved without a write because `stores.get(namespace)` on a
 * `SvelteMap` subscribes the caller to that key even when it is absent, so the
 * absent→present transition (the first `setStatus` write) still re-runs
 * consumers. The write path (`setStatus` below) creates the real entry on the
 * first genuine observation.
 */
export function getSyncHealth(namespace: string): SyncHealthState {
  return stores.get(namespace) ?? defaultHealth();
}

function setStatus(namespace: string, status: SyncHealthStatus): void {
  // Reads the map directly. `current` is `undefined` only when no write has
  // ever touched this namespace — getSyncHealth deliberately does NOT
  // auto-vivify, so a first-ever read leaves the map empty. Comparing against
  // a synthesized default here would let the FIRST-EVER observation silently
  // no-op whenever it matches the guess (e.g. navigator.onLine is true and the
  // first markSyncHealthy also says 'online') — the exact write-skip bug this
  // was already rewritten once to fix. Treat undefined as "no real entry yet"
  // and always write the first real observation.
  const current = stores.get(namespace);
  if (current && current.status === status) return;
  const now = Date.now();
  stores.set(namespace, {
    status,
    lastHealthyAt: status === 'online' ? now : (current?.lastHealthyAt ?? null),
    lastUnhealthyAt: status !== 'online' ? now : (current?.lastUnhealthyAt ?? null)
  });
}

/** A push accepted or the live socket handshook successfully. */
export function markSyncHealthy(namespace: string): void {
  setStatus(namespace, 'online');
}

/** A push or the live socket failed for network reasons; reachability is unconfirmed. */
export function markSyncDegraded(namespace: string): void {
  setStatus(namespace, 'degraded');
}

/** `navigator.onLine` reports false, or a push was skipped because of it. */
export function markSyncOffline(namespace: string): void {
  setStatus(namespace, 'offline');
}

export function clearSyncHealth(namespace: string): void {
  stores.delete(namespace);
}
