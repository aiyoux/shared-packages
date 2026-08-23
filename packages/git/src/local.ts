import git from 'isomorphic-git';
import type { GitSnapshot } from './types.js';

/** isomorphic-git's node/browser fs shape (`fs.promises` or LightningFS). */
export type GitFs = Parameters<typeof git.init>[0]['fs'];

export async function localSnapshot(fs: GitFs, dir: string): Promise<GitSnapshot> {
	let branch: string | null = null;
	try {
		const current = await git.currentBranch({ fs, dir, fullname: false });
		branch = current ?? null;
	} catch {
		branch = null;
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
	} catch {
		log = [];
	}

	return { status: { branch, dirty }, log };
}
