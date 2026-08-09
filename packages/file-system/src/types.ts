/** File type registry ids. */
export type FileTypeId = 'skch' | 'ob3d' | 'vrec' | 'image' | 'json' | 'unknown';

export type VfsNodeKind = 'folder' | 'file';

export interface FileTypeDef {
	id: FileTypeId;
	extension: string;
	mime: string;
	label: string;
	icon?: string;
	schemaVersion: number;
}

export interface VfsNode {
	id: string;
	parentId: string | null;
	name: string;
	kind: VfsNodeKind;
	fileType?: FileTypeId;
	size?: number;
	createdAt: number;
	updatedAt: number;
	/** Monotonic CAS token; starts at 1. */
	generation: number;
	blobId?: string;
	meta?: Record<string, unknown>;
	/** null/undefined = active; set = in trash */
	deletedAt?: number | null;
	/** Parent at trash time (hierarchy preserved via parentId). */
	trashParentId?: string | null;
	contentType?: string;
}

export interface BlobRef {
	id: string;
	opfsPath: string;
	byteLength: number;
	createdAt: number;
	contentType?: string;
	pendingPromote?: boolean;
	pending?: boolean;
}

export interface AppDraft {
	id: string;
	appId: string;
	updatedAt: number;
	payload: unknown;
	openFileId?: string;
	/** CAS token for open file when draft tracks it */
	openFileGeneration?: number;
}

export interface WriteFileInput {
	parentId: string | null;
	name: string;
	/** Structured object (JSON), Blob, ArrayBuffer, or Uint8Array */
	body: unknown;
	fileType?: FileTypeId;
	contentType?: string;
	meta?: Record<string, unknown>;
	/** Deterministic id for migrations */
	id?: string;
	onConflict?: 'rename' | 'error';
}

export type UpdateFileOpts =
	| { expectedGeneration: number; force?: false }
	| { force: true; expectedGeneration?: never };

export interface VfsListOptions {
	parentId: string | null;
	/** Actionable types for UI mask — does NOT filter list results. */
	accept?: FileTypeId[];
	includeDeleted?: boolean;
	/** Trash roots only (deleted, parent not deleted). */
	trashOnly?: boolean;
	sort?: 'name' | 'updatedAt';
}

export interface MigrationStep {
	id: string;
	run: (ctx: MigrationContext) => Promise<MigrationStepResult>;
}

export interface MigrationContext {
	vfs: import('./vfs.js').VfsService;
	force?: boolean;
}

export interface MigrationStepResult {
	migrated: number;
	skipped: number;
	errors?: string[];
}

export interface MigrationReport {
	steps: Array<{
		id: string;
		status: 'complete' | 'skipped' | 'failed';
		result?: MigrationStepResult;
		error?: string;
	}>;
}

export interface GcReport {
	orphanOpfsRemoved: number;
	orphanBlobRefsRemoved: number;
	unreferencedBlobsRemoved: number;
	tmpPartialsRemoved: number;
	expiredLeasesRemoved: number;
}

export type VfsErrorCode =
	| 'NOT_FOUND'
	| 'NOT_A_FILE'
	| 'NOT_A_FOLDER'
	| 'INVALID_NAME'
	| 'NAME_CONFLICT'
	| 'GENERATION_CONFLICT'
	| 'TRASH_STATE'
	| 'HAS_CHILDREN'
	| 'CYCLE'
	| 'OPFS_UNAVAILABLE'
	| 'OPFS_IO'
	| 'QUOTA_EXCEEDED'
	| 'API_MISUSE'
	| 'MIGRATION_IN_PROGRESS';

export class VfsError extends Error {
	readonly code: VfsErrorCode;
	readonly details?: Record<string, unknown>;

	constructor(code: VfsErrorCode, message?: string, details?: Record<string, unknown>) {
		super(message ?? code);
		this.name = 'VfsError';
		this.code = code;
		this.details = details;
	}
}
