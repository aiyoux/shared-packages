import git from 'isomorphic-git';
import type { GitSnapshot } from './types.js';

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
	try {
		const matrix = await git.statusMatrix({ fs, dir });
		dirty = matrix.some(([, head, workdir, stage]) => head !== workdir || workdir !== stage);
	} catch {
		dirty = false;
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

	return { status: { branch, dirty }, log };
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
