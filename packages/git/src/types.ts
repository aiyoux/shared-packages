import type { FileDiff } from './diffLines.js';

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
	status: 'added' | 'modified' | 'deleted' | 'renamed';
	/** Set only for `status: 'renamed'` — the path this one moved from.
	 *  Detected as an exact byte-for-byte match against a deleted path;
	 *  see `detectRenames`. A moved-and-edited file is reported as a plain
	 *  add + delete pair instead (there's no cheap "similar enough" call to
	 *  make), so this is never partial. */
	renamedFrom?: string;
};

export type GitAuthor = { name: string; email: string };

/** HEAD vs working-tree text for one changed path, for the commit panel's
 *  per-file expand. `oldText`/`newText` are the exact texts `diffLines` (and
 *  `applySelection`, at commit time) were run against — the UI must keep
 *  them alongside any line selection it builds, since `DiffLine.opIndex` is
 *  only meaningful for that same pair. */
export type GitFileDiff = {
	oldText: string;
	newText: string;
	diff: FileDiff;
};

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
	subscribe(
		repoId: string,
		onChange: (snap: GitSnapshot) => void,
		onError?: (err: unknown) => void
	): () => void;
	snapshotRepo(repo: GitRepoRef): Promise<GitSnapshot>;
	subscribeRepo(
		repo: GitRepoRef,
		onChange: (snap: GitSnapshot) => void,
		onError?: (err: unknown) => void
	): () => void;
	/** `git.init` for a local working tree (`repo.path` = VFS id or Node dir). */
	initLocal(repoPath: string): Promise<void>;
	/**
	 * Create a git repo at `input.path`. Local is isomorphic-git; monitor is
	 * `POST /v1/git/init` on the daemon. Idempotent if the folder is already a repo.
	 */
	init(input: Pick<GitRepoRef, 'backend' | 'path'> & { baseUrl?: string }): Promise<void>;
	/** Committed blob at `rev` (ref, abbreviated oid, or SHA), not live worktree bytes. */
	readBlobAt(repo: GitRepoRef, rev: string, filepath: string): Promise<Uint8Array>;
	/**
	 * HEAD text vs working-tree text for one changed path, for the commit
	 * panel's expand-to-diff. Local backend only, like `commit`.
	 */
	diffFile(repoId: string, filepath: string): Promise<GitFileDiff>;
	/**
	 * Overwrite the working-tree file at `filepath` with `content` — discards
	 * a hand-picked subset of its uncommitted changes (built via
	 * `applySelection`, the same reconstruction `partial` staging uses, just
	 * written to disk instead of the index). Local backend only.
	 *
	 * Irreversible: the bytes not in `content` are gone with no undo. Callers
	 * must confirm with the user before calling this.
	 */
	discardFile(repoId: string, filepath: string, content: Uint8Array): Promise<void>;
	/**
	 * Discard ALL uncommitted changes to `filepath`: restore its HEAD bytes,
	 * or remove it from disk if HEAD has none (an added/untracked file).
	 * Local backend only. Irreversible, same as `discardFile`.
	 */
	discardAllFile(repoId: string, filepath: string): Promise<void>;
	/**
	 * Undo a folded rename (a `GitChange` with `status: 'renamed'`): restore
	 * `renamedFrom`'s HEAD bytes on disk and remove `filepath`. Local backend
	 * only. Irreversible, same as `discardAllFile` — confirm with the user
	 * first.
	 */
	discardRename(repoId: string, filepath: string, renamedFrom: string): Promise<void>;
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
	/**
	 * Per-path partial-stage override: exact bytes to commit for that path,
	 * in place of its working-tree file — built by `applySelection` from a
	 * hand-edited diff (some hunks/lines deselected). A path in `paths` with
	 * no entry here stages the whole working-tree file, same as today.
	 *
	 * After a commit with an override, the path can still show as changed
	 * (its deselected lines are real, uncommitted edits) — that is the point,
	 * not a bug; it mirrors `git add -p` leaving the rest in the working tree.
	 */
	partial?: Record<string, Uint8Array>;
};
