import './ensureBuffer.js';
import git from 'isomorphic-git';
import { deleteRepo, getRepo, listRepos, putRepo } from './repos.js';
import {
	localCommit,
	localDiffFile,
	localDiscardAllFile,
	localReadBlobAt,
	localSnapshot,
	localWriteWorkingFile,
	type GitFs
} from './local.js';
import { monitorSnapshot, monitorSubscribe, monitorTransportFor } from './monitor.js';
import type { GitFileDiff, GitHost, GitRepoRef, GitSnapshot, CommitInput
} from './types.js';

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

	function subscribeRepo(
		repo: GitRepoRef,
		onChange: (snap: GitSnapshot) => void,
		onError?: (err: unknown) => void
	): () => void {
		if (repo.backend === 'local') {
			let cancelled = false;
			const bound = bindLocal(repo.path);
			const emit = async () => {
				if (cancelled) return;
				try {
					const snap = await localSnapshot(bound.fs, bound.dir);
					if (!cancelled) onChange(snap);
				} catch (e) {
					if (!cancelled) onError?.(e);
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

	async function diffFileOn(repo: GitRepoRef, filepath: string): Promise<GitFileDiff> {
		if (repo.backend !== 'local') {
			throw new Error('Diffing is only supported for Browser files repos.');
		}
		const bound = bindLocal(repo.path);
		return localDiffFile(bound.fs, bound.dir, filepath);
	}

	function requireLocal(repo: GitRepoRef, action: string): { fs: GitFs; dir: string } {
		if (repo.backend !== 'local') {
			throw new Error(`${action} is only supported for Browser files repos.`);
		}
		return bindLocal(repo.path);
	}

	async function discardFileOn(repo: GitRepoRef, filepath: string, content: Uint8Array): Promise<void> {
		const bound = requireLocal(repo, 'Discarding changes');
		return localWriteWorkingFile(bound.fs, bound.dir, filepath, content);
	}

	async function discardAllFileOn(repo: GitRepoRef, filepath: string): Promise<void> {
		const bound = requireLocal(repo, 'Discarding changes');
		return localDiscardAllFile(bound.fs, bound.dir, filepath);
	}

	async function commitOn(repo: GitRepoRef, opts: CommitInput): Promise<string> {
		if (repo.backend !== 'local') {
			throw new Error('Committing is only supported for Browser files repos.');
		}
		const bound = bindLocal(repo.path);
		return localCommit(bound.fs, bound.dir, opts);
	}

	async function initAt(input: Pick<GitRepoRef, 'backend' | 'path'> & { baseUrl?: string }) {
		if (input.backend === 'local') {
			const bound = bindLocal(input.path);
			const run = () => git.init({ fs: bound.fs, dir: bound.dir });
			const buffered = bound.fs as { withBuffer?: <T>(fn: () => Promise<T>) => Promise<T> };
			if (typeof buffered.withBuffer === 'function') await buffered.withBuffer(run);
			else await run();
			return;
		}
		if (input.backend === 'monitor') {
			const transport = monitorTransportFor(
				{
					id: 'init',
					label: '',
					backend: 'monitor',
					path: input.path,
					...(input.baseUrl ? { baseUrl: input.baseUrl } : {})
				},
				fetchImpl
			);
			if (typeof transport.gitInit !== 'function') {
				throw new Error('This monitor cannot initialize repositories.');
			}
			await transport.gitInit(input.path);
			return;
		}
		throw new Error(`Cannot initialize a ${input.backend} repository`);
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
		async commit(repoId, opts) {
			return commitOn(await requireRepo(repoId), opts);
		},
		commitRepo: commitOn,
		subscribe(repoId, onChange, onError) {
			let unsub = () => {};
			let cancelled = false;
			void (async () => {
				const repo = await requireRepo(repoId);
				if (cancelled) return;
				unsub = subscribeRepo(repo, onChange, onError);
			})();
			return () => {
				cancelled = true;
				unsub();
			};
		},
		snapshotRepo,
		subscribeRepo,
		async initLocal(repoPath) {
			return initAt({ backend: 'local', path: repoPath });
		},
		async init(input) {
			return initAt(input);
		},
		async readBlobAt(repo, rev, filepath) {
			if (repo.backend === 'monitor') {
				throw new Error('Monitor git blob is not wired on this host yet');
			}
			const bound = bindLocal(repo.path);
			return localReadBlobAt(bound.fs, bound.dir, rev, filepath);
		},
		async diffFile(repoId, filepath) {
			return diffFileOn(await requireRepo(repoId), filepath);
		},
		async discardFile(repoId, filepath, content) {
			return discardFileOn(await requireRepo(repoId), filepath, content);
		},
		async discardAllFile(repoId, filepath) {
			return discardAllFileOn(await requireRepo(repoId), filepath);
		}
	};
}
