import git from 'isomorphic-git';
import { deleteRepo, getRepo, listRepos, putRepo } from './repos.js';
import { localSnapshot, type GitFs } from './local.js';
import { monitorSnapshot, monitorSubscribe } from './monitor.js';
import type { GitHost, GitRepoRef, GitSnapshot } from './types.js';

export type CreateGitHostOptions = {
	/** Node `fs` for tests. Browser local uses `fsForLocal` instead. */
	fs?: GitFs;
	/**
	 * Per-repo GitFs rooted at a VFS folder id. When set, isomorphic-git `dir`
	 * is `'/'` on that fs. `repo.path` remains the VFS id.
	 */
	fsForLocal?: (rootId: string) => GitFs;
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
	const fsForLocal = opts.fsForLocal;
	const fetchImpl = opts.fetchImpl;
	const subscribeLocal = opts.subscribeLocal;

	function bindLocal(repoPath: string): { fs: GitFs; dir: string } {
		if (fsForLocal) return { fs: fsForLocal(repoPath), dir: '/' };
		if (fs) return { fs, dir: repoPath };
		throw new Error('Local git is not available in this environment');
	}

	async function requireRepo(id: string): Promise<GitRepoRef> {
		const repo = await getRepo(id);
		if (!repo) throw new Error(`Unknown git repo: ${id}`);
		return repo;
	}

	async function snapshotRepo(repo: GitRepoRef): Promise<GitSnapshot> {
		if (repo.backend === 'local') {
			const bound = bindLocal(repo.path);
			return localSnapshot(bound.fs, bound.dir);
		}
		return monitorSnapshot(repo, { fetchImpl });
	}

	function subscribeRepo(repo: GitRepoRef, onChange: (snap: GitSnapshot) => void): () => void {
		if (repo.backend === 'local') {
			let cancelled = false;
			const bound = bindLocal(repo.path);
			const emit = async () => {
				if (cancelled) return;
				try {
					const snap = await localSnapshot(bound.fs, bound.dir);
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
		subscribeRepo,
		async initLocal(repoPath) {
			const bound = bindLocal(repoPath);
			await git.init({ fs: bound.fs, dir: bound.dir });
		}
	};
}
