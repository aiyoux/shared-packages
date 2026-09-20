import git from 'isomorphic-git';
import type {
	FetchResult,
	HttpClient,
	MergeDriverCallback,
	MergeResult,
	PackObjectsResult
} from 'isomorphic-git';
import { diffLines } from './diffLines.js';
import type { CommitInput, GitAuthor, GitChange, GitFileDiff, GitSnapshot } from './types.js';

/** isomorphic-git's node/browser fs shape (`fs.promises` or LightningFS). */
export type GitFs = Parameters<typeof git.init>[0]['fs'];

export type { FetchResult, HttpClient, MergeDriverCallback, MergeResult, PackObjectsResult };

/**
 * Room branches live at `refs/heads/room/<roomId>`. Pass `roomBranchName(id)`
 * as `localBranch`/`localMerge` `ref` / `theirs`.
 */
export const ROOM_BRANCH_PREFIX = 'room/';

export function roomBranchName(roomId: string): string {
	const id = roomId.trim();
	if (!id) throw new Error('A room id is required.');
	return `${ROOM_BRANCH_PREFIX}${id}`;
}

function withFsBuffer<T>(fs: GitFs, run: () => Promise<T>): Promise<T> {
	const buffered = fs as { withBuffer?: <U>(fn: () => Promise<U>) => Promise<U> };
	if (typeof buffered.withBuffer === 'function') return buffered.withBuffer(run);
	return run();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Fold exact-content added/deleted pairs into single `renamed` entries.
 *
 * Only a byte-for-byte match counts — a plain `mv` is unambiguous, a
 * `mv` + edit is not (there's no good, cheap threshold for "similar enough"),
 * so a moved-and-edited file is left as its more honest add+delete pair
 * rather than guessed at. A candidate is only paired when it matches
 * exactly one file on the other side — a duplicate-content ambiguity is
 * left alone rather than picked arbitrarily.
 *
 * Bounded by `added.length * deleted.length`: this reads bytes for every
 * candidate on both sides, which is real cost on top of the `statusMatrix`
 * call `localSnapshot` already does — worth it for a rename-shaped commit,
 * skipped outright once it stops being cheap.
 */
async function detectRenames(fs: GitFs, dir: string, changes: GitChange[]): Promise<GitChange[]> {
	const added = changes.filter((c) => c.status === 'added');
	const deleted = changes.filter((c) => c.status === 'deleted');
	if (!added.length || !deleted.length || added.length * deleted.length > 400) return changes;

	const addedBytes = new Map<string, Uint8Array | null>();
	for (const c of added) addedBytes.set(c.path, await localReadWorkingFile(fs, dir, c.path));
	const deletedBytes = new Map<string, Uint8Array | null>();
	for (const c of deleted) deletedBytes.set(c.path, await localReadHeadOrNull(fs, dir, c.path));

	// Deleted path -> every added path with identical bytes.
	const candidates = new Map<string, string[]>();
	for (const [dPath, dBytes] of deletedBytes) {
		if (!dBytes) continue;
		const hits = [...addedBytes].filter(([, aBytes]) => aBytes && bytesEqual(dBytes, aBytes)).map(([p]) => p);
		if (hits.length) candidates.set(dPath, hits);
	}

	const renamedTo = new Map<string, string>(); // deleted path -> added path
	const claimedAdded = new Set<string>();
	for (const [dPath, hits] of candidates) {
		if (hits.length !== 1) continue; // this deleted file's content isn't unique
		const aPath = hits[0]!;
		const otherClaimants = [...candidates].some(([otherD, otherHits]) => otherD !== dPath && otherHits.includes(aPath));
		if (otherClaimants || claimedAdded.has(aPath)) continue; // this added file's content isn't unique
		renamedTo.set(dPath, aPath);
		claimedAdded.add(aPath);
	}
	if (!renamedTo.size) return changes;

	const fromFor = new Map<string, string>(); // added path -> deleted path
	for (const [dPath, aPath] of renamedTo) fromFor.set(aPath, dPath);

	return changes.flatMap((c) => {
		if (c.status === 'deleted' && renamedTo.has(c.path)) return [];
		if (c.status === 'added' && fromFor.has(c.path)) {
			return [{ path: c.path, status: 'renamed' as const, renamedFrom: fromFor.get(c.path)! }];
		}
		return [c];
	});
}

export async function localSnapshot(fs: GitFs, dir: string): Promise<GitSnapshot> {
	let branch: string | null = null;
	/** `.git` was readable at all — false means this is not a usable repo here. */
	let headReadable = true;
	try {
		const current = await git.currentBranch({ fs, dir, fullname: false });
		branch = current ?? null;
	} catch {
		branch = null;
		headReadable = false;
	}

	let dirty = false;
	let changes: GitChange[] = [];
	try {
		// statusMatrix is ~95% of a snapshot's cost (939ms of 965ms on a
		// 500-file repo), so the change list is derived from the SAME call that
		// already computed `dirty` rather than walking the tree twice.
		const matrix = await git.statusMatrix({ fs, dir });
		dirty = matrix.some(([, head, workdir, stage]) => head !== workdir || workdir !== stage);
		changes = matrix.flatMap(([path, head, workdir, stage]) => {
			if (head === workdir && workdir === stage) return [];
			const status: GitChange['status'] =
				head === 0 ? 'added' : workdir === 0 ? 'deleted' : 'modified';
			return [{ path: String(path), status }];
		});
		changes = await detectRenames(fs, dir, changes);
	} catch (e) {
		// A packed-object OPFS error (short pack, write in flight) must not
		// render as a clean tree. Empty repos still have a readable statusMatrix.
		throw e;
	}

	let log: GitSnapshot['log'] = [];
	try {
		const commits = await git.log({ fs, dir, depth: 50 });
		log = commits.map((c) => {
			const subject = (c.commit.message ?? '').split('\n')[0] ?? '';
			const author = c.commit.author?.name;
			const ts = c.commit.committer?.timestamp;
			const row: GitSnapshot['log'][number] = { sha: c.oid, subject };
			if (author) row.author = author;
			if (typeof ts === 'number') row.committedAt = new Date(ts * 1000).toISOString();
			return row;
		});
	} catch (e) {
		// A fresh repo has a readable HEAD that points at no commit yet — empty,
		// not broken. Anything else (unreadable objects, a `.git` file worktree
		// pointer isomorphic-git cannot follow) must surface as an error rather
		// than render as "No commits".
		if (!headReadable || (await hasCommits(fs, dir))) throw e;
		log = [];
	}

	return { status: { branch, dirty }, log, changes };
}

/** HEAD resolves to a commit — i.e. the repo has at least one commit. */
async function hasCommits(fs: GitFs, dir: string): Promise<boolean> {
	try {
		await git.resolveRef({ fs, dir, ref: 'HEAD' });
		return true;
	} catch {
		return false;
	}
}

export async function localReadBlobAt(
	fs: GitFs,
	dir: string,
	rev: string,
	filepath: string
): Promise<Uint8Array> {
	// readBlob wants an oid; peel refs (HEAD, branch) and abbreviated SHAs first.
	let oid = rev;
	try {
		oid = await git.resolveRef({ fs, dir, ref: rev });
	} catch {
		try {
			oid = await git.expandOid({ fs, dir, oid: rev });
		} catch {
			oid = rev;
		}
	}
	const { blob } = await git.readBlob({ fs, dir, oid, filepath });
	return blob;
}

/** Working-tree bytes for `filepath` under `dir`, or null if it doesn't
 *  exist there (deleted, or never existed). */
export async function localReadWorkingFile(
	fs: GitFs,
	dir: string,
	filepath: string
): Promise<Uint8Array | null> {
	const full = dir === '/' ? `/${filepath}` : `${dir}/${filepath}`;
	try {
		const data = await (
			fs as unknown as { promises: { readFile(p: string): Promise<Uint8Array> } }
		).promises.readFile(full);
		return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
	} catch {
		return null;
	}
}

/** Overwrite the working-tree file at `filepath` — used to discard a
 *  hand-picked subset of its uncommitted changes (`content` built via
 *  `applySelection`). Irreversible; the caller confirms with the user. */
export async function localWriteWorkingFile(
	fs: GitFs,
	dir: string,
	filepath: string,
	content: Uint8Array
): Promise<void> {
	const full = dir === '/' ? `/${filepath}` : `${dir}/${filepath}`;
	await (
		fs as unknown as { promises: { writeFile(p: string, d: Uint8Array): Promise<void> } }
	).promises.writeFile(full, content);
}

/** Remove `filepath` from the working tree, if it's there. A no-op (not an
 *  error) if it's already gone. */
export async function localDeleteWorkingFile(fs: GitFs, dir: string, filepath: string): Promise<void> {
	const full = dir === '/' ? `/${filepath}` : `${dir}/${filepath}`;
	try {
		await (fs as unknown as { promises: { unlink(p: string): Promise<void> } }).promises.unlink(full);
	} catch {
		/* already gone */
	}
}

/** HEAD bytes for `filepath`, or null if HEAD has none (an added/untracked
 *  path, or no HEAD yet — the first commit hasn't happened). */
async function localReadHeadOrNull(fs: GitFs, dir: string, filepath: string): Promise<Uint8Array | null> {
	try {
		return await localReadBlobAt(fs, dir, 'HEAD', filepath);
	} catch {
		return null;
	}
}

/** Discard ALL uncommitted changes to `filepath`: restore its HEAD bytes, or
 *  remove it from disk if HEAD has none. Irreversible; the caller confirms
 *  with the user. */
export async function localDiscardAllFile(fs: GitFs, dir: string, filepath: string): Promise<void> {
	const headBytes = await localReadHeadOrNull(fs, dir, filepath);
	if (headBytes === null) {
		await localDeleteWorkingFile(fs, dir, filepath);
	} else {
		await localWriteWorkingFile(fs, dir, filepath, headBytes);
	}
}

/**
 * Undo a folded rename: restore `renamedFrom`'s HEAD bytes on disk and
 * remove `filepath` — the inverse of what committing that pair records as a
 * rename. Irreversible; the caller confirms with the user.
 *
 * `renamedFrom` always has HEAD bytes by construction (`detectRenames` only
 * pairs against a path git already tracks), but a missing one is handled the
 * same as `localDiscardAllFile` would rather than left half-done.
 */
export async function localDiscardRename(
	fs: GitFs,
	dir: string,
	filepath: string,
	renamedFrom: string
): Promise<void> {
	const headBytes = await localReadHeadOrNull(fs, dir, renamedFrom);
	if (headBytes !== null) {
		await localWriteWorkingFile(fs, dir, renamedFrom, headBytes);
	}
	await localDeleteWorkingFile(fs, dir, filepath);
}

/** First 8000 bytes hold a NUL — the same heuristic git itself uses to call
 *  a blob binary and skip line diffing. */
function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8000);
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
	return false;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** HEAD text vs working-tree text for one changed path, plus the grouped
 *  line diff between them — see `GitFileDiff`. */
export async function localDiffFile(fs: GitFs, dir: string, filepath: string): Promise<GitFileDiff> {
	const oldBytes = await localReadHeadOrNull(fs, dir, filepath);
	const newBytes = await localReadWorkingFile(fs, dir, filepath);
	if ((oldBytes && looksBinary(oldBytes)) || (newBytes && looksBinary(newBytes))) {
		return { oldText: '', newText: '', diff: { kind: 'binary' } };
	}
	const oldText = oldBytes ? decoder.decode(oldBytes) : '';
	const newText = newBytes ? decoder.decode(newBytes) : '';
	return { oldText, newText, diff: diffLines(oldText, newText) };
}

/**
 * Stage `paths` and commit them.
 *
 * A path with a `partial` override is staged as an exact blob via
 * `writeBlob` + `updateIndex` — the working-tree file is never touched or
 * even required to exist, so this also covers "partially undelete" (keep
 * some of a removed file's lines). Every other path follows the whole-file
 * path: a path that no longer exists is removed from the index rather than
 * added — `git.add` on a missing file throws, so a delete would otherwise
 * make the whole commit fail with a confusing ENOENT.
 */
export async function localCommit(fs: GitFs, dir: string, opts: CommitInput): Promise<string> {
	const message = opts.message.trim();
	if (!message) throw new Error('A commit needs a message.');
	if (!opts.paths.length) throw new Error('Select at least one file to commit.');

	const run = async () => {
		for (const filepath of opts.paths) {
			const override = opts.partial?.[filepath];
			if (override) {
				const oid = await git.writeBlob({ fs, dir, blob: override });
				await git.updateIndex({ fs, dir, filepath, oid, mode: 0o100644, add: true });
				continue;
			}
			let exists = true;
			try {
				await (fs as unknown as { promises: { lstat(p: string): Promise<unknown> } }).promises.lstat(
					`/${filepath}`
				);
			} catch {
				exists = false;
			}
			if (exists) await git.add({ fs, dir, filepath });
			else await git.remove({ fs, dir, filepath });
		}

		return git.commit({
			fs,
			dir,
			message,
			author: opts.author,
			committer: opts.committer ?? opts.author
		});
	};
	return withFsBuffer(fs, run);
}

export type LocalBranchOpts = {
	/** Name relative to `refs/heads`. Room branches: `room/<roomId>`. */
	ref: string;
	checkout?: boolean;
	object?: string;
	force?: boolean;
};

export async function localBranch(fs: GitFs, dir: string, opts: LocalBranchOpts): Promise<void> {
	const ref = opts.ref.trim();
	if (!ref) throw new Error('A branch name is required.');
	return withFsBuffer(fs, () =>
		git.branch({
			fs,
			dir,
			ref,
			checkout: opts.checkout,
			object: opts.object,
			force: opts.force
		})
	);
}

export type LocalCheckoutOpts = {
	/** Name relative to `refs/heads`, or a full ref. Room branches: `room/<roomId>`. */
	ref: string;
	force?: boolean;
};

export async function localCheckout(fs: GitFs, dir: string, opts: LocalCheckoutOpts): Promise<void> {
	const ref = opts.ref.trim();
	if (!ref) throw new Error('A branch name is required.');
	return withFsBuffer(fs, () => git.checkout({ fs, dir, ref, force: opts.force }));
}

export type LocalMergeOpts = {
	theirs: string;
	ours?: string;
	author: GitAuthor;
	committer?: GitAuthor;
	message?: string;
	mergeDriver?: MergeDriverCallback;
	abortOnConflict?: boolean;
};

/**
 * Merge `theirs` into `ours` (the current branch if omitted).
 *
 * isomorphic-git updates the branch ref but not the worktree/index. After a
 * clean merge this checks out the new tip so the next snapshot is not dirty
 * with pre-merge bytes. Leaves `abortOnConflict` at isomorphic-git's default
 * (true) unless the caller sets it.
 */
export async function localMerge(fs: GitFs, dir: string, opts: LocalMergeOpts): Promise<MergeResult> {
	const theirs = opts.theirs.trim();
	if (!theirs) throw new Error('Merge needs a theirs ref.');
	const committer = opts.committer ?? opts.author;
	return withFsBuffer(fs, async () => {
		const result = await git.merge({
			fs,
			dir,
			theirs,
			ours: opts.ours,
			author: opts.author,
			committer,
			message: opts.message,
			mergeDriver: opts.mergeDriver,
			abortOnConflict: opts.abortOnConflict
		});
		if (result.oid) {
			const ours =
				opts.ours ?? (await git.currentBranch({ fs, dir, fullname: false })) ?? result.oid;
			await git.checkout({ fs, dir, ref: ours, force: true });
		}
		return result;
	});
}

export type LocalFetchOpts = {
	http: HttpClient;
	url?: string;
	remote?: string;
	ref?: string;
	remoteRef?: string;
	singleBranch?: boolean;
};

export async function localFetch(fs: GitFs, dir: string, opts: LocalFetchOpts): Promise<FetchResult> {
	if (!opts.http) throw new Error('Fetch needs an HTTP client.');
	if (!opts.url && !opts.remote) throw new Error('Fetch needs a url or remote.');
	return withFsBuffer(fs, () =>
		git.fetch({
			fs,
			dir,
			http: opts.http,
			url: opts.url,
			remote: opts.remote,
			ref: opts.ref,
			remoteRef: opts.remoteRef,
			singleBranch: opts.singleBranch
		})
	);
}

export async function localFindMergeBase(fs: GitFs, dir: string, oids: string[]): Promise<string[]> {
	if (!oids.length) throw new Error('findMergeBase needs at least one oid.');
	const found = await git.findMergeBase({ fs, dir, oids });
	return Array.isArray(found) ? found.map(String) : [];
}

export async function localPackObjects(
	fs: GitFs,
	dir: string,
	opts: { oids: string[]; write?: boolean }
): Promise<PackObjectsResult> {
	if (!opts.oids.length) throw new Error('packObjects needs at least one oid.');
	return git.packObjects({ fs, dir, oids: opts.oids, write: opts.write });
}
