/**
 * Backend-agnostic FileExplorer driver contract.
 * Local wraps VfsService; B2/rclone implement simple object browser ops.
 * @see docs/design/b2-file-explorer-connection.md
 * @see docs/design/dnd-inmem-copy.md
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
	/** Sibling rank when backend supports order. */
	sortOrder?: number;
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
	/**
	 * When true: show before/after drop lines; same-parent DnD must call reorder().
	 * Local durable + memory: true. B2 + rclone: false.
	 */
	supportsSiblingOrder: boolean;
	/**
	 * Rows are draggable (native HTML5 DnD, ids in `text/plain`) for external
	 * drop targets outside this FileExplorer, even when supportsMove is false.
	 * Does not enable internal move/reorder. Optional; false when omitted.
	 */
	supportsDragOut?: boolean;
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
	readonly id: 'local' | 'memory' | 'b2' | 'rclone' | string;
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
	/**
	 * MANDATORY when supportsSiblingOrder === true.
	 * Same-parent rank write from full sibling set.
	 */
	reorder?(
		id: ExplorerEntryId,
		opts: { beforeId?: ExplorerEntryId | null; afterId?: ExplorerEntryId | null }
	): Promise<void>;
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
	 * `onProgress` is optional; remotes should stream and emit byte counts.
	 */
	download?(
		id: ExplorerEntryId,
		opts?: { onProgress?: (transferred: number, total?: number) => void }
	): Promise<Blob>;
	/** Optional: bytes for copy-across bridge (local/memory). */
	readBlob?(id: ExplorerEntryId): Promise<Blob>;
	/**
	 * Optional write for copy-across into local/memory without enabling upload chrome
	 * (`supportsUpload` may stay false).
	 */
	writeFile?(
		parentId: ExplorerEntryId | null,
		file: File
	): Promise<ExplorerEntry>;
	/**
	 * Optional live-change subscription (e.g. the monitor watch stream).
	 * FileExplorer re-lists the open folder when the listener fires, and
	 * re-subscribes when it navigates.
	 *
	 * `scope.parentId` is the folder on screen. A backend that can watch one
	 * folder should watch that one — far cheaper than a recursive watch of
	 * everything — and each mounted explorer (a dual pane, a tree row) subscribes
	 * its own. Drivers with only a whole-backend signal may ignore it. Returns an
	 * unsubscribe function.
	 */
	subscribeChanges?(
		listener: () => void,
		scope?: { parentId: ExplorerEntryId | null }
	): () => void;
	/**
	 * Optional teardown when the driver is no longer held (close WS, etc.).
	 * Driver caches should call this when the last ref is released.
	 */
	dispose?(): void;
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
	sortOrder?: number;
}): ExplorerEntry {
	return {
		id: n.id,
		parentId: n.parentId,
		name: n.name,
		kind: n.kind,
		fileType: n.fileType,
		size: n.size,
		updatedAt: n.updatedAt,
		contentType: n.contentType,
		sortOrder: n.sortOrder
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

export function isLocalClass(driverId: string): boolean {
	return driverId === 'local' || driverId === 'memory' || driverId === 'disk';
}

export function isRemoteClass(driverId: string): boolean {
	return (
		driverId === 'b2' ||
		driverId === 'rclone' ||
		driverId === 'monitor' ||
		driverId === 'peer-fs'
	);
}
