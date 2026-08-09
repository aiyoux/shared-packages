/**
 * Backend-agnostic FileExplorer driver contract.
 * Local wraps VfsService; B2 (hub) implements simple object browser ops.
 * @see docs/design/b2-file-explorer-connection.md
 */
import type { FileTypeId } from '../types.js';

/** Stable id within one driver instance (VFS node id or B2 key/prefix). */
export type ExplorerEntryId = string;

export type ExplorerEntryKind = 'folder' | 'file';

/**
 * Shared open/save target for FileExplorer callbacks.
 * Local rows use real VFS ids; apps re-fetch full VfsNode via VFS if needed.
 */
export type ExplorerOpenTarget = {
	id: ExplorerEntryId;
	kind: ExplorerEntryKind;
	name: string;
	fileType?: FileTypeId;
};

/** UI-facing list row — thinner than VfsNode (no generation/CAS/trash fields). */
export interface ExplorerEntry extends ExplorerOpenTarget {
	parentId: ExplorerEntryId | null;
	size?: number;
	updatedAt?: number;
	contentType?: string;
	/** Backend-private (e.g. B2 fileId). Not for open-with. */
	meta?: Record<string, unknown>;
}

export interface ExplorerCapabilities {
	/** Soft-trash list + restore + empty trash UI. Local: true. B2: false. */
	supportsTrash: boolean;
	/** Soft delete vs hard delete. Local: true. B2: false → confirm + hard delete. */
	supportsSoftDelete: boolean;
	/**
	 * When true, rename/move/copy chrome is shown.
	 * Drivers that only support these for files must still set true and
	 * reject folder ops with a stable error code (B2 v1 policy).
	 */
	supportsRename: boolean;
	supportsMove: boolean;
	supportsCopy: boolean;
	supportsMkdir: boolean;
	/** File input / drop. Local v1: false. B2: true. */
	supportsUpload: boolean;
	/** Explicit download row/toolbar action. Local v1: false. B2: true. */
	supportsDownload: boolean;
}

/**
 * v1 download size cap (bytes). Over → B2_TOO_LARGE / EXPLORER_TOO_LARGE.
 * Defined and exported only from this module.
 */
export const EXPLORER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Hard cap on list entries returned per list() call (all drivers). */
export const EXPLORER_LIST_MAX_ENTRIES = 2000;

export interface ExplorerListOptions {
	parentId: ExplorerEntryId | null;
	/** Only if supportsTrash */
	trashOnly?: boolean;
}

/** Typed list result so FE can show truncation banner. */
export interface ExplorerListResult {
	entries: ExplorerEntry[];
	/** True if more siblings exist beyond entries. */
	truncated: boolean;
}

export interface ExplorerDriver {
	readonly id: 'local' | 'b2' | string;
	readonly capabilities: ExplorerCapabilities;
	ready(): Promise<void>;
	list(opts: ExplorerListOptions): Promise<ExplorerListResult>;
	/**
	 * Breadcrumb chain from effective root to `id` (exclusive of root chrome).
	 * FE: `breadcrumbs = parentId ? await getPath(parentId) : []`.
	 */
	getPath(id: ExplorerEntryId): Promise<ExplorerEntry[]>;
	mkdir?(parentId: ExplorerEntryId | null, name: string): Promise<ExplorerEntry>;
	/** File-only on B2 v1; folders throw B2_FOLDER_OP_UNSUPPORTED. */
	rename?(id: ExplorerEntryId, name: string): Promise<ExplorerEntry>;
	move?(id: ExplorerEntryId, newParentId: ExplorerEntryId | null): Promise<void>;
	copy?(id: ExplorerEntryId, newParentId: ExplorerEntryId | null): Promise<void>;
	/** Soft-trash when supportsSoftDelete; else hard delete (B2: all versions). */
	delete(id: ExplorerEntryId): Promise<void>;
	restore?(id: ExplorerEntryId): Promise<void>;
	permanentDelete?(id: ExplorerEntryId): Promise<void>;
	emptyTrash?(): Promise<void>;
	upload?(
		parentId: ExplorerEntryId | null,
		file: File,
		opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal }
	): Promise<ExplorerEntry>;
	/**
	 * v1: fully buffered Blob.
	 * Must reject if size > EXPLORER_DOWNLOAD_MAX_BYTES.
	 */
	download?(id: ExplorerEntryId): Promise<Blob>;
}

/** Map VfsNode-like fields into ExplorerEntry. */
export function nodeToEntry(n: {
	id: string;
	parentId: string | null;
	name: string;
	kind: 'folder' | 'file';
	fileType?: FileTypeId;
	size?: number;
	updatedAt?: number;
	contentType?: string;
}): ExplorerEntry {
	return {
		id: n.id,
		parentId: n.parentId,
		name: n.name,
		kind: n.kind,
		fileType: n.fileType,
		size: n.size,
		updatedAt: n.updatedAt,
		contentType: n.contentType
	};
}

export function applyListCap(entries: ExplorerEntry[]): ExplorerListResult {
	if (entries.length > EXPLORER_LIST_MAX_ENTRIES) {
		return {
			entries: entries.slice(0, EXPLORER_LIST_MAX_ENTRIES),
			truncated: true
		};
	}
	return { entries, truncated: false };
}
