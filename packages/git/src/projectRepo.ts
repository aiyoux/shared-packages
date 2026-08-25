import { findProjectRoot } from '@shared-packages/file-system/ui/detectProject';
import type { ExplorerDriver, ExplorerEntryId } from '@shared-packages/file-system/ui/driver';
import { toAbsolutePath } from '@shared-packages/file-system/monitor';
import type { GitHost, GitRepoRef } from './types.js';

export type ProjectBackendHint = {
	backend: 'local' | 'monitor';
	rootPath?: string;
	profileId?: string;
	baseUrl?: string;
};

/**
 * Nearest git working tree for a folder click: `.git` on self or an ancestor.
 * Local `path` is the explorer folder id. Monitor `path` is the absolute host path.
 */
export async function repoInputFromFolder(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId,
	hint: ProjectBackendHint
): Promise<Omit<GitRepoRef, 'id'> | null> {
	const hit = await findProjectRoot(driver, folderId);
	if (!hit.found) return null;
	if (hint.backend === 'monitor') {
		const path = toAbsolutePath(hint.rootPath || '/', hit.id);
		if (!path) return null;
		let label = path.split('/').filter(Boolean).pop() || 'Project';
		if (hit.id != null) {
			try {
				const chain = await driver.getPath(hit.id);
				const name = chain[chain.length - 1]?.name;
				if (name) label = name;
			} catch {
				/* keep path tail */
			}
		}
		return {
			label,
			backend: 'monitor',
			path,
			...(hint.profileId ? { profileId: hint.profileId } : {}),
			...(hint.baseUrl ? { baseUrl: hint.baseUrl } : {})
		};
	}
	if (hit.id == null) return null;
	let label = 'Project';
	try {
		const chain = await driver.getPath(hit.id);
		const name = chain[chain.length - 1]?.name;
		if (name) label = name;
	} catch {
		/* keep default */
	}
	return { label, backend: 'local', path: hit.id };
}

export function sameProjectRepo(
	a: Pick<GitRepoRef, 'backend' | 'path' | 'profileId'>,
	b: Pick<GitRepoRef, 'backend' | 'path' | 'profileId'>
): boolean {
	if (a.backend !== b.backend || a.path !== b.path) return false;
	if (a.backend === 'monitor' && a.profileId && b.profileId) return a.profileId === b.profileId;
	return true;
}

/** Reuse a saved ref for the same working tree, otherwise add one. */
export async function bindProjectRepo(
	host: GitHost,
	input: Omit<GitRepoRef, 'id'>
): Promise<GitRepoRef> {
	const saved = await host.listRepos();
	const existing = saved.find((r) => sameProjectRepo(r, input));
	if (existing) return existing;
	return host.addRepo(input);
}
