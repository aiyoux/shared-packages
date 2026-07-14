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
 * Always returns a REAL, stored entry for the namespace — auto-vivifying a
 * default one on first access. Mirrors the `bucketFor` pattern in
 * ops-store.svelte.ts / fetch-store.svelte.ts: a reactive consumer must read
 * an entry that ACTUALLY EXISTS in the SvelteMap (not a value synthesized on
 * the fly and discarded), so that a namespace transitions from "absent" to
 * "present" at most once — from then on every update is a value change on an
 * EXISTING key, which is unambiguously the case SvelteMap is built to track.
 * Read-only: used by `getSyncHealth`, NOT by `setStatus` below — see its
 * comment for why the write path must compare against genuinely-recorded
 * state instead of a synthesized default.
 */
function bucketFor(namespace: string): SyncHealthState {
  let entry = stores.get(namespace);
  if (!entry) {
    entry = defaultHealth();
    stores.set(namespace, entry);
  }
  return entry;
}

function setStatus(namespace: string, status: SyncHealthStatus): void {
  // Deliberately reads the map directly (not via bucketFor): comparing
  // against a synthesized default would let the FIRST-EVER observation for a
  // namespace silently no-op whenever it happens to match that guess (e.g.
  // navigator.onLine is true, the engine's first-ever markSyncHealthy also
  // says 'online') — the exact write-skip bug this function was already
  // rewritten once to fix. `current` here is `undefined` only when NEITHER a
  // read nor a write has ever touched this namespace; in every other case
  // (including after a read auto-vivified it) it holds the last real value.
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

/** Reactive read — call inside a `$derived`/`$effect` to track this namespace's health. */
export function getSyncHealth(namespace: string): SyncHealthState {
  return bucketFor(namespace);
}

export function clearSyncHealth(namespace: string): void {
  stores.delete(namespace);
}
