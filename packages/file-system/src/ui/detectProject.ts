import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';

async function hasGitChild(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<boolean> {
	const { entries } = await driver.list({ parentId: folderId });
	return entries.some((e) => e.name === '.git');
}

/** Self, then parents from `getPath`, then explorer root. Deduped. */
async function projectCandidates(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<Array<ExplorerEntryId | null>> {
	const seen = new Set<string>();
	const out: Array<ExplorerEntryId | null> = [];
	const push = (id: ExplorerEntryId | null) => {
		const key = id ?? '';
		if (seen.has(key)) return;
		seen.add(key);
		out.push(id);
	};

	push(folderId);
	if (folderId == null) return out;

	try {
		const chain = await driver.getPath(folderId);
		for (let i = chain.length - 1; i >= 0; i--) {
			const e = chain[i]!;
			push(e.id);
			if (e.parentId !== undefined) push(e.parentId);
		}
	} catch {
		/* cannot walk parents — children-only plus explorer root below */
	}
	push(null);
	return out;
}

/**
 * Nearest folder (self, then ancestors) that has a `.git` child.
 * `null` means none found, or the project is the explorer root (`parentId` null).
 *
 * Drivers that cannot walk parents (`getPath` empty/throws) only check
 * `folderId` and the explorer root.
 */
export async function findProjectRoot(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<ExplorerEntryId | null> {
	for (const id of await projectCandidates(driver, folderId)) {
		try {
			if (await hasGitChild(driver, id)) return id;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * True when `folderId` or an ancestor looks like a git working tree: a child
 * named `.git` (folder or file — some listings expose `.git` as a file).
 */
export async function detectProject(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<boolean> {
	for (const id of await projectCandidates(driver, folderId)) {
		try {
			if (await hasGitChild(driver, id)) return true;
		} catch {
			continue;
		}
	}
	return false;
}
