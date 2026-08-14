/**
 * Dual-pane copy-across bridge (does not flip local caps).
 *
 * Lives in the shared package so both the hub `/tools/files` page and the
 * Connections `FileTransferPanel` (via {@link DualPaneExplorer}) single-source it.
 * @see docs/design/dnd-inmem-copy.md
 */
import { generateId } from '../id.js';
import { upsertProgress } from '../transferRegistry.js';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	isLocalClass,
	isRemoteClass,
	type ExplorerDriver,
	type ExplorerEntry
} from './explorerDriver.js';

export type CopyAcrossErrorCode =
	| 'COPY_ACROSS_REMOTE_REMOTE'
	| 'COPY_ACROSS_FOLDER_REMOTE'
	| 'COPY_ACROSS_DEST_NO_FOLDERS'
	| 'COPY_ACROSS_NO_SELECTION'
	| 'COPY_ACROSS_NO_SOURCE'
	| 'COPY_ACROSS_NO_DEST'
	| 'COPY_ACROSS_DEST_READONLY'
	| 'COPY_ACROSS_TRUNCATED'
	| 'EXPLORER_TOO_LARGE'
	| string;

export class CopyAcrossError extends Error {
	readonly code: CopyAcrossErrorCode;
	constructor(code: CopyAcrossErrorCode, message?: string) {
		super(message ?? code);
		this.code = code;
		this.name = 'CopyAcrossError';
	}
}

/** Native DnD type FileExplorer writes; DualPaneExplorer reads it on pane drop. */
export const FE_EXPLORER_IDS_MIME = 'application/x-fe-explorer-ids';

export function parseExplorerDragIds(raw: string): string[] {
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}

export function idsFromExplorerDataTransfer(dt: DataTransfer | null | undefined): string[] {
	if (!dt) return [];
	let raw = '';
	try {
		raw = dt.getData(FE_EXPLORER_IDS_MIME) || dt.getData('text/plain') || '';
	} catch {
		raw = '';
	}
	return parseExplorerDragIds(raw);
}

/** Drop on a folder row copies into that folder; otherwise dest's open folder. */
/**
 * Row ids for a dragstart that bubbled from a FileExplorer row. Chrome often
 * leaves getData() empty until drop, so DualPane / CM send-zone use this.
 */
export function idsFromExplorerDragTarget(target: EventTarget | null): string[] {
	const el = target as {
		closest?: (sel: string) => {
			getAttribute(name: string): string | null;
			closest(sel: string): {
				querySelectorAll(sel: string): Iterable<{ getAttribute(name: string): string | null }>;
			} | null;
		} | null;
	} | null;
	if (!el || typeof el.closest !== 'function') return [];
	const row = el.closest('[data-fe-row-id]');
	if (!row) return [];
	const draggedId = row.getAttribute('data-fe-row-id');
	if (!draggedId) return [];
	const list = row.closest('[data-testid="fe-list"]');
	if (list) {
		const selected: string[] = [];
		for (const n of list.querySelectorAll('.fe-row.selected[data-fe-row-id]')) {
			const id = n.getAttribute('data-fe-row-id');
			if (id) selected.push(id);
		}
		if (selected.length > 0 && selected.includes(draggedId)) return selected;
	}
	return [draggedId];
}

export function destParentFromDropEvent(
	e: { target: EventTarget | null },
	fallback: string | null
): string | null {
	const el = e.target as { closest?: (sel: string) => { getAttribute(name: string): string | null } | null } | null;
	if (!el || typeof el.closest !== 'function') return fallback;
	const row = el.closest('[data-fe-row-id]');
	if (row?.getAttribute('data-fe-kind') === 'folder') {
		return row.getAttribute('data-fe-row-id');
	}
	return fallback;
}

export type CopyAcrossArgs = {
	sourceDriver: ExplorerDriver;
	destDriver: ExplorerDriver;
	/** Selected entry ids on source (files and/or folders). */
	selectedIds: string[];
	/** Entries currently listed on source (for kind/name lookup). */
	sourceEntries: ExplorerEntry[];
	/** Destination open folder id (null = root). */
	destParentId: string | null;
};

function entryById(entries: ExplorerEntry[], id: string): ExplorerEntry | undefined {
	return entries.find((e) => e.id === id);
}

/**
 * Visibility: dual-pane active AND at least one local-class pane.
 */
export function canShowCopyAcross(leftId: string, rightId: string): boolean {
	return isLocalClass(leftId) || isLocalClass(rightId);
}

export function assertCopyAcrossAllowed(sourceId: string, destId: string): void {
	if (isRemoteClass(sourceId) && isRemoteClass(destId)) {
		throw new CopyAcrossError(
			'COPY_ACROSS_REMOTE_REMOTE',
			'Cannot copy between two remote connections'
		);
	}
}

/**
 * Copy selected items from source driver into dest open folder.
 */
export async function copyAcross(args: CopyAcrossArgs): Promise<number> {
	const { sourceDriver, destDriver, selectedIds, sourceEntries, destParentId } = args;
	assertCopyAcrossAllowed(sourceDriver.id, destDriver.id);

	if (!selectedIds.length) {
		throw new CopyAcrossError('COPY_ACROSS_NO_SELECTION', 'Select file(s) to copy');
	}

	const selected = selectedIds
		.map((id) => entryById(sourceEntries, id))
		.filter((e): e is ExplorerEntry => !!e);

	const hasFolder = selected.some((e) => e.kind === 'folder');
	const bothLocal = isLocalClass(sourceDriver.id) && isLocalClass(destDriver.id);
	if (hasFolder && !bothLocal) {
		throw new CopyAcrossError(
			'COPY_ACROSS_FOLDER_REMOTE',
			'Folder copy is only supported between local panes'
		);
	}
	// memory is a flat list (no folders) — block folder copy into it even though
	// it is local-class.
	if (hasFolder && !destDriver.capabilities.supportsMkdir) {
		throw new CopyAcrossError(
			'COPY_ACROSS_DEST_NO_FOLDERS',
			'Destination cannot hold folders'
		);
	}

	let count = 0;
	for (const entry of selected) {
		if (entry.kind === 'folder') {
			count += await copyFolderTree(sourceDriver, destDriver, entry, destParentId);
		} else {
			await copyFile(sourceDriver, destDriver, entry, destParentId);
			count += 1;
		}
	}
	return count;
}

function reportCopy(
	id: string,
	entry: ExplorerEntry,
	patch: { transferred: number; size?: number; done?: boolean; status?: 'active' | 'done' | 'failed'; error?: string }
): void {
	const size = patch.size ?? entry.size ?? patch.transferred;
	upsertProgress({
		id,
		name: entry.name,
		size,
		transferred: patch.transferred,
		direction: 'copying',
		done: patch.done === true,
		status: patch.status ?? (patch.done ? 'done' : 'active'),
		error: patch.error
	});
}

async function copyFile(
	source: ExplorerDriver,
	dest: ExplorerDriver,
	entry: ExplorerEntry,
	destParentId: string | null
): Promise<void> {
	// Pre-check size before loading into memory to avoid OOM
	if (entry.size != null && entry.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
		throw new CopyAcrossError('EXPLORER_TOO_LARGE', 'File exceeds download size cap');
	}
	const opId = generateId('copy');
	const known = entry.size ?? 0;
	reportCopy(opId, entry, { transferred: 0, size: known, status: 'active' });
	try {
		let blob: Blob;
		if (source.download) {
			blob = await source.download(entry.id, {
				onProgress: (transferred, total) => {
					reportCopy(opId, entry, {
						transferred,
						size: total ?? known ?? transferred,
						status: 'active'
					});
				}
			});
		} else if (source.readBlob) {
			blob = await source.readBlob(entry.id);
		} else {
			throw new CopyAcrossError('COPY_ACROSS_NO_SOURCE', 'Source cannot read file bytes');
		}
		if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
			throw new CopyAcrossError('EXPLORER_TOO_LARGE', 'File exceeds download size cap');
		}
		reportCopy(opId, entry, { transferred: blob.size, size: blob.size, status: 'active' });
		const file = new File([blob], entry.name, {
			type: entry.contentType || blob.type || 'application/octet-stream'
		});

		const noWrite = !dest.writeFile && !dest.upload;
		const readonlyDest = dest.id === 'monitor' || (dest.id === 'peer-fs' && noWrite);
		if (readonlyDest || noWrite) {
			throw new CopyAcrossError(
				readonlyDest ? 'COPY_ACROSS_DEST_READONLY' : 'COPY_ACROSS_NO_DEST',
				dest.id === 'monitor'
					? 'Monitor is read-only. Copy from monitor into This computer, In memory, or the browser library.'
					: readonlyDest
						? 'That shared location is read-only'
						: 'Destination cannot accept file writes'
			);
		}

		if (dest.writeFile) {
			await dest.writeFile(destParentId, file);
		} else if (dest.upload) {
			await dest.upload(destParentId, file, {
				onProgress: (pct) => {
					reportCopy(opId, entry, {
						transferred: Math.round(blob.size * Math.min(1, Math.max(0, pct))),
						size: blob.size,
						status: 'active'
					});
				}
			});
		}
		reportCopy(opId, entry, { transferred: blob.size, size: blob.size, done: true, status: 'done' });
	} catch (e) {
		reportCopy(opId, entry, {
			transferred: 0,
			size: known,
			done: true,
			status: 'failed',
			error: e instanceof Error ? e.message : String(e)
		});
		throw e;
	}
}

async function copyFolderTree(
	source: ExplorerDriver,
	dest: ExplorerDriver,
	folder: ExplorerEntry,
	destParentId: string | null
): Promise<number> {
	if (!dest.mkdir) {
		throw new CopyAcrossError('COPY_ACROSS_NO_SOURCE', 'Destination cannot create folders');
	}
	const created = await dest.mkdir(destParentId, folder.name);
	let count = 1;
	const listed = await source.list({ parentId: folder.id });
	if (listed.truncated) {
		throw new CopyAcrossError(
			'COPY_ACROSS_TRUNCATED',
			'Folder has more than 2000 items; copy aborted so nothing is silently dropped'
		);
	}
	const { entries } = listed;
	for (const child of entries) {
		if (child.kind === 'folder') {
			count += await copyFolderTree(source, dest, child, created.id);
		} else {
			await copyFile(source, dest, child, created.id);
			count += 1;
		}
	}
	return count;
}
