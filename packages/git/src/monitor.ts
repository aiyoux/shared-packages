import {
	createMonitorClient,
	DEFAULT_MONITOR_BASE_URL,
	getGitStream,
	type MonitorConnectionProfileV1,
	type MonitorGitSnapshot,
	type MonitorTransport
} from '@shared-packages/file-system/monitor';
import type { GitRepoRef, GitSnapshot } from './types.js';

export function mapMonitorGitSnapshot(snap: MonitorGitSnapshot): GitSnapshot {
	return {
		status: { branch: snap.branch, dirty: snap.dirty },
		log: snap.log.map((c) => {
			const row: GitSnapshot['log'][number] = { sha: c.sha, subject: c.subject };
			if (c.author) row.author = c.author;
			if (c.committed_at) row.committedAt = c.committed_at;
			return row;
		})
	};
}

export function profileFromRepo(repo: GitRepoRef): MonitorConnectionProfileV1 {
	const now = 0;
	return {
		v: 1,
		id: repo.profileId ?? repo.id,
		name: repo.label,
		baseUrl: repo.baseUrl || DEFAULT_MONITOR_BASE_URL,
		rootPath: '/',
		createdAt: now,
		updatedAt: now
	};
}

export function monitorTransportFor(
	repo: GitRepoRef,
	fetchImpl?: typeof fetch
): MonitorTransport {
	return createMonitorClient({
		baseUrl: repo.baseUrl || DEFAULT_MONITOR_BASE_URL,
		fetchImpl
	});
}

export async function monitorSnapshot(
	repo: GitRepoRef,
	opts?: { transport?: MonitorTransport; fetchImpl?: typeof fetch }
): Promise<GitSnapshot> {
	const transport = opts?.transport ?? monitorTransportFor(repo, opts?.fetchImpl);
	return mapMonitorGitSnapshot(await transport.gitSnapshot(repo.path));
}

export function monitorSubscribe(
	repo: GitRepoRef,
	onChange: (snap: GitSnapshot) => void,
	opts?: { transport?: MonitorTransport; fetchImpl?: typeof fetch }
): () => void {
	const profile = profileFromRepo(repo);
	const transport = opts?.transport ?? monitorTransportFor(repo, opts?.fetchImpl);
	return getGitStream(profile, repo.path, { transport }).subscribe((snap) => {
		onChange(mapMonitorGitSnapshot(snap));
	});
}
