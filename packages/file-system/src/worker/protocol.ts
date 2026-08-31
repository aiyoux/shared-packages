/**
 * Wire protocol for the VFS write worker.
 *
 * The point of this design is what is NOT here: no file bytes cross the
 * boundary in either direction. A job names an archive already in the VFS,
 * the worker reads it from OPFS itself, writes members back to OPFS itself,
 * and sends progress. An earlier attempt that shipped members over
 * postMessage was slower than staying on the main thread.
 */
import type { ArchiveWriteProgress } from '../ui/archiveOps.js';

export type WorkerJobKind = 'decompress' | 'decrypt';

export type ExtractJobRequest = {
	type: 'extract';
	jobId: string;
	/** Dexie database the worker should open — it builds its own VfsService. */
	dbName: string;
	/** OPFS root directory name, so worker and main thread agree on storage. */
	opfsRoot: string;
	kind: WorkerJobKind;
	/** Archive node ids, already in the VFS. */
	entryIds: string[];
	destParentId: string | null;
	title: string;
	password: string;
	skipSystemFiles: boolean;
	wrapInSubfolder: boolean;
	compressEngineId: string;
	/** Store members in shared packs. Off by default. */
	pack?: boolean;
	/** Accumulate phase timers and log `[vfs-profile]` when the job ends. */
	profile?: boolean;
};

export type WorkerRequest =
	| ExtractJobRequest
	| { type: 'cancel'; jobId: string }
	| { type: 'ping' };

export type WorkerResponse =
	| { type: 'ready' }
	| { type: 'progress'; jobId: string; ev: ArchiveWriteProgress }
	| { type: 'done'; jobId: string; written: number }
	| { type: 'failed'; jobId: string; error: string; errorName?: string };
