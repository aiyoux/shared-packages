/**
 * One multiplexed host SSE per monitor profile.
 */
import { createMonitorClient, type MonitorHostSnapshot, type MonitorTransport } from './client.js';
import { createSnapshotMux, type SnapshotMux } from './snapshotMux.js';
import type { MonitorConnectionProfileV1 } from './types.js';

const byProfile = new Map<string, SnapshotMux<MonitorHostSnapshot>>();

export type HostStream = SnapshotMux<MonitorHostSnapshot>;

export function getHostStream(
	profile: MonitorConnectionProfileV1,
	opts?: { transport?: MonitorTransport }
): HostStream {
	const existing = byProfile.get(profile.id);
	if (existing) return existing;
	const transport = opts?.transport ?? createMonitorClient({ baseUrl: profile.baseUrl });
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
