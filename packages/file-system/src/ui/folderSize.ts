/**
 * On-demand size of a folder. Listings do not carry a folder total, so the
 * preview asks for one instead of showing "Unknown size".
 */
import { formatBytes } from '@shared-packages/ui/files';
import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

/** Stop a runaway walk (a symlink loop, or a disk tree the user did not mean to scan). */
export const FOLDER_SIZE_MAX_ENTRIES = 20_000;

export type FolderMeasure = {
	bytes: number;
	files: number;
	folders: number;
	/** Files whose listing row had no size. */
	unknown: number;
	/** A list was capped, or the walk stopped at {@link FOLDER_SIZE_MAX_ENTRIES}. */
	truncated: boolean;
};

export function formatFolderMeasure(measure: FolderMeasure): string {
	const size = formatBytes(measure.bytes);
	const head = measure.truncated ? `${size} or more` : size;
	if (measure.unknown > 0) return `${head} + ${measure.unknown} unknown`;
	return head;
}

function abortError(): DOMException {
	return new DOMException('The operation was aborted.', 'AbortError');
}

function isDirectChild(entry: ExplorerEntry, parentId: string | null): boolean {
	// A driver that omits parentId is scoped by the list call. One that sets
	// it (including the flat memory list, where every row is a root) is not.
	if (entry.parentId === undefined) return true;
	return entry.parentId === parentId;
}

/**
 * Sum file sizes under `rootId`. Nested folders are walked. Bytes are the
 * sizes already on each row — this does not read file bodies.
 * `null` is the driver root (the listing whose parent id is null).
 */
export async function measureFolderSize(
	driver: ExplorerDriver,
	rootId: string | null,
	opts?: { signal?: AbortSignal; maxEntries?: number }
): Promise<FolderMeasure> {
	const signal = opts?.signal;
	const maxEntries = opts?.maxEntries ?? FOLDER_SIZE_MAX_ENTRIES;
	const seen = new Set<string>();
	const queue: Array<string | null> = [rootId];
	let bytes = 0;
	let files = 0;
	let folders = 0;
	let unknown = 0;
	let truncated = false;

	while (queue.length) {
		if (signal?.aborted) throw abortError();
		const parentId = queue.shift()!;
		let entries: ExplorerEntry[];
		if (driver.listAll) {
			entries = await driver.listAll({ parentId });
		} else {
			const result = await driver.list({ parentId });
			entries = result.entries;
			if (result.truncated) truncated = true;
		}
		if (signal?.aborted) throw abortError();
		for (const child of entries) {
			if (!isDirectChild(child, parentId)) continue;
			if (child.id === rootId || seen.has(child.id)) continue;
			seen.add(child.id);
			if (seen.size > maxEntries) {
				truncated = true;
				return { bytes, files, folders, unknown, truncated };
			}
			if (child.kind === 'folder') {
				folders += 1;
				queue.push(child.id);
			} else {
				files += 1;
				if (typeof child.size === 'number' && Number.isFinite(child.size)) bytes += child.size;
				else unknown += 1;
			}
		}
	}
	return { bytes, files, folders, unknown, truncated };
}
