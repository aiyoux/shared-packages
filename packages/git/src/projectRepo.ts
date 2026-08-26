import {
	findProjectRoot,
	type ExplorerDriver,
	type ExplorerEntryId
} from '@shared-packages/file-system/ui';
import { toAbsolutePath } from '@shared-packages/file-system/monitor';
import type { GitHost, GitRepoRef } from './types.js';

export type ProjectBackendHint = {
	backend: 'local' | 'monitor';
	rootPath?: string;
	profileId?: string;
	baseUrl?: string;
};

/** A resolved working tree: the ref to bind, and the explorer id it sits at. */
export type ProjectRootResolution = {
	input: Omit<GitRepoRef, 'id'>;
	/** Explorer id of the working tree — `null` when it is the explorer root. */
	folderId: ExplorerEntryId | null;
};

async function folderName(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	fallback: string
): Promise<string> {
	if (folderId == null) return fallback;
	try {
		const chain = await driver.getPath(folderId);
		return chain[chain.length - 1]?.name || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Nearest git working tree for a folder click (`.git` on self or an ancestor),
 * with the explorer id it was found at so callers can root a tree there.
 *
 * Local `path` is the explorer folder id. Monitor `path` is the absolute host path.
 */
export async function resolveProjectRoot(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	hint: ProjectBackendHint
): Promise<ProjectRootResolution | null> {
	const hit = await findProjectRoot(driver, folderId);
	if (!hit.found) return null;
	if (hint.backend === 'monitor') {
		const path = toAbsolutePath(hint.rootPath || '/', hit.id);
		if (!path) return null;
		const label = await folderName(driver, hit.id, path.split('/').filter(Boolean).pop() || 'Project');
		return {
			input: {
				label,
				backend: 'monitor',
				path,
				...(hint.profileId ? { profileId: hint.profileId } : {}),
				...(hint.baseUrl ? { baseUrl: hint.baseUrl } : {}),
				...(hint.rootPath ? { rootPath: hint.rootPath } : {})
			},
			folderId: hit.id
		};
	}
	// Local `path` IS the explorer id, so the explorer root cannot be a repo here.
	if (hit.id == null) return null;
	return {
		input: { label: await folderName(driver, hit.id, 'Project'), backend: 'local', path: hit.id },
		folderId: hit.id
	};
}

/** `resolveProjectRoot` without the explorer id — the ref to bind, or null. */
export async function repoInputFromFolder(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	hint: ProjectBackendHint
): Promise<Omit<GitRepoRef, 'id'> | null> {
	return (await resolveProjectRoot(driver, folderId, hint))?.input ?? null;
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

/**
 * If `folderId` (or an ancestor) is already a git working tree, bind that
 * repo. Does not `initLocal` — callers that want to create a repo do that
 * separately.
 */
export async function bindRepoIfProject(
	host: GitHost,
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<GitRepoRef | null> {
	const input = await repoInputFromFolder(driver, folderId, { backend: 'local' });
	if (!input) return null;
	return bindProjectRepo(host, input);
}
