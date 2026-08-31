/**
 * Dedicated worker that owns the heavy half of an extract.
 *
 * It opens its own VfsService against the same IndexedDB database and OPFS
 * root as the page, so a job names ids rather than shipping bytes: the
 * archive is read from OPFS here, inflated here, and members are written
 * here. Only progress goes back.
 *
 * Two measurements shape this:
 *  - inflate is ~12x faster here than on the main thread (fflate's async
 *    main-thread path, not the codec)
 *  - writes use sync access handles, which exist in dedicated workers ONLY
 *
 * The worker is the single owner of OPFS *writes* while a job runs. Sync
 * handles lock their file, so a concurrent main-thread write to the same blob
 * would fail loudly rather than corrupt — but the page is expected to route
 * writes here rather than race them.
 */
import { createVfs, type VfsService } from '../vfs.js';
import { createSyncOpfsStore, canUseSyncAccessHandles } from './syncOpfs.js';
import { createLocalExplorerDriver } from '../ui/localExplorerDriver.js';
import { runArchiveJob } from '../ui/archiveOps.js';
import type { ExtractJobRequest, WorkerRequest, WorkerResponse } from './protocol.js';
import type { EngineId as CompressEngineId } from '@shared-packages/compress';

const ctx = self as unknown as {
	onmessage: ((e: MessageEvent) => void) | null;
	postMessage: (msg: WorkerResponse) => void;
};

const services = new Map<string, VfsService>();
const cancels = new Map<string, AbortController>();

function vfsFor(dbName: string, opfsRoot: string): VfsService {
	const key = `${dbName}::${opfsRoot}`;
	let vfs = services.get(key);
	if (!vfs) {
		vfs = createVfs({
			dbName,
			opfs: createSyncOpfsStore(opfsRoot),
			// The page negotiates persistence; a second request here is noise.
			requestPersist: false
		});
		services.set(key, vfs);
	}
	return vfs;
}

/**
 * Run `fn` while holding a Web Lock, so the browser treats this context as
 * busy.
 *
 * Chrome and Edge suspend backgrounded tabs, which stalls a long extract in a
 * tab the user has switched away from — the common case, since the whole point
 * of moving extraction into a worker was that you could go and do something
 * else. A held Web Lock is the documented signal that work is in flight; it is
 * what the SQLite-on-OPFS implementations use for the same reason.
 *
 * The lock name is per-job so two jobs do not serialise behind each other:
 * this is a liveness hint, not mutual exclusion. If the API is missing the
 * work still runs — losing suspension protection is not a reason to fail.
 */
async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
	const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
	if (!locks?.request) return fn();
	// request() rejects with the callback's throw. Retrying fn() after that
	// re-runs extract (rename-on-conflict duplicates packed members). Only
	// fall back when the lock API itself failed before fn started.
	let started = false;
	try {
		return await locks.request(`vfs-job:${jobId}`, () => {
			started = true;
			return fn();
		});
	} catch (e) {
		if (started) throw e;
		return fn();
	}
}

async function runExtract(req: ExtractJobRequest): Promise<void> {
	const vfs = vfsFor(req.dbName, req.opfsRoot);
	await vfs.ready();
	const driver = createLocalExplorerDriver(vfs);
	await driver.ready();

	const controller = new AbortController();
	cancels.set(req.jobId, controller);

	const entries = [];
	for (const id of req.entryIds) {
		const node = await vfs.get(id);
		if (!node) throw new Error(`Archive is gone: ${id}`);
		// Do not take the caller's word for it: casting a folder to kind:'file'
		// here would send it into readEntryBytes and fail somewhere less
		// obvious than this line.
		if (node.kind !== 'file') {
			throw new Error(`Not a file, cannot extract: ${node.name}`);
		}
		entries.push({
			id: node.id,
			parentId: node.parentId,
			kind: 'file' as const,
			name: node.name,
			size: node.size,
			contentType: node.contentType
		});
	}

	try {
		await runArchiveJob({
			kind: req.kind,
			entries,
			driver,
			dest: 'same',
			destParentId: req.destParentId,
			title: req.title,
			compressEngineId: req.compressEngineId as CompressEngineId,
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: req.password,
			skipSystemFiles: req.skipSystemFiles,
			wrapInSubfolder: req.wrapInSubfolder,
			useHost: false,
			signal: controller.signal,
			onProgress: (ev) => ctx.postMessage({ type: 'progress', jobId: req.jobId, ev })
		});
		ctx.postMessage({ type: 'done', jobId: req.jobId, written: 0 });
	} finally {
		cancels.delete(req.jobId);
	}
}

ctx.onmessage = (e: MessageEvent) => {
	const msg = e.data as WorkerRequest;
	if (!msg || typeof msg !== 'object') return;

	if (msg.type === 'ping') {
		ctx.postMessage({ type: 'ready' });
		return;
	}

	if (msg.type === 'cancel') {
		cancels.get(msg.jobId)?.abort();
		return;
	}

	if (msg.type === 'extract') {
		// A duplicate id would leave two jobs sharing one AbortController, so
		// cancelling either would stop both and the second 'done' would settle
		// an already-settled caller.
		if (cancels.has(msg.jobId)) {
			ctx.postMessage({
				type: 'failed',
				jobId: msg.jobId,
				error: `Job ${msg.jobId} is already running`
			});
			return;
		}
		if (!canUseSyncAccessHandles()) {
			ctx.postMessage({
				type: 'failed',
				jobId: msg.jobId,
				error: 'Sync access handles are unavailable in this worker'
			});
			return;
		}
		void withJobLock(msg.jobId, () => runExtract(msg)).catch((err: unknown) => {
			ctx.postMessage({
				type: 'failed',
				jobId: msg.jobId,
				error: err instanceof Error ? err.message : String(err),
				errorName: err instanceof Error ? err.name : undefined
			});
		});
	}
};
