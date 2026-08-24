import { deleteRepo, getRepo, listRepos, putRepo } from './repos.js';
import { localSnapshot, type GitFs } from './local.js';
import { monitorSnapshot, monitorSubscribe } from './monitor.js';
import type { GitHost, GitRepoRef, GitSnapshot } from './types.js';

export type CreateGitHostOptions = {
	/** Node `fs` (or LightningFS). Omit to no-op local snapshots in the browser. */
	fs?: GitFs;
	fetchImpl?: typeof fetch;
	/** Live local working-tree notifications. Omit for a one-shot local snapshot. */
	subscribeLocal?: (dir: string, onChange: () => void) => () => void;
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
	const subscribeLocal = opts.subscribeLocal;

	async function requireRepo(id: string): Promise<GitRepoRef> {
		const repo = await getRepo(id);
		if (!repo) throw new Error(`Unknown git repo: ${id}`);
		return repo;
	}

	async function snapshotRepo(repo: GitRepoRef): Promise<GitSnapshot> {
		if (repo.backend === 'local') {
			if (!fs) throw new Error('Local git is not available in this environment');
			return localSnapshot(fs, repo.path);
		}
		return monitorSnapshot(repo, { fetchImpl });
	}

	function subscribeRepo(repo: GitRepoRef, onChange: (snap: GitSnapshot) => void): () => void {
		if (repo.backend === 'local') {
			let cancelled = false;
			const emit = async () => {
				if (!fs || cancelled) return;
				try {
					const snap = await localSnapshot(fs, repo.path);
					if (!cancelled) onChange(snap);
				} catch {
					/* local snapshot failed */
				}
			};
			void emit();
			if (!subscribeLocal) {
				return () => {
					cancelled = true;
				};
			}
			const unsub = subscribeLocal(repo.path, () => {
				void emit();
			});
			return () => {
				cancelled = true;
				unsub();
			};
		}
		return monitorSubscribe(repo, onChange, { fetchImpl });
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
			return snapshotRepo(await requireRepo(repoId));
		},
		subscribe(repoId, onChange) {
			let unsub = () => {};
			let cancelled = false;
			void (async () => {
				const repo = await requireRepo(repoId);
				if (cancelled) return;
				unsub = subscribeRepo(repo, onChange);
			})();
			return () => {
				cancelled = true;
				unsub();
			};
		},
		snapshotRepo,
		subscribeRepo
	};
}
