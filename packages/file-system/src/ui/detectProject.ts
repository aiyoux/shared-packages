import type { ExplorerDriver, ExplorerEntry, ExplorerEntryId } from './explorerDriver.js';

export const PROJECT_PACK_META = 'projectPack';

/**
 * What counts as "already a project".
 *
 * `any` (default) — a `.git` child, a `.project.json` child, or project metadata.
 * `git` — a `.git` child ONLY.
 * `project` — `.project.json` or project metadata, NOT `.git`.
 *
 * The Git app needs `git`: a folder can be a project (`.project.json` or
 * project metadata) with no repo, and under `any` its Init button would be
 * hidden with no way to create one.
 *
 * Files splits the two: "Inside Project" uses `project`, "Git enabled" uses
 * `git`, so a plain git folder is not labelled a project.
 */
export type ProjectMarker = 'any' | 'git' | 'project';

function isProjectMeta(meta?: Record<string, unknown>): boolean {
	if (!meta) return false;
	return Boolean(
		meta[PROJECT_PACK_META] ||
		meta.projectPack ||
		meta.isProject ||
		meta.project
	);
}

function wantsMeta(marker: ProjectMarker): boolean {
	return marker === 'any' || marker === 'project';
}

function wantsGit(marker: ProjectMarker): boolean {
	return marker === 'any' || marker === 'git';
}

async function isProjectFolder(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	chainEntries?: ExplorerEntry[],
	marker: ProjectMarker = 'any'
): Promise<boolean> {
	if (wantsMeta(marker) && folderId != null && chainEntries) {
		const matched = chainEntries.find((e) => e.id === folderId);
		if (matched && isProjectMeta(matched.meta)) return true;
	}
	try {
		const { entries } = await driver.list({ parentId: folderId });
		return entries.some(
			(e) =>
				(wantsGit(marker) && e.name === '.git') ||
				(wantsMeta(marker) && e.name === '.project.json')
		);
	} catch {
		return false;
	}
}

/** Self, then parents from `getPath`, then explorer root. Deduped. */
async function projectCandidates(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<{ candidates: Array<ExplorerEntryId | null>; chain: ExplorerEntry[] }> {
	const seen = new Set<string>();
	const out: Array<ExplorerEntryId | null> = [];
	let chain: ExplorerEntry[] = [];
	const push = (id: ExplorerEntryId | null) => {
		const key = id ?? '';
		if (seen.has(key)) return;
		seen.add(key);
		out.push(id);
	};

	push(folderId);
	if (folderId != null) {
		try {
			chain = await driver.getPath(folderId);
			for (let i = chain.length - 1; i >= 0; i--) {
				const e = chain[i]!;
				push(e.id);
				if (e.parentId !== undefined) push(e.parentId);
			}
		} catch {
			/* cannot walk parents — children-only plus explorer root below */
		}
	}
	push(null);
	return { candidates: out, chain };
}

/**
 * Result of walking for a project marker (.git child, .project.json, or projectPack metadata).
 *
 * `found: false` — no project.
 * `found: true, id: null` — the explorer root (`parentId` null) is the project.
 * `found: true, id: string` — that folder contains `.git` or is marked as a project.
 *
 * `id === null` is not “not a project”; use `found`. `detectProject` is the
 * boolean for UI (FileExplorer / Open project).
 */
export type ProjectRootHit = {
	found: boolean;
	id: ExplorerEntryId | null;
};

/**
 * Nearest folder (self, then ancestors) that is a project.
 *
 * Drivers that cannot walk parents (`getPath` empty/throws) only check
 * `folderId` and the explorer root.
 */
export async function findProjectRoot(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	marker: ProjectMarker = 'any'
): Promise<ProjectRootHit> {
	const { candidates, chain } = await projectCandidates(driver, folderId);
	for (const id of candidates) {
		try {
			if (await isProjectFolder(driver, id, chain, marker)) return { found: true, id };
		} catch {
			continue;
		}
	}
	return { found: false, id: null };
}

/**
 * True when `folderId` or an ancestor looks like a project: a child
 * named `.git` / `.project.json`, or metadata marking it as a project.
 */
export async function detectProject(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null,
	marker: ProjectMarker = 'any'
): Promise<boolean> {
	return (await findProjectRoot(driver, folderId, marker)).found;
}

/**
 * What THIS folder is — not an ancestor. Used for folder icons in the listing
 * and tree, so a nested plain folder inside a project stays a plain folder.
 *
 * `project` — `.project.json` child or project metadata.
 * `git` — `.git` child.
 * `project-git` — both.
 */
export type FolderMark = 'plain' | 'project' | 'git' | 'project-git';

export function folderMarkFromKids(
	meta: Record<string, unknown> | undefined,
	kids: Array<Pick<ExplorerEntry, 'name'>>
): FolderMark {
	const project = isProjectMeta(meta) || kids.some((e) => e.name === '.project.json');
	const git = kids.some((e) => e.name === '.git');
	if (project && git) return 'project-git';
	if (project) return 'project';
	if (git) return 'git';
	return 'plain';
}

/** Classify a folder by listing its immediate children once. */
export async function classifyFolder(
	driver: ExplorerDriver,
	folder: Pick<ExplorerEntry, 'id' | 'kind' | 'meta'>
): Promise<FolderMark> {
	if (folder.kind === 'file') return 'plain';
	try {
		const { entries } = await driver.list({ parentId: folder.id });
		return folderMarkFromKids(folder.meta, entries);
	} catch {
		return isProjectMeta(folder.meta) ? 'project' : 'plain';
	}
}

