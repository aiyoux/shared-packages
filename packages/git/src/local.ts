import git from 'isomorphic-git';
import type { CommitInput, GitChange, GitSnapshot } from './types.js';

/** isomorphic-git's node/browser fs shape (`fs.promises` or LightningFS). */
export type GitFs = Parameters<typeof git.init>[0]['fs'];

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

/**
 * Stage `paths` and commit them.
 *
 * A path that no longer exists is removed from the index rather than added —
 * `git.add` on a missing file throws, so a delete would otherwise make the
 * whole commit fail with a confusing ENOENT.
 */
export async function localCommit(fs: GitFs, dir: string, opts: CommitInput): Promise<string> {
	const message = opts.message.trim();
	if (!message) throw new Error('A commit needs a message.');
	if (!opts.paths.length) throw new Error('Select at least one file to commit.');

	for (const filepath of opts.paths) {
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

	return git.commit({ fs, dir, message, author: opts.author });
}
