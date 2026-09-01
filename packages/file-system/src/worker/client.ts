/**
 * Main-thread client for the VFS write worker.
 *
 * Offers one thing: run an extract in the worker instead of here. A job names
 * ids, so no file bytes cross the boundary — the worker reads the archive from
 * OPFS and writes members back itself. Only progress returns.
 *
 * Returns null when a worker cannot be used (no Worker, no OPFS, blocked by
 * CSP, or the worker reports it cannot open sync access handles). Callers must
 * fall back to the main-thread path in that case; nothing here is required for
 * correctness, only for speed.
 */
import type { ArchiveWriteProgress } from '../ui/archiveOps.js';
import type { ExtractJobRequest, WorkerRequest, WorkerResponse } from './protocol.js';

export type ExtractOnWorkerOpts = {
	onProgress?: (ev: ArchiveWriteProgress) => void;
	signal?: AbortSignal;
};

type Pending = {
	resolve: () => void;
	reject: (err: Error) => void;
	onProgress?: (ev: ArchiveWriteProgress) => void;
};

export class VfsWorkerClient {
	private readonly worker: Worker;
	private readonly pending = new Map<string, Pending>();
	private disposed = false;

	constructor(worker: Worker) {
		this.worker = worker;
		worker.onmessage = (e: MessageEvent) => this.receive(e.data as WorkerResponse);
		// A worker that dies mid-job must not leave callers hanging, and must
		// not pin getVfsWorkerClient() to a dead instance for the rest of the
		// page (same class of bug as the catalog worker singleton).
		worker.onerror = () => {
			this.failAll(new Error('VFS worker crashed'));
			this.disposed = true;
			dropCachedClient(this);
		};
	}

	private receive(msg: WorkerResponse): void {
		if (!msg || typeof msg !== 'object') return;
		if (msg.type === 'progress') {
			this.pending.get(msg.jobId)?.onProgress?.(msg.ev);
			return;
		}
		if (msg.type === 'done') {
			const p = this.pending.get(msg.jobId);
			this.pending.delete(msg.jobId);
			p?.resolve();
			return;
		}
		if (msg.type === 'failed') {
			const p = this.pending.get(msg.jobId);
			this.pending.delete(msg.jobId);
			const err = new Error(msg.error);
			if (msg.errorName) err.name = msg.errorName;
			p?.reject(err);
		}
	}

	private failAll(err: Error): void {
		for (const [, p] of this.pending) p.reject(err);
		this.pending.clear();
	}

	/** Run an extract in the worker. Rejects with AbortError when cancelled. */
	async extract(
		req: Omit<ExtractJobRequest, 'type' | 'jobId'>,
		opts?: ExtractOnWorkerOpts
	): Promise<void> {
		if (this.disposed) return Promise.reject(new Error('VFS worker disposed'));
		const jobId = `wx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const { connectCatalogPort } = await import('../catalogEngine.js');
		return new Promise<void>((resolve, reject) => {
			this.pending.set(jobId, { resolve, reject, onProgress: opts?.onProgress });
			if (opts?.signal) {
				opts.signal.addEventListener(
					'abort',
					() => {
						this.send({ type: 'cancel', jobId });
						const e = new Error('Cancelled');
						e.name = 'AbortError';
						const p = this.pending.get(jobId);
						this.pending.delete(jobId);
						p?.reject(e);
					},
					{ once: true }
				);
			}
			const catalogPort = connectCatalogPort(req.dbName);
			if (catalogPort) {
				this.worker.postMessage({ type: 'extract', jobId, ...req }, [catalogPort]);
			} else {
				this.send({ type: 'extract', jobId, ...req });
			}
		});
	}

	private send(msg: WorkerRequest): void {
		this.worker.postMessage(msg);
	}

	dispose(): void {
		this.disposed = true;
		this.failAll(new Error('VFS worker disposed'));
		this.worker.terminate();
	}
}

let cached: VfsWorkerClient | null | undefined;
/** Why the worker is unavailable, for a UI that must explain the slow path. */
let unavailableReason: string | null = null;

function dropCachedClient(client: VfsWorkerClient): void {
	if (cached === client) cached = undefined;
}

/**
 * Why `getVfsWorkerClient()` returned null, or null if a worker is available.
 *
 * Exposed so a caller can TELL the user what it lost rather than degrading
 * quietly — a silent fallback is indistinguishable from an unexplained
 * slowdown, which is how performance regressions survive.
 */
export function vfsWorkerUnavailableReason(): string | null {
	return unavailableReason;
}

/**
 * The page's VFS worker, or null where one cannot run.
 *
 * Memoized: one worker per page is enough, and each carries its own Dexie
 * connection and OPFS handles.
 */
export function getVfsWorkerClient(): VfsWorkerClient | null {
	if (cached !== undefined) return cached;
	if (typeof Worker === 'undefined') {
		unavailableReason = 'This browser does not support background workers.';
		cached = null;
		return cached;
	}
	if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
		unavailableReason = 'Origin private file storage is unavailable here.';
		cached = null;
		return cached;
	}
	try {
		const worker = new Worker(new URL('./vfs.worker.js', import.meta.url), {
			type: 'module',
			name: 'vfs-write'
		});
		cached = new VfsWorkerClient(worker);
		unavailableReason = null;
	} catch (e) {
		// Keep the reason: "could not start" and "not supported" need different
		// answers from whoever reads the message.
		unavailableReason =
			e instanceof Error
				? `Background worker could not start: ${e.message}`
				: 'Background worker could not start.';
		cached = null;
	}
	return cached;
}

/** Tests: drop the memoized worker so the next call re-detects. */
export function resetVfsWorkerForTests(): void {
	cached?.dispose();
	cached = undefined;
	unavailableReason = null;
}
