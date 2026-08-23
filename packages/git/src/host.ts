import { deleteRepo, getRepo, listRepos, putRepo } from './repos.js';
import { localSnapshot, type GitFs } from './local.js';
import { monitorSnapshot, monitorSubscribe } from './monitor.js';
import type { GitHost, GitRepoRef, GitSnapshot } from './types.js';

export type CreateGitHostOptions = {
	/** Node `fs` (or LightningFS). Omit to no-op local snapshots in the browser. */
	fs?: GitFs;
	fetchImpl?: typeof fetch;
};

function newId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `repo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createGitHost(opts: CreateGitHostOptions = {}): GitHost {
	const fs = opts.fs;
	const fetchImpl = opts.fetchImpl;

	async function requireRepo(id: string): Promise<GitRepoRef> {
		const repo = await getRepo(id);
		if (!repo) throw new Error(`Unknown git repo: ${id}`);
		return repo;
	}

	return {
		listRepos,
		async addRepo(input) {
			const repo: GitRepoRef = { ...input, id: newId() };
			return putRepo(repo);
		},
		removeRepo(id) {
			return deleteRepo(id);
		},
		async snapshot(repoId) {
			const repo = await requireRepo(repoId);
			if (repo.backend === 'local') {
				if (!fs) throw new Error('Local git is not available in this environment');
				return localSnapshot(fs, repo.path);
			}
			return monitorSnapshot(repo, { fetchImpl });
		},
		subscribe(repoId, onChange) {
			let unsub = () => {};
			let cancelled = false;
			void (async () => {
				const repo = await requireRepo(repoId);
				if (cancelled) return;
				if (repo.backend === 'local') {
					if (!fs) return;
					try {
						const snap: GitSnapshot = await localSnapshot(fs, repo.path);
						if (!cancelled) onChange(snap);
					} catch {
						/* local has no live events */
					}
					return;
				}
				unsub = monitorSubscribe(repo, onChange, { fetchImpl });
			})();
			return () => {
				cancelled = true;
				unsub();
			};
		}
	};
}
