import type {
    BakeGeometryUpload,
    BakeWorkerRequest,
    BakeWorkerResponse,
    OcclusionEngine,
} from './bake.worker.js';
import { computeVisibleSpans } from './hiddenLine.js';
import type { HiddenLinePreparation } from './svgBake.js';

export type { OcclusionEngine };

/**
 * Main-thread half of the bake worker.
 *
 * Kept out of svgBake.ts because `new Worker(new URL(...))` is a Vite-specific
 * construct and svgBake.ts is imported directly by the Node test suite, which
 * exercises the synchronous encode.
 *
 * Everything degrades to `null`, which tells the caller to encode inline: no
 * worker support (SSR, tests), a worker that failed to load, or a job that
 * threw. The synchronous path stays the source of truth for correctness.
 */

interface PendingJob {
    resolve: (spans: Float32Array[], evictedMeshIds: number[], evictedEdgeIds: number[]) => void;
    reject: (error: Error, evictedMeshIds: number[], evictedEdgeIds: number[]) => void;
}

/**
 * Thrown when a worker job resolves but a newer request from the same consumer
 * has already superseded it. The worker still processes every job serially —
 * this is a client-side single-flight guard so the caller never applies a stale
 * result or pays for the SVG render on top of it. `computeSpansWithFallback`
 * propagates this without falling back to inline encoding, and
 * `encodeSceneToSvgAsync` silences its error log for this case.
 */
export class SupersededError extends Error {
    constructor() {
        super('superseded');
        this.name = 'SupersededError';
    }
}

let worker: Worker | null | undefined;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();

// MED-10: Per-consumer generation tracking for client-side single-flight. When
// a consumer (e.g. a TempBakeNode or the ThreeEditor preview) issues a new
// request, the generation increments; any still-pending job from an older
// generation is rejected with SupersededError when the worker responds. The
// worker itself is unchanged — it still processes jobs serially — but the main
// thread skips applying stale results and the SVG render on top of them.
const consumerGenerations = new Map<string, number>();

// Mirrors the worker's own geometry cache so repeat encodes send matrices
// only. Versions ride along so an in-place vertex edit re-uploads.
// Engine-aware (D21): a single mirror is shared; on engine switch the maps
// are cleared so the next job re-uploads into the active worker cache.
const uploadedMeshes = new Map<number, string>();
const uploadedEdges = new Map<number, string>();
let lastWorkerEngine: OcclusionEngine | undefined;

function failAllPending(reason: string) {
    for (const job of pending.values()) job.reject(new Error(reason), [], []);
    pending.clear();
}

function resetUploadTracking() {
    uploadedMeshes.clear();
    uploadedEdges.clear();
    lastWorkerEngine = undefined;
}

/**
 * Clear version mirrors so the next job re-sends geometry for the active
 * engine cache (D21). Call from setBakeOcclusionEngine and on engine change
 * inside computeSpansOnWorker.
 */
export function invalidateBakeWorkerUploads() {
    uploadedMeshes.clear();
    uploadedEdges.clear();
    lastWorkerEngine = undefined;
}

/**
 * Reset all module state so a fresh worker is constructed on the next call.
 * Exported for tests that need to swap in a fake `Worker` global between
 * cases — the cached `worker` reference would otherwise persist.
 */
export function resetBakeWorkerClient() {
    if (worker && typeof worker.terminate === 'function') {
        try { worker.terminate(); } catch { /* already gone */ }
    }
    worker = undefined;
    failAllPending('reset');
    resetUploadTracking();
    consumerGenerations.clear();
}

/** Lazily create the single reused bake worker, or null when unavailable. */
export function getBakeWorker(): Worker | null {
    if (worker !== undefined) return worker;
    try {
        if (typeof Worker === 'undefined') {
            worker = null;
            return null;
        }

        const workerUrl = new URL('./bake.worker.ts', import.meta.url);
        const created = new Worker(workerUrl, { type: 'module' });
        const workerScript = workerUrl.href;
        created.onmessage = (event: MessageEvent<BakeWorkerResponse>) => {
            const message = event.data;
            const job = pending.get(message.jobId);
            if (!job) return;
            pending.delete(message.jobId);
            if (message.ok) {
                job.resolve(message.spans, message.evictedMeshIds, message.evictedEdgeIds);
            } else {
                job.reject(new Error(message.error), message.evictedMeshIds, message.evictedEdgeIds);
            }
        };
        created.onerror = () => {
            // Drop the dead instance so the next encode can spawn again
            // (same class of bug as the catalog / extract workers). Inline
            // encoding covers in-flight jobs.
            resetUploadTracking();
            failAllPending(`bake worker failed to load (script: ${workerScript})`);
            try {
                created.terminate();
            } catch {
                /* already gone */
            }
            if (worker === created) worker = undefined;
        };
        created.onmessageerror = () => {
            resetUploadTracking();
            failAllPending(`bake worker message failed to deserialize (script: ${workerScript})`);
            try {
                created.terminate();
            } catch {
                /* already gone */
            }
            if (worker === created) worker = undefined;
        };

        worker = created;
        return created;
    } catch (err) {
        worker = null;
        if (import.meta.env.DEV) {
            console.error('[bakeWorkerClient] worker construction failed:', err);
        }
        return null;
    }
}

const uploadKey = (upload: BakeGeometryUpload) => `${upload.positionVersion}:${upload.indexVersion}`;

/**
 * Decide which uploads a job actually needs to send, WITHOUT marking them as
 * seen yet. The caller confirms them as seen only after the worker reports
 * ok:true for that job — so an ok:false (or a throw) causes the next job to
 * re-send, matching the worker's own cache state.
 */
function pickUploads(uploads: BakeGeometryUpload[], seen: Map<number, string>): BakeGeometryUpload[] {
    const needed: BakeGeometryUpload[] = [];
    for (const upload of uploads) {
        const key = uploadKey(upload);
        if (seen.get(upload.geometryId) === key) continue;
        needed.push(upload);
    }
    return needed;
}

/** Mark uploads as seen after the worker accepted them (ok:true). */
function confirmUploads(uploads: BakeGeometryUpload[], seen: Map<number, string>) {
    for (const upload of uploads) {
        seen.set(upload.geometryId, uploadKey(upload));
    }
}

/**
 * Remove ids the worker evicted from its FIFO cache so the main-thread mirror
 * maps stay in sync. Without this, `pickUploads` would skip re-uploading an
 * evicted geometry (version still matches), and the worker's lookup would
 * return null — producing wrong/empty spans with no hard failure.
 */
function clearEvicted(seen: Map<number, string>, evictedIds: number[]) {
    for (const id of evictedIds) {
        seen.delete(id);
    }
}

/**
 * Runs one hidden line pass on the worker. Resolves to null when there is no
 * worker to run it on, so the caller can encode inline instead.
 *
 * Geometry buffers are deliberately NOT transferred — transferring would
 * detach the live scene's vertex arrays on this side. They are structured-
 * cloned instead, and only on the encodes that actually need to send them.
 *
 * When `consumerId` is provided, the client tracks a per-consumer generation
 * token: each new request with the same id increments it, and if a still-
 * pending older job resolves after a newer one has been issued, the older
 * promise rejects with `SupersededError`. The worker still processes every
 * job serially — this is purely a client-side guard so stale results are never
 * applied. Multiple consumers share one worker and keep full concurrency.
 */
export function computeSpansOnWorker(
    prepared: HiddenLinePreparation,
    consumerId?: string,
    /**
     * Occlusion engine for this job. Threaded into the worker message so A3
     * can branch; until A3 the worker always runs MeshBVH regardless of value.
     * Call sites for final bake must pass `'mesh-bvh'` (D15).
     */
    engine: OcclusionEngine = 'mesh-bvh',
): Promise<Float32Array[]> | null {
    const activeWorker = getBakeWorker();
    if (!activeWorker) return null;

    const requestedEngine: OcclusionEngine = engine ?? 'mesh-bvh';
    // D21: engine switch must re-upload into the active worker cache.
    if (lastWorkerEngine !== undefined && lastWorkerEngine !== requestedEngine) {
        uploadedMeshes.clear();
        uploadedEdges.clear();
    }

    const jobId = nextJobId++;
    const meshUploads = pickUploads(prepared.meshUploads, uploadedMeshes);
    const edgeUploads = pickUploads(prepared.edgeUploads, uploadedEdges);

    // MED-10: Stamp this job with the current generation for its consumer. A
    // newer request from the same consumer will have incremented the
    // generation by the time this job's response lands, so the stale result is
    // rejected instead of resolved.
    const generation = consumerId
        ? (consumerGenerations.get(consumerId) ?? 0) + 1
        : undefined;
    if (consumerId && generation !== undefined) {
        consumerGenerations.set(consumerId, generation);
    }

    const message: BakeWorkerRequest = {
        jobId,
        request: prepared.request,
        meshUploads,
        edgeUploads,
        engine: requestedEngine,
    };

    return new Promise<Float32Array[]>((resolve, reject) => {
        pending.set(jobId, {
            resolve: (spans, evictedMeshIds, evictedEdgeIds) => {
                // Drop ids the worker evicted before marking the new uploads —
                // otherwise the mirror maps would claim geometries the worker
                // no longer has.
                clearEvicted(uploadedMeshes, evictedMeshIds);
                clearEvicted(uploadedEdges, evictedEdgeIds);
                // The worker has accepted and cached these geometries — now we
                // can skip re-sending them on the next job.
                confirmUploads(meshUploads, uploadedMeshes);
                confirmUploads(edgeUploads, uploadedEdges);
                lastWorkerEngine = requestedEngine;
                // MED-10: If a newer request from the same consumer has
                // superseded this job, reject with SupersededError so the
                // caller skips applying the stale result. The cache sync above
                // still runs — the worker actually processed this job and
                // cached its geometries, so the mirror maps must stay in sync.
                if (consumerId && generation !== undefined
                    && consumerGenerations.get(consumerId) !== generation) {
                    reject(new SupersededError());
                    return;
                }
                resolve(spans);
            },
            reject: (error, evictedMeshIds, evictedEdgeIds) => {
                // Even on failure the worker may have evicted entries while
                // applying uploads; clear them so the next job re-sends.
                clearEvicted(uploadedMeshes, evictedMeshIds);
                clearEvicted(uploadedEdges, evictedEdgeIds);
                // Clear this job's own upload ids too: the worker may not have
                // cached them (or cached them but the job still failed), so the
                // next job must re-send to be safe. Only the ids that were
                // actually sent (pickUploads output) are cleared — ids whose
                // version already matched were not in the upload set.
                for (const upload of meshUploads) uploadedMeshes.delete(upload.geometryId);
                for (const upload of edgeUploads) uploadedEdges.delete(upload.geometryId);
                reject(error);
            }
        });
        try {
            activeWorker.postMessage(message);
        } catch (err) {
            pending.delete(jobId);
            // The worker never received this geometry, so don't mark it seen.
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

/** Worker pass when one is available, inline pass otherwise — including when
 *  the worker exists but the job itself fails. A bake must always produce its
 *  paths; off-thread is an optimization, not a requirement.
 *
 *  `SupersededError` is propagated without an inline fallback: a superseded job
 *  means a newer request is already in flight for the same consumer, so
 *  encoding inline would waste main-thread time producing a result that will
 *  also be discarded. */
export async function computeSpansWithFallback(
    prepared: HiddenLinePreparation,
    consumerId?: string,
    /**
     * Occlusion engine. Final bake must pass `'mesh-bvh'` always (D15).
     * Preview / temp re-encode may pass bakePrefs.occlusionEngine.
     * Until A3, worker + inline fallback always use MeshBVH.
     */
    engine: OcclusionEngine = 'mesh-bvh',
): Promise<Float32Array[]> {
    const job = computeSpansOnWorker(prepared, consumerId, engine);
    if (job) {
        try {
            return await job;
        } catch (err) {
            if (err instanceof SupersededError) throw err;
            // eslint-disable-next-line no-console
            console.warn('[BAKE] worker hidden line pass failed, encoding inline:', err);
        }
    }

    // Fallback is always MeshBVH on the main thread (D17) — never a second
    // experimental engine attempt.
    return computeVisibleSpans(
        prepared.request,
        geometryId => prepared.boundsTrees.get(geometryId) ?? null,
        geometryId => prepared.edgePositions.get(geometryId) ?? null
    );
}
