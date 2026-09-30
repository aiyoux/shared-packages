/**
 * One multiplexed host SSE per monitor profile.
 */
import { createMonitorClient, type MonitorHostSnapshot, type MonitorTransport } from './client.js';
import { createSnapshotMux, type SnapshotMux } from './snapshotMux.js';
import type { MonitorConnectionProfileV1 } from './types.js';
import { getMonitorLink } from '../services/monitorLink.js';

const byProfile = new Map<string, SnapshotMux<MonitorHostSnapshot>>();

export type HostStream = SnapshotMux<MonitorHostSnapshot>;

export function getHostStream(
	profile: MonitorConnectionProfileV1,
	opts?: { transport?: MonitorTransport }
): HostStream {
	const existing = byProfile.get(profile.id);
	if (existing) return existing;
	const transport = opts?.transport ?? createMonitorClient({ baseUrl: profile.baseUrl });
 if (typeof navigator !== 'undefined' && typeof (navigator as unknown as { locks?: { query?: unknown } }).locks?.query === 'function') {
  const listeners = new Map<(snapshot: MonitorHostSnapshot) => void, (() => void) | null>();
  let stopped = false;
  const mux: HostStream = {
   subscribe(listener) {
    if (stopped) return () => {};
    listeners.set(listener, null);
    void getMonitorLink(profile, transport).then((link) => { if (listeners.has(listener) && !stopped) listeners.set(listener, link.subscribeHost(listener)); }).catch((error) => console.error('Could not subscribe to monitor host', error));
    return () => { listeners.get(listener)?.(); listeners.delete(listener); };
   },
   listenerCount: () => listeners.size,
   abort() { stopped = true; for (const release of listeners.values()) release?.(); listeners.clear(); }
  };
  byProfile.set(profile.id, mux); return mux;
 }
	const mux = createSnapshotMux<MonitorHostSnapshot>({
		fetchOnce: () => transport.hostSnapshot(),
		openEvents: (onSnapshot) => transport.openHostEvents({ onSnapshot })
	});
	byProfile.set(profile.id, mux);
	return mux;
}

export function abortHostStream(profileId: string): void {
	const mux = byProfile.get(profileId);
	if (!mux) return;
	mux.abort();
	byProfile.delete(profileId);
}

export function abortAllHostStreams(): void {
	for (const id of [...byProfile.keys()]) abortHostStream(id);
}
