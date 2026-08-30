export type GitCommit = {
	sha: string;
	subject: string;
	author?: string;
	committedAt?: string;
};

export type GitStatus = { branch: string | null; dirty: boolean };

/**
 * One changed path in the working tree, relative to HEAD.
 *
 * Deliberately NOT a model of git's index. The UI stages exactly what you tick
 * and commits it in one step, so a separate "staged" state would be a second
 * source of truth users could get stuck in without any way to inspect it.
 */
export type GitChange = {
	path: string;
	status: 'added' | 'modified' | 'deleted';
};

export type GitAuthor = { name: string; email: string };

export type GitSnapshot = {
	status: GitStatus;
	log: GitCommit[];
	/** Empty for backends that cannot enumerate changes (monitor). */
	changes: GitChange[];
};

export type GitRepoRef = {
	id: string;
	label: string;
	backend: 'local' | 'monitor';
	path: string;
	profileId?: string;
	baseUrl?: string;
	/**
	 * Monitor profile root the explorer ids are relative to. Kept on the ref so
	 * a later folder click can rebuild absolute paths without the Files handoff.
	 */
	rootPath?: string;
};

export interface GitHost {
	listRepos(): Promise<GitRepoRef[]>;
	addRepo(input: Omit<GitRepoRef, 'id'>): Promise<GitRepoRef>;
	removeRepo(id: string): Promise<void>;
	/** Look up a saved ref, then `snapshotRepo`. */
	snapshot(repoId: string): Promise<GitSnapshot>;
	/** Look up a saved ref, then `subscribeRepo`. */
	subscribe(repoId: string, onChange: (snap: GitSnapshot) => void): () => void;
	snapshotRepo(repo: GitRepoRef): Promise<GitSnapshot>;
	subscribeRepo(repo: GitRepoRef, onChange: (snap: GitSnapshot) => void): () => void;
	/** `git.init` for a local working tree (`repo.path` = VFS id or Node dir). */
	initLocal(repoPath: string): Promise<void>;
	/** Committed blob at `rev` (ref, abbreviated oid, or SHA), not live worktree bytes. */
	readBlobAt(repo: GitRepoRef, rev: string, filepath: string): Promise<Uint8Array>;
	/**
	 * Stage `paths` and commit them. Returns the new commit oid.
	 *
	 * Local backend only — monitor repos are read-only here, and this rejects
	 * rather than silently doing nothing.
	 */
	commit(repoId: string, opts: CommitInput): Promise<string>;
	commitRepo(repo: GitRepoRef, opts: CommitInput): Promise<string>;
}

export type CommitInput = {
	message: string;
	/** Paths to stage, relative to the working tree root. Must be non-empty. */
	paths: string[];
	author: GitAuthor;
};
