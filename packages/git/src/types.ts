export type GitCommit = {
	sha: string;
	subject: string;
	author?: string;
	committedAt?: string;
};

export type GitStatus = { branch: string | null; dirty: boolean };

export type GitSnapshot = { status: GitStatus; log: GitCommit[] };

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
}
