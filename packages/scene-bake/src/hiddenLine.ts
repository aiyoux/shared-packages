import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * Hidden line removal, extracted from the bake encoder so it can run either
 * inline or inside a worker without the two drifting apart.
 *
 * Everything here is plain data — typed arrays and numbers, no THREE.Object3D
 * and no DOM — so a whole request survives `postMessage`. Geometry itself is
 * addressed by id and resolved through callbacks, letting each side keep its
 * own cache of BVHs and edge buffers instead of shipping them every encode.
 */

const HIDDEN_LINE_SAMPLE_DISTANCE = 0.04;
const MAX_HOMOGENEOUS_SAMPLE_DISTANCE = 0.24;
const OCCLUSION_EPSILON = 0.005;

export interface HiddenLineMeshData {
    geometryId: number;
    /** Column-major world matrix, as produced by Matrix4.elements. */
    matrixWorld: number[];
    /** World-space bounding sphere, used to skip meshes the ray misses. */
    sphereCenter: [number, number, number];
    sphereRadius: number;
    /** Identity of the parent object, for the self-occlusion opt-out. */
    groupId: number;
}

export interface HiddenLineEdgeData {
    geometryId: number;
    matrixWorld: number[];
    ignoreSelfOcclusion: boolean;
    groupId: number;
}

export interface HiddenLineRequest {
    cameraPosition: [number, number, number];
    cameraForward: [number, number, number];
    isOrtho: boolean;
    meshes: HiddenLineMeshData[];
    edges: HiddenLineEdgeData[];
}

export type BoundsTreeResolver = (geometryId: number) => MeshBVH | null;
export type EdgePositionsResolver = (geometryId: number) => Float32Array | null;

interface PreparedMesh {
    data: HiddenLineMeshData;
    boundsTree: MeshBVH;
    matrixWorld: THREE.Matrix4;
    worldToLocal: THREE.Matrix4;
    sphereCenter: THREE.Vector3;
    sphereRadius: number;
}

const meshCouldOccludePoint = (
    mesh: PreparedMesh,
    cameraPosition: THREE.Vector3,
    rayDirection: THREE.Vector3,
    distanceToPoint: number,
    toCenter: THREE.Vector3
) => {
    toCenter.subVectors(mesh.sphereCenter, cameraPosition);
    const alongRay = toCenter.dot(rayDirection);
    const radius = mesh.sphereRadius;
    if (alongRay < -radius || alongRay > distanceToPoint + radius) return false;

    const perpendicularDistanceSq = Math.max(0, toCenter.lengthSq() - alongRay * alongRay);
    return perpendicularDistanceSq <= radius * radius;
};

/**
 * For each edge buffer, returns the local-space positions of the spans that
 * survive occlusion — the same layout as the input (vertex pairs), just with
 * hidden stretches removed and partially hidden edges split.
 */
export function computeVisibleSpans(
    request: HiddenLineRequest,
    getBoundsTree: BoundsTreeResolver,
    getEdgePositions: EdgePositionsResolver
): Float32Array[] {
    const preparedMeshes: PreparedMesh[] = [];
    for (const data of request.meshes) {
        const boundsTree = getBoundsTree(data.geometryId);
        if (!boundsTree) continue;

        const matrixWorld = new THREE.Matrix4().fromArray(data.matrixWorld);
        preparedMeshes.push({
            data,
            boundsTree,
            matrixWorld,
            worldToLocal: matrixWorld.clone().invert(),
            sphereCenter: new THREE.Vector3().fromArray(data.sphereCenter),
            sphereRadius: data.sphereRadius
        });
    }

    const worldRay = new THREE.Ray();
    const localRay = new THREE.Ray();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const spanA = new THREE.Vector3();
    const spanB = new THREE.Vector3();
    const invMat = new THREE.Matrix4();
    const edgeMatrix = new THREE.Matrix4();
    const localMid = new THREE.Vector3();
    const worldHitPoint = new THREE.Vector3();
    const toMeshCenter = new THREE.Vector3();
    // Flat [start, end, start, end, ...] rather than an array of pairs: one
    // tuple was allocated per visible span of every edge in the scene.
    const visibleIntervals: number[] = [];

    const camPos = new THREE.Vector3().fromArray(request.cameraPosition);
    const cameraForward = new THREE.Vector3().fromArray(request.cameraForward);
    const isOrtho = request.isOrtho;

    const results: Float32Array[] = [];

    // The edge → segment → pointIsOccluded mesh loop → resolveVisibilityInterval
    // nesting below is intentional. Inner loops already early-continue on
    // self-occlusion, sphere miss, and null hit, and resolveVisibilityInterval
    // uses early returns for fine / homogeneous intervals, so the depth is the
    // clearest way to express the per-edge resolution without flattening it into
    // a harder-to-follow state machine. Do not refactor for nesting alone —
    // prefer only local helpers (e.g. span emit) that preserve the capture/hoist
    // strategy and recursion. (INFO-6)
    for (const edge of request.edges) {
        const positions = getEdgePositions(edge.geometryId);
        if (!positions) {
            results.push(new Float32Array(0));
            continue;
        }

        edgeMatrix.fromArray(edge.matrixWorld);
        invMat.copy(edgeMatrix).invert();

        const visiblePositions: number[] = [];
        const vertexCount = Math.floor(positions.length / 3);

        for (let i = 0; i + 1 < vertexCount; i += 2) {
            vA.fromArray(positions, i * 3);
            vB.fromArray(positions, (i + 1) * 3);

            // Convert local vertices to world space
            vA.applyMatrix4(edgeMatrix);
            vB.applyMatrix4(edgeMatrix);

            const dist = vA.distanceTo(vB);
            if (dist < 0.0001) continue;

            const pointIsOccluded = (t: number) => {
                mid.lerpVectors(vA, vB, t);

                // Scratch vectors are hoisted out of this closure: it runs
                // several times per edge across thousands of edges, and two
                // Vector3 allocations here were a measurable share of GC.
                let rayDistance = 0;

                if (isOrtho) {
                    rayDir.copy(cameraForward);
                    rayOrigin.copy(mid).addScaledVector(cameraForward, -1000);
                    rayDistance = 1000;
                } else {
                    rayDir.subVectors(mid, camPos);
                    rayDistance = rayDir.length();
                    rayDir.normalize();
                    rayOrigin.copy(camPos);
                }

                worldRay.origin.copy(rayOrigin);
                worldRay.direction.copy(rayDir);

                for (const mesh of preparedMeshes) {
                    if (edge.ignoreSelfOcclusion && mesh.data.groupId === edge.groupId) {
                        continue;
                    }
                    if (!meshCouldOccludePoint(mesh, rayOrigin, rayDir, rayDistance, toMeshCenter)) {
                        continue;
                    }

                    localRay.copy(worldRay).applyMatrix4(mesh.worldToLocal);
                    localMid.copy(mid).applyMatrix4(mesh.worldToLocal);
                    const localDistanceToMid = localRay.origin.distanceTo(localMid);
                    const hit = mesh.boundsTree.raycastFirst(
                        localRay,
                        THREE.DoubleSide,
                        0,
                        Math.max(0, localDistanceToMid)
                    );

                    if (!hit) continue;

                    worldHitPoint.copy(hit.point).applyMatrix4(mesh.matrixWorld);
                    if (worldHitPoint.distanceTo(rayOrigin) < rayDistance - OCCLUSION_EPSILON) {
                        return true;
                    }
                }

                return false;
            };

            const markVisibleInterval = (t0: number, t1: number) => {
                if (t1 - t0 > 0.000001) {
                    visibleIntervals.push(t0, t1);
                }
            };

            // `knownMidOccluded` carries down a sample the caller already paid
            // for: when the homogeneity check fails, its quartiles are exactly
            // the midpoints of the two halves being recursed into, so
            // re-testing them would repeat the raycast for nothing.
            const resolveVisibilityInterval = (t0: number, t1: number, knownMidOccluded?: boolean) => {
                const intervalDistance = dist * (t1 - t0);
                const midT = (t0 + t1) / 2;
                const midOccluded = knownMidOccluded !== undefined ? knownMidOccluded : pointIsOccluded(midT);

                if (intervalDistance <= HIDDEN_LINE_SAMPLE_DISTANCE) {
                    if (!midOccluded) markVisibleInterval(t0, t1);
                    return;
                }

                if (intervalDistance <= MAX_HOMOGENEOUS_SAMPLE_DISTANCE) {
                    const q1Occluded = pointIsOccluded((t0 + midT) / 2);
                    const q3Occluded = pointIsOccluded((midT + t1) / 2);
                    if (q1Occluded === midOccluded && q3Occluded === midOccluded) {
                        if (!midOccluded) markVisibleInterval(t0, t1);
                        return;
                    }

                    resolveVisibilityInterval(t0, midT, q1Occluded);
                    resolveVisibilityInterval(midT, t1, q3Occluded);
                    return;
                }

                resolveVisibilityInterval(t0, midT);
                resolveVisibilityInterval(midT, t1);
            };

            visibleIntervals.length = 0;
            resolveVisibilityInterval(0, 1);

            /** Flush a merged [start, end] span into the output array. */
            const flushSpan = (t0: number, t1: number) => {
                spanA.lerpVectors(vA, vB, t0);
                spanB.lerpVectors(vA, vB, t1);

                spanA.applyMatrix4(invMat);
                spanB.applyMatrix4(invMat);

                visiblePositions.push(spanA.x, spanA.y, spanA.z);
                visiblePositions.push(spanB.x, spanB.y, spanB.z);
            };

            let mergedStart = -1;
            let mergedEnd = -1;
            for (let interval = 0; interval < visibleIntervals.length; interval += 2) {
                const start = visibleIntervals[interval];
                const end = visibleIntervals[interval + 1];
                if (mergedStart < 0) {
                    mergedStart = start;
                    mergedEnd = end;
                } else if (start <= mergedEnd + 0.000001) {
                    mergedEnd = Math.max(mergedEnd, end);
                } else {
                    flushSpan(mergedStart, mergedEnd);
                    mergedStart = start;
                    mergedEnd = end;
                }
            }

            if (mergedStart >= 0) {
                flushSpan(mergedStart, mergedEnd);
            }
        }

        results.push(new Float32Array(visiblePositions));
    }

    return results;
}
