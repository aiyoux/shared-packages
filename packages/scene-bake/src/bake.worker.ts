/// <reference lib="webworker" />
import * as THREE from 'three';
import { CENTER, MeshBVH } from 'three-mesh-bvh';
import { computeVisibleSpans, type HiddenLineRequest } from './hiddenLine.js';
import { loadHiddenLineWasm, type HiddenLineWasmApi } from './hiddenLineWasm.js';

/** Off-main-thread hidden line removal for the 3D → 2D bake.
 *
 *  The occlusion pass is ~75% of an encode (BVH raycasts plus the vector math
 *  inside them) and is pure computation — no DOM — so it runs here and leaves
 *  the UI thread free. The scene clone and the SVG render stay on the main
 *  thread because both need the document.
 *
 *  Geometry is addressed by id and cached here across encodes, so a camera
 *  orbit sends only matrices: the vertex buffers and their BVHs are uploaded
 *  once. Building a BVH reorders the index buffer, which is exactly why the
 *  worker keeps its own copy rather than sharing one.
 *
 *  Engine (D16): mesh-bvh builds MeshBVH only; wasm-experimental uploads to
 *  Rust BVH only — never both for the same job. */

export interface BakeGeometryUpload {
    geometryId: number;
    positionVersion: number;
    indexVersion: number;
    position: Float32Array;
    index: Uint32Array | null;
}

/** Occlusion engine for the worker job. */
export type OcclusionEngine = 'mesh-bvh' | 'wasm-experimental';

export interface BakeWorkerRequest {
    jobId: number;
    request: HiddenLineRequest;
    meshUploads: BakeGeometryUpload[];
    edgeUploads: BakeGeometryUpload[];
    /** Defaults to mesh-bvh. */
    engine?: OcclusionEngine;
}

export type BakeWorkerResponse =
    | { jobId: number; ok: true; spans: Float32Array[]; evictedMeshIds: number[]; evictedEdgeIds: number[] }
    | { jobId: number; ok: false; error: string; evictedMeshIds: number[]; evictedEdgeIds: number[] };

interface CachedMesh {
    boundsTree: MeshBVH;
    positionVersion: number;
    indexVersion: number;
}

interface CachedEdge {
    position: Float32Array;
    positionVersion: number;
}

const MAX_CACHED_GEOMETRIES = 64;

const meshCache = new Map<number, CachedMesh>();
const edgeCache = new Map<number, CachedEdge>();

function trim<T>(cache: Map<number, T>, evicted: number[]) {
    while (cache.size > MAX_CACHED_GEOMETRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) return;
        cache.delete(oldest.value);
        evicted.push(oldest.value);
    }
}

function applyMeshUploads(uploads: BakeGeometryUpload[], evicted: number[]) {
    for (const upload of uploads) {
        const cached = meshCache.get(upload.geometryId);
        if (
            cached
            && cached.positionVersion === upload.positionVersion
            && cached.indexVersion === upload.indexVersion
        ) {
            continue;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(upload.position, 3));
        if (upload.index) {
            geometry.setIndex(new THREE.BufferAttribute(upload.index, 1));
        }

        meshCache.set(upload.geometryId, {
            boundsTree: new MeshBVH(geometry, { strategy: CENTER, verbose: false }),
            positionVersion: upload.positionVersion,
            indexVersion: upload.indexVersion
        });
    }
    trim(meshCache, evicted);
}

function applyEdgeUploads(uploads: BakeGeometryUpload[], evicted: number[]) {
    for (const upload of uploads) {
        const cached = edgeCache.get(upload.geometryId);
        if (cached && cached.positionVersion === upload.positionVersion) continue;

        edgeCache.set(upload.geometryId, {
            position: upload.position,
            positionVersion: upload.positionVersion
        });
    }
    trim(edgeCache, evicted);
}

function applyWasmMeshUploads(
    wasm: HiddenLineWasmApi,
    uploads: BakeGeometryUpload[],
    evicted: number[],
    tracked: Map<number, string>,
) {
    for (const upload of uploads) {
        const key = `${upload.positionVersion}:${upload.indexVersion}`;
        if (tracked.get(upload.geometryId) === key) continue;
        const index = upload.index ?? new Uint32Array(0);
        wasm.hl_upload_mesh(
            upload.geometryId,
            upload.position,
            index,
            upload.positionVersion,
            upload.indexVersion,
        );
        tracked.set(upload.geometryId, key);
    }
    // FIFO: if over cap, evict oldest from tracked + WASM
    while (tracked.size > MAX_CACHED_GEOMETRIES) {
        const oldest = tracked.keys().next();
        if (oldest.done) break;
        const id = oldest.value;
        tracked.delete(id);
        wasm.hl_evict_mesh(id);
        evicted.push(id);
    }
}

function applyWasmEdgeUploads(
    wasm: HiddenLineWasmApi,
    uploads: BakeGeometryUpload[],
    evicted: number[],
    tracked: Map<number, string>,
) {
    for (const upload of uploads) {
        const key = `${upload.positionVersion}:0`;
        if (tracked.get(upload.geometryId) === key) continue;
        wasm.hl_upload_edge(upload.geometryId, upload.position, upload.positionVersion);
        tracked.set(upload.geometryId, key);
    }
    while (tracked.size > MAX_CACHED_GEOMETRIES) {
        const oldest = tracked.keys().next();
        if (oldest.done) break;
        const id = oldest.value;
        tracked.delete(id);
        wasm.hl_evict_edge(id);
        evicted.push(id);
    }
}

// WASM-side version mirrors (worker-local; separate from MeshBVH maps).
const wasmMeshTracked = new Map<number, string>();
const wasmEdgeTracked = new Map<number, string>();

self.onmessage = (event: MessageEvent<BakeWorkerRequest>) => {
    const message = event.data;
    void handleJob(message);
};

async function handleJob(message: BakeWorkerRequest) {
    const evictedMeshIds: number[] = [];
    const evictedEdgeIds: number[] = [];
    const engine: OcclusionEngine = message.engine ?? 'mesh-bvh';

    try {
        let spans: Float32Array[];

        if (engine === 'wasm-experimental') {
            const wasm = await loadHiddenLineWasm();
            if (!wasm) {
                throw new Error('hidden_line WASM unavailable');
            }
            applyWasmMeshUploads(wasm, message.meshUploads, evictedMeshIds, wasmMeshTracked);
            applyWasmEdgeUploads(wasm, message.edgeUploads, evictedEdgeIds, wasmEdgeTracked);
            spans = wasm.compute_visible_spans(JSON.stringify(message.request));
            // Ensure each span is a standalone Float32Array for transfer.
            spans = spans.map((s) =>
                s instanceof Float32Array ? s : new Float32Array(s as ArrayLike<number>),
            );
        } else {
            // mesh-bvh path — unchanged from pre-A3
            applyMeshUploads(message.meshUploads, evictedMeshIds);
            applyEdgeUploads(message.edgeUploads, evictedEdgeIds);
            spans = computeVisibleSpans(
                message.request,
                (geometryId) => meshCache.get(geometryId)?.boundsTree ?? null,
                (geometryId) => edgeCache.get(geometryId)?.position ?? null,
            );
        }

        const response: BakeWorkerResponse = {
            jobId: message.jobId,
            ok: true,
            spans,
            evictedMeshIds,
            evictedEdgeIds,
        };
        (self as unknown as Worker).postMessage(
            response,
            spans.map((span) => span.buffer),
        );
    } catch (err) {
        const response: BakeWorkerResponse = {
            jobId: message.jobId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            evictedMeshIds,
            evictedEdgeIds,
        };
        (self as unknown as Worker).postMessage(response);
    }
}
