/**
 * One multiplexed git SSE per monitor profile (reconnects when the path changes).
 */
import { createMonitorClient, type MonitorGitSnapshot, type MonitorTransport } from './client.js';
import { createSnapshotMux, type SnapshotMux } from './snapshotMux.js';
import type { MonitorConnectionProfileV1 } from './types.js';

type GitEntry = { path: string; mux: SnapshotMux<MonitorGitSnapshot> };

const byProfile = new Map<string, GitEntry>();

export type GitStream = SnapshotMux<MonitorGitSnapshot>;

export function getGitStream(
	profile: MonitorConnectionProfileV1,
	path: string,
	opts?: { transport?: MonitorTransport }
): GitStream {
	const existing = byProfile.get(profile.id);
	if (existing && existing.path === path) return existing.mux;
	existing?.mux.abort();
	const transport = opts?.transport ?? createMonitorClient({ baseUrl: profile.baseUrl });
	const mux = createSnapshotMux<MonitorGitSnapshot>({
		fetchOnce: () => transport.gitSnapshot(path),
		openEvents: (onSnapshot) => transport.openGitEvents(path, { onSnapshot })
	});
	byProfile.set(profile.id, { path, mux });
	return mux;
}

export function abortGitStream(profileId: string): void {
	const entry = byProfile.get(profileId);
	if (!entry) return;
	entry.mux.abort();
	byProfile.delete(profileId);
}

export function abortAllGitStreams(): void {
	for (const id of [...byProfile.keys()]) abortGitStream(id);
}
