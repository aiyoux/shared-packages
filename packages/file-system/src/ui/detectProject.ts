import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';

/**
 * True when `folderId` looks like a git working tree: a child named `.git`
 * (folder or file — some listings expose `.git` as a file).
 */
export async function detectProject(
	driver: ExplorerDriver,
	folderId: ExplorerEntryId | null
): Promise<boolean> {
	const { entries } = await driver.list({ parentId: folderId });
	return entries.some((e) => e.name === '.git');
}
