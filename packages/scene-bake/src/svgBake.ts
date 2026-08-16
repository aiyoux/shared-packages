import * as THREE from 'three';
import { SVGRenderer } from 'three/examples/jsm/renderers/SVGRenderer.js';
import { CENTER, MeshBVH } from 'three-mesh-bvh';
import type { CloudParams, PathData, PseudoEffectParams } from './types.js';
import {
    computeVisibleSpans,
    type HiddenLineEdgeData,
    type HiddenLineMeshData,
    type HiddenLineRequest
} from './hiddenLine.js';
import { polygonToPath, difference as clipDifference, generateId } from '@shared-packages/drawing-tools';
import { CLOUD_DEFAULTS, CLOUD_CONTROL_RANGES, getCloudPuffNodes, randomFromSeed } from './primitives.js';

interface BakeMesh {
    mesh: THREE.Mesh;
    sphere: THREE.Sphere;
    boundsTree: MeshBVH;
    geometryId: number;
    positionVersion: number;
    indexVersion: number;
}

/**
 * Stable per-geometry ids. The hidden line pass addresses geometry by id so it
 * can run in a worker, and the ids have to survive across encodes for the
 * worker's own BVH cache to be worth anything.
 */
const geometryIds = new WeakMap<THREE.BufferGeometry, number>();
let nextGeometryId = 1;

function geometryIdFor(geometry: THREE.BufferGeometry): number {
    let id = geometryIds.get(geometry);
    if (id === undefined) {
        id = nextGeometryId++;
        geometryIds.set(geometry, id);
    }
    return id;
}

interface CachedBakeGeometry {
    geometry: THREE.BufferGeometry;
    boundsTree: MeshBVH;
    positionVersion: number;
    indexVersion: number;
}

/**
 * Building a MeshBVH reorders the geometry's index buffer in place, so the
 * bake works off a clone rather than mutating the live scene geometry. That
 * clone and its BVH only depend on the source vertex data, which almost never
 * changes between encodes (orbiting the camera does not touch it), so they are
 * cached per source geometry instead of being rebuilt every time.
 *
 * Keyed weakly so disposed geometry does not leak, and versioned so in-place
 * vertex edits — which Scene.svelte applies by writing straight into the
 * position array and flagging `needsUpdate` — invalidate the cache.
 */
const bakeGeometryCache = new WeakMap<THREE.BufferGeometry, CachedBakeGeometry>();

// Interleaved attributes track their revision on the shared buffer rather
// than on themselves, so read whichever one this geometry actually uses.
function attributeVersion(
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
): number {
    if (!attribute) return -1;
    return 'version' in attribute ? attribute.version : attribute.data.version;
}

function getBakeGeometry(sourceGeometry: THREE.BufferGeometry): CachedBakeGeometry {
    const positionVersion = attributeVersion(sourceGeometry.attributes.position);
    const indexVersion = attributeVersion(sourceGeometry.index ?? undefined);
    const cached = bakeGeometryCache.get(sourceGeometry);

    if (cached && cached.positionVersion === positionVersion && cached.indexVersion === indexVersion) {
        return cached;
    }

    // Dispose the superseded clone + BVH before replacing — long edit sessions
    // otherwise retain multiple full mesh copies per source geometry until GC.
    if (cached) {
        cached.geometry.dispose();
        // MeshBVH has no explicit dispose, but releasing the geometry reference
        // frees its internal buffers.
    }

    const geometry = sourceGeometry.clone();
    if (!geometry.boundingSphere) {
        geometry.computeBoundingSphere();
    }

    const entry: CachedBakeGeometry = {
        geometry,
        boundsTree: new MeshBVH(geometry, { strategy: CENTER, verbose: false }),
        positionVersion,
        indexVersion
    };
    bakeGeometryCache.set(sourceGeometry, entry);

    return entry;
}

export function generatePseudoEffectPaths(
    type: 'sun_glow' | 'light_burst' | 'aura_halo',
    cx: number,
    cy: number,
    radius: number,
    color: string,
    effectParams?: { rayCount?: number; outerRadius?: number; style?: string }
): PathData[] {
    const paths: PathData[] = [];
    const baseColor = color || (type === 'sun_glow' ? '#ffb703' : type === 'light_burst' ? '#ffe600' : '#4cc9f0');
    const rayCount = effectParams?.rayCount ?? (type === 'sun_glow' ? 16 : type === 'light_burst' ? 16 : 12);
    const maxR = radius * (effectParams?.outerRadius ?? 2.5);

    if (type === 'sun_glow') {
        // 1. Soft glowing aura rings (transparent wash line rings)
        for (let i = 3; i >= 1; i--) {
            const r = radius + (maxR - radius) * (i / 4);
            paths.push({
                id: generateId(),
                d: `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(r * 2).toFixed(2)} 0 a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-r * 2).toFixed(2)} 0 Z`,
                fill: 'none',
                stroke: baseColor,
                strokeWidth: 1.5,
                opacity: 0.25 * (1 - i / 4)
            });
        }

        // 2. Cartoony & sketch-style radiating ray lines (clean vector lines)
        const lineRays: string[] = [];
        const angleStep = (Math.PI * 2) / rayCount;
        for (let i = 0; i < rayCount; i++) {
            const angle = i * angleStep;
            const isLong = i % 2 === 0;
            const rInner = radius * 1.1;
            const rOuter = isLong ? maxR * 1.2 : maxR * 0.75;

            const x0 = cx + Math.cos(angle) * rInner;
            const y0 = cy + Math.sin(angle) * rInner;
            const x1 = cx + Math.cos(angle) * rOuter;
            const y1 = cy + Math.sin(angle) * rOuter;

            lineRays.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`);
        }

        paths.push({
            id: generateId(),
            d: lineRays.join(' '),
            fill: 'none',
            stroke: baseColor,
            strokeWidth: 2.5,
            opacity: 0.95
        });

        // 3. Central luminous sun core ring (clean stroke outline)
        paths.push({
            id: generateId(),
            d: `M ${(cx - radius).toFixed(2)} ${cy.toFixed(2)} a ${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 0 ${(radius * 2).toFixed(2)} 0 a ${radius.toFixed(2)} ${radius.toFixed(2)} 0 1 0 ${(-radius * 2).toFixed(2)} 0 Z`,
            fill: 'none',
            stroke: baseColor,
            strokeWidth: 3,
            opacity: 1.0
        });

    } else if (type === 'light_burst') {
        // 1. Soft aura rings (clean transparent stroke rings)
        for (let i = 3; i >= 1; i--) {
            const r = radius * (1 + i * 0.4);
            paths.push({
                id: generateId(),
                d: `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(r * 2).toFixed(2)} 0 a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-r * 2).toFixed(2)} 0 Z`,
                fill: 'none',
                stroke: baseColor,
                strokeWidth: 1.5,
                opacity: 0.3 * (1 - i / 4)
            });
        }

        // 2. Radiating burst ray lines (alternating major/minor clean vector strokes)
        const burstLines: string[] = [];
        const numRays = rayCount;
        const angleStep = (Math.PI * 2) / numRays;
        for (let i = 0; i < numRays; i++) {
            const angle = i * angleStep;
            const isMajor = i % 4 === 0;
            const isMedium = i % 2 === 0;
            const rInner = radius * 0.4;
            const rOuter = isMajor ? maxR * 1.5 : isMedium ? maxR * 1.0 : maxR * 0.6;

            const x0 = cx + Math.cos(angle) * rInner;
            const y0 = cy + Math.sin(angle) * rInner;
            const x1 = cx + Math.cos(angle) * rOuter;
            const y1 = cy + Math.sin(angle) * rOuter;

            burstLines.push(`M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`);
        }

        paths.push({
            id: generateId(),
            d: burstLines.join(' '),
            fill: 'none',
            stroke: baseColor,
            strokeWidth: 2,
            opacity: 0.9
        });

        // 3. Crisp cardinal diamond flare stroke outlines
        const diamondRadius = maxR * 1.6;
        const flareD = [
            `M ${cx.toFixed(2)} ${(cy - diamondRadius).toFixed(2)} L ${(cx + radius * 0.25).toFixed(2)} ${cy.toFixed(2)} L ${cx.toFixed(2)} ${(cy + diamondRadius).toFixed(2)} L ${(cx - radius * 0.25).toFixed(2)} ${cy.toFixed(2)} Z`,
            `M ${(cx - diamondRadius).toFixed(2)} ${cy.toFixed(2)} L ${cx.toFixed(2)} ${(cy - radius * 0.25).toFixed(2)} L ${(cx + diamondRadius).toFixed(2)} ${cy.toFixed(2)} L ${cx.toFixed(2)} ${(cy + radius * 0.25).toFixed(2)} Z`
        ].join(' ');

        paths.push({
            id: generateId(),
            d: flareD,
            fill: 'none',
            stroke: baseColor,
            strokeWidth: 2,
            opacity: 0.95
        });

        // 4. Center luminous star core ring
        paths.push({
            id: generateId(),
            d: `M ${(cx - radius * 0.5).toFixed(2)} ${cy.toFixed(2)} a ${(radius * 0.5).toFixed(2)} ${(radius * 0.5).toFixed(2)} 0 1 0 ${(radius * 1.0).toFixed(2)} 0 a ${(radius * 0.5).toFixed(2)} ${(radius * 0.5).toFixed(2)} 0 1 0 ${(-radius * 1.0).toFixed(2)} 0 Z`,
            fill: 'none',
            stroke: baseColor,
            strokeWidth: 2.5,
            opacity: 1.0
        });

    } else if (type === 'aura_halo') {
        // Concentric aura halo rings
        for (let i = 1; i <= 3; i++) {
            const r = radius * (1 + i * 0.4);
            paths.push({
                id: generateId(),
                d: `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(r * 2).toFixed(2)} 0 a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-r * 2).toFixed(2)} 0 Z`,
                fill: 'none',
                stroke: baseColor,
                strokeWidth: 3 - i * 0.5,
                opacity: 0.8 - i * 0.2
            });
        }
    }

    return paths;
}

function getProjectedSphereRadius(
    worldPos: THREE.Vector3,
    radius3D: number,
    camera: THREE.Camera,
    height: number
): number {
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const distance = Math.max(0.1, worldPos.distanceTo(camPos));

    if ('isPerspectiveCamera' in camera && (camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const persCamera = camera as THREE.PerspectiveCamera;
        const fovRad = (persCamera.fov * Math.PI) / 180;
        return Math.max(6, (radius3D * (height / 2)) / (distance * Math.tan(fovRad / 2)));
    } else if ('isOrthographicCamera' in camera && (camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const orthoCamera = camera as THREE.OrthographicCamera;
        const viewHeight = Math.abs(orthoCamera.top - orthoCamera.bottom) / (orthoCamera.zoom || 1);
        return Math.max(6, (radius3D * height) / Math.max(0.1, viewHeight));
    }
    return Math.max(6, (radius3D * height) / (distance * 0.8));
}

const TWO_PI = Math.PI * 2;

type Disc = { x: number; y: number; r: number };

/**
 * The angular span of circle `subject` that lies inside circle `cover`, or
 * 'all' when the subject is swallowed whole. `null` when nothing is hidden.
 */
function hiddenSpan(subject: Disc, cover: Disc): [number, number] | 'all' | null {
    const dx = cover.x - subject.x;
    const dy = cover.y - subject.y;
    const d = Math.hypot(dx, dy);
    if (d >= subject.r + cover.r) return null;      // disjoint
    if (d + subject.r <= cover.r) return 'all';     // subject entirely covered
    if (d + cover.r <= subject.r) return null;      // cover sits inside — rim untouched
    if (d === 0) return null;
    const cosA = (d * d + subject.r * subject.r - cover.r * cover.r) / (2 * d * subject.r);
    const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
    const mid = Math.atan2(dy, dx);
    return [mid - a, mid + a];
}

/** Hidden spans folded into a sorted, non-overlapping cover of [0, 2PI). */
function mergeIntervals(spans: Array<[number, number]>): Array<[number, number]> {
    const norm: Array<[number, number]> = [];
    for (const [rawStart, rawEnd] of spans) {
        if (rawEnd - rawStart >= TWO_PI) return [[0, TWO_PI]];
        const s = ((rawStart % TWO_PI) + TWO_PI) % TWO_PI;
        const e = ((rawEnd % TWO_PI) + TWO_PI) % TWO_PI;
        if (e < s) { norm.push([s, TWO_PI]); norm.push([0, e]); }
        else norm.push([s, e]);
    }
    norm.sort((a, b) => a[0] - b[0]);

    const merged: Array<[number, number]> = [];
    for (const iv of norm) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
    }
    return merged;
}

function complementIntervals(merged: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let cursor = 0;
    for (const [s, e] of merged) {
        if (s - cursor > 1e-6) out.push([cursor, s]);
        cursor = Math.max(cursor, e);
    }
    if (TWO_PI - cursor > 1e-6) out.push([cursor, TWO_PI]);
    return out;
}

/**
 * A rim arc that straddles angle 0 comes back from `complementIntervals` as two
 * pieces. They are one continuous stroke, so rejoin them before emitting —
 * otherwise the outline is littered with seams the user can erase apart.
 * Only for emission: the second piece runs past 2PI, which the interval maths
 * would misread but `Math.cos`/`Math.sin` handle fine.
 */
function joinWrappedArc(arcs: Array<[number, number]>): Array<[number, number]> {
    if (arcs.length < 2) return arcs;
    const first = arcs[0];
    const last = arcs[arcs.length - 1];
    if (first[0] > 1e-6 || last[1] < TWO_PI - 1e-6) return arcs;
    return [...arcs.slice(1, -1), [last[0], first[1] + TWO_PI]];
}

function intersectIntervals(
    a: Array<[number, number]>,
    b: Array<[number, number]>
): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [aStart, aEnd] of a) {
        for (const [bStart, bEnd] of b) {
            const s = Math.max(aStart, bStart);
            const e = Math.min(aEnd, bEnd);
            if (e - s > 1e-6) out.push([s, e]);
        }
    }
    return out;
}

const onCircle = (c: Disc, t: number) => `${(c.x + c.r * Math.cos(t)).toFixed(2)} ${(c.y + c.r * Math.sin(t)).toFixed(2)}`;

const fullCirclePath = (c: Disc) => {
    const r = c.r.toFixed(2);
    const r2 = (c.r * 2).toFixed(2);
    return `M ${(c.x - c.r).toFixed(2)} ${c.y.toFixed(2)} a ${r} ${r} 0 1 0 ${r2} 0 a ${r} ${r} 0 1 0 -${r2} 0 Z`;
};

const isWholeCircle = (arcs: Array<[number, number]>) =>
    arcs.length === 1 && arcs[0][0] <= 1e-6 && arcs[0][1] >= TWO_PI - 1e-6;

// sweep-flag 1 == increasing angle, matching onCircle's parameterization in
// SVG's y-down space.
const arcCommand = (p: Disc, start: number, end: number) =>
    `M ${onCircle(p, start)} A ${p.r.toFixed(2)} ${p.r.toFixed(2)} 0 ${end - start > Math.PI ? 1 : 0} 1 ${onCircle(p, end)}`;

const inkPath = (d: string, stroke: string, strokeWidth: number, opacity = 1): PathData =>
    ({ id: generateId(), d, fill: 'none', stroke, strokeWidth, opacity });

/** A screen-space triangle of scene geometry, with its distance from the camera. */
export interface CloudOccluder {
    /** x0, y0, x1, y1, x2, y2 in the same screen space as the cloud puffs. */
    points: [number, number, number, number, number, number];
    depth: number;
}

function pointInTriangle(x: number, y: number, t: CloudOccluder['points']): boolean {
    const [x0, y0, x1, y1, x2, y2] = t;
    const d1 = (x - x1) * (y0 - y1) - (x0 - x1) * (y - y1);
    const d2 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
    const d3 = (x - x0) * (y2 - y0) - (x2 - x0) * (y - y0);
    return (d1 <= 0 && d2 <= 0 && d3 <= 0) || (d1 >= 0 && d2 >= 0 && d3 >= 0);
}

/** Is this bit of cloud ink behind a piece of scene geometry? */
const behindGeometry = (x: number, y: number, depth: number, occluders: CloudOccluder[]) =>
    occluders.some(t => t.depth < depth && pointInTriangle(x, y, t.points));

/** Triangles nearer to the camera than `depth` whose bounds touch the disc. */
function occludersOver(p: Disc, depth: number, occluders: CloudOccluder[]): CloudOccluder[] {
    // MED-84: Collect bbox-overlapping triangles then sort nearest-first so a
    // downstream cap (clipDiscFill) keeps the occluders that actually matter.
    const hits: CloudOccluder[] = [];
    for (const t of occluders) {
        if (t.depth >= depth) continue;
        const [x0, y0, x1, y1, x2, y2] = t.points;
        if (Math.min(x0, x1, x2) > p.x + p.r || Math.max(x0, x1, x2) < p.x - p.r) continue;
        if (Math.min(y0, y1, y2) > p.y + p.r || Math.max(y0, y1, y2) < p.y - p.r) continue;
        hits.push(t);
    }
    hits.sort((a, b) => a.depth - b.depth);
    return hits;
}

const DISC_RING_STEPS = 48;
// MED-84: Cap the number of occluder holes fed to polygonClipping.difference.
// When a dense mesh sits over a puff, thousands of holes make the boolean op
// O(n) in triangle count per puff. The nearest triangles dominate the visible
// cut, so capping keeps the result faithful without the blow-up.
const MAX_DISC_HOLES = 64;

/**
 * The puff's body with the nearer geometry cut out of it.
 *
 * The fill has to be clipped by exactly what clips the outline, or the two
 * disagree and the cloud shows up as a white blob with its ink missing where a
 * cube crosses it. Returns `null` when the puff is wholly covered.
 */
function clipDiscFill(p: Disc, covering: CloudOccluder[]): string | null {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < DISC_RING_STEPS; i++) {
        const a = (i / DISC_RING_STEPS) * TWO_PI;
        ring.push([p.x + Math.cos(a) * p.r, p.y + Math.sin(a) * p.r]);
    }
    ring.push(ring[0]);

    // Nearest occluders matter most; cap to keep the boolean op bounded.
    const capped = covering.length > MAX_DISC_HOLES ? covering.slice(0, MAX_DISC_HOLES) : covering;
    const holes = capped.map(t => {
        const [x0, y0, x1, y1, x2, y2] = t.points;
        return [[[x0, y0], [x1, y1], [x2, y2], [x0, y0]]] as [number, number][][];
    });

    let remaining;
    try {
        // MED-33: Use the shared Clipper2/Martinez wrapper instead of raw
        // polygon-clipping — prefers Clipper2 when available with fallback.
        remaining = clipDifference([ring] as [number, number][][], ...holes);
    } catch {
        // Degenerate geometry must never lose the puff altogether.
        return fullCirclePath(p);
    }
    if (!remaining || remaining.length === 0) return null;

    return remaining
        .flatMap(polygon => polygon)
        .filter(subRing => subRing.length > 2)
        .map(subRing => `M ${subRing.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`)
        .join(' ');
}

/**
 * Splits an arc into the stretches that no nearer triangle covers. Sampled
 * rather than solved: an exact circle/triangle intersection buys precision the
 * output does not need, and the sample step is finer than the stroke is wide.
 */
function unoccludedArcRuns(
    p: Disc,
    start: number,
    end: number,
    depth: number,
    occluders: CloudOccluder[]
): Array<[number, number]> {
    if (occluders.length === 0) return [[start, end]];

    const steps = Math.max(6, Math.ceil((end - start) / 0.08));
    const runs: Array<[number, number]> = [];
    let runStart: number | null = null;

    for (let i = 0; i <= steps; i++) {
        const a = start + (end - start) * (i / steps);
        const hidden = behindGeometry(p.x + Math.cos(a) * p.r, p.y + Math.sin(a) * p.r, depth, occluders);
        if (!hidden && runStart === null) runStart = a;
        if (hidden && runStart !== null) {
            if (a - runStart > 0.02) runs.push([runStart, a]);
            runStart = null;
        }
    }
    if (runStart !== null && end - runStart > 0.02) runs.push([runStart, end]);

    return runs;
}

const clampFlavour = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Clamp a flavour value using CLOUD_CONTROL_RANGES as the single source of
 *  truth for min/max. Falls back to 0..1 if a key is somehow missing. */
const clampFlavourKey = (key: keyof typeof CLOUD_CONTROL_RANGES, value: number): number => {
    const range = CLOUD_CONTROL_RANGES[key];
    return range ? clampFlavour(value, range.min, range.max) : clampFlavour(value, 0, 1);
};

type CloudFlavour = {
    style: NonNullable<CloudParams['style']>;
    weight: number;
    taper: number;
    edgeWeight: number;
    shade: number;
    creep: number;
    rimCircles: number;
    gloss: number;
    hatch: number;
    hatchLength: number;
    inkiness: number;
    tickVariety: number;
};

function resolveCloudFlavour(cloudParams?: CloudParams): CloudFlavour {
    return {
        style: cloudParams?.style ?? CLOUD_DEFAULTS.style,
        weight: clampFlavourKey('weight', cloudParams?.weight ?? CLOUD_DEFAULTS.weight),
        taper: clampFlavourKey('taper', cloudParams?.taper ?? CLOUD_DEFAULTS.taper),
        edgeWeight: clampFlavourKey('edgeWeight', cloudParams?.edgeWeight ?? CLOUD_DEFAULTS.edgeWeight),
        shade: clampFlavourKey('shade', cloudParams?.shade ?? CLOUD_DEFAULTS.shade),
        creep: clampFlavourKey('creep', cloudParams?.creep ?? CLOUD_DEFAULTS.creep),
        rimCircles: clampFlavourKey('rimCircles', cloudParams?.rimCircles ?? CLOUD_DEFAULTS.rimCircles),
        gloss: clampFlavourKey('gloss', cloudParams?.gloss ?? CLOUD_DEFAULTS.gloss),
        hatch: clampFlavourKey('hatch', cloudParams?.hatch ?? CLOUD_DEFAULTS.hatch),
        hatchLength: clampFlavourKey('hatchLength', cloudParams?.hatchLength ?? CLOUD_DEFAULTS.hatchLength),
        inkiness: clampFlavourKey('inkiness', cloudParams?.inkiness ?? CLOUD_DEFAULTS.inkiness),
        tickVariety: clampFlavourKey('tickVariety', cloudParams?.tickVariety ?? CLOUD_DEFAULTS.tickVariety)
    };
}

/** Angular window covering the lower half of a disc in SVG's y-down space. */
const LOWER_HALF: Array<[number, number]> = [[0.3, Math.PI - 0.3]];

/** Intersects an arc with a window, allowing for arcs that ran past 2PI. */
function arcWithin(arc: [number, number], window: Array<[number, number]>): Array<[number, number]> {
    const unwrapped: Array<[number, number]> = [
        arc,
        [arc[0] - TWO_PI, arc[1] - TWO_PI],
        [arc[0] + TWO_PI, arc[1] + TWO_PI]
    ];
    return intersectIntervals(unwrapped, window);
}

/**
 * A variable-width arc, drawn as a filled ribbon.
 *
 * An SVG stroke has one width for the whole path, so a line that swells and
 * thins cannot be a stroke at all — it has to be a shape. This walks the arc
 * once, offsetting it outwards and inwards by half the local width, and closes
 * the two boundaries into a single filled path with rounded ends.
 *
 * The obvious alternative — chaining stroked sub-arcs of stepped widths — was
 * what this replaced: the joins show as notches and doubled ink, and the line
 * reads as a row of separate dashes rather than one drawn stroke.
 */
function ribbonArcPath(
    p: Disc,
    from: number,
    to: number,
    widthAt: (t: number) => number
): string {
    const sweep = to - from;
    const samples = Math.min(96, Math.max(8, Math.ceil(Math.abs(sweep) / 0.07)));
    const outer: string[] = [];
    const inner: string[] = [];
    let startHalf = 0;
    let endHalf = 0;

    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const angle = from + sweep * t;
        const half = Math.max(0.3, widthAt(t) / 2);
        if (i === 0) startHalf = half;
        if (i === samples) endHalf = half;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        outer.push(`${(p.x + cos * (p.r + half)).toFixed(2)} ${(p.y + sin * (p.r + half)).toFixed(2)}`);
        inner.push(`${(p.x + cos * (p.r - half)).toFixed(2)} ${(p.y + sin * (p.r - half)).toFixed(2)}`);
    }

    inner.reverse();

    return [
        `M ${outer[0]}`,
        ...outer.slice(1).map(point => `L ${point}`),
        `A ${endHalf.toFixed(2)} ${endHalf.toFixed(2)} 0 0 1 ${inner[0]}`,
        ...inner.slice(1).map(point => `L ${point}`),
        `A ${startHalf.toFixed(2)} ${startHalf.toFixed(2)} 0 0 1 ${outer[0]}`,
        'Z'
    ].join(' ');
}

/**
 * A cloud is overlapping discs, and what makes it read as a cloud is its OUTER
 * silhouette: one scalloped boundary, no circles floating around inside it.
 *
 * Two separate questions have to be answered per puff, and conflating them is
 * what made earlier bakes look like a pile of circles:
 *
 *   1. Is this piece of rim on the silhouette? That is pure 2D — a rim arc is
 *      part of the outline only if NO other disc contains it, regardless of
 *      depth. Depth-sorting alone leaves the front puff's whole circle drawn,
 *      because nothing is in front of it to hide the half buried in the cloud.
 *   2. Is this piece of rim visible from the camera? That IS depth, and it only
 *      matters for the interior lobe lines the detailed styles want.
 *
 * Occlusion is resolved here rather than left to paint order. Each puff emits a
 * fill with no stroke, plus only arcs that survive (1) — and, for the detailed
 * styles, interior arcs that survive (2) while sitting inside the silhouette.
 * Nothing hidden is ever emitted, so erasing a fill cannot surface a buried rim
 * as a stray arc through the middle of the cloud. Fills are emitted first so the
 * ink always sits on top.
 */
export function generateDynamic3DCloudPaths(
    puffs: Array<{ x: number; y: number; r: number; distToCam: number }>,
    color: string,
    cloudParams?: CloudParams,
    occluders: CloudOccluder[] = []
): PathData[] {
    if (puffs.length === 0) return [];

    const strokeColor = color && color !== '#8ecae6' ? color : '#1d3557';
    const {
        style, weight, taper, edgeWeight, creep, rimCircles,
        gloss, shade, hatch, hatchLength, inkiness, tickVariety
    } = resolveCloudFlavour(cloudParams);
    const detailed = style === 'sketch' || style === 'puffy';
    const outlineWidth = 3.8 * weight;

    // Every jittered decision below draws from this one seeded stream, so a bake
    // is reproducible: the same cloud must not reshuffle its ink on re-encode.
    const random = randomFromSeed((cloudParams?.seed ?? CLOUD_DEFAULTS.seed) + 9176);

    // Back to front, so everything after index i in this list is nearer to the
    // camera than puff i.
    const sorted = [...puffs].sort((a, b) => b.distToCam - a.distToCam);

    // `edgeWeight` leans the line weight towards the cloud's extremities, so the
    // outer bumps carry more ink than the stretches near the middle.
    const centreX = sorted.reduce((sum, p) => sum + p.x, 0) / sorted.length;
    const centreY = sorted.reduce((sum, p) => sum + p.y, 0) / sorted.length;
    const reachOut = Math.max(1, ...sorted.map(p => Math.hypot(p.x - centreX, p.y - centreY) + p.r));
    const widthAt = (x: number, y: number) => edgeWeight < 0.02
        ? 1
        : 1 + edgeWeight * (Math.hypot(x - centreX, y - centreY) / reachOut - 0.55) * 1.25;
    const varyingWidth = taper > 0.02 || edgeWeight > 0.02;
    const insideCloud = (x: number, y: number) =>
        sorted.some(p => Math.hypot(x - p.x, y - p.y) <= p.r);

    const fills: PathData[] = [];
    const outline: PathData[] = [];
    const lobes: PathData[] = [];
    const details: PathData[] = [];
    type Strand = { disc: Disc & { distToCam: number }; arc: [number, number] };
    const silhouette: Strand[] = [];
    /** Undersides of buried lobes — where a pen would lay its shading. */
    const undersides: Strand[] = [];

    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const covering = occludersOver(p, p.distToCam, occluders);
        const body = covering.length === 0 ? fullCirclePath(p) : clipDiscFill(p, covering);

        if (body) {
            fills.push({
                id: generateId(),
                d: body,
                fill: '#ffffff',
                stroke: 'none',
                strokeWidth: 3.8,
                opacity: 1.0
            });
        }

        const coveredSpans: Array<[number, number]> = [];
        const nearerSpans: Array<[number, number]> = [];
        let insideAnotherPuff = false;
        let hiddenFromCamera = false;

        for (let j = 0; j < sorted.length; j++) {
            if (i === j) continue;
            const span = hiddenSpan(p, sorted[j]);
            const isNearer = j > i;
            if (span === 'all') {
                insideAnotherPuff = true;
                if (isNearer) hiddenFromCamera = true;
                continue;
            }
            if (!span) continue;
            coveredSpans.push(span);
            if (isNearer) nearerSpans.push(span);
        }

        // Everything some other disc covers — i.e. the rim buried in the cloud body.
        const buried = insideAnotherPuff ? [[0, TWO_PI]] as Array<[number, number]> : mergeIntervals(coveredSpans);
        const rim = insideAnotherPuff ? [] : joinWrappedArc(complementIntervals(buried));

        for (const arc of rim) silhouette.push({ disc: p, arc });

        // What this puff's rim shows past the puffs in front of it, used to trim
        // ink that reaches into the body: creep tails, ring continuations and
        // lobe seams.
        const seenFromCamera = complementIntervals(mergeIntervals(nearerSpans));
        const hiddenByNearer = mergeIntervals(nearerSpans);
        const coveredByNearer = (angle: number) => {
            const normalized = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
            return hiddenByNearer.some(([from, to]) => normalized >= from && normalized <= to);
        };

        /** How far a creep tail can run from `edge` before a nearer puff covers it. */
        const tailReach = (edge: number, direction: 1 | -1, limit: number) => {
            let travelled = 0;
            while (travelled + 0.02 <= limit) {
                if (coveredByNearer(edge + direction * (travelled + 0.02))) break;
                travelled += 0.02;
            }
            return travelled;
        };

        const inkArc = (out: PathData[], from: number, to: number, width: number, opacity = 1) => {
            for (const [visibleFrom, visibleTo] of unoccludedArcRuns(p, from, to, p.distToCam, covering)) {
                if (!varyingWidth || visibleTo - visibleFrom < 0.05) {
                    out.push(inkPath(arcCommand(p, visibleFrom, visibleTo), strokeColor, width, opacity));
                    continue;
                }

                // Fat mid-arc, thinning to where it meets its neighbours, and
                // heavier out at the cloud's extremities.
                const widthOf = (t: number) => {
                    const angle = visibleFrom + (visibleTo - visibleFrom) * t;
                    const profile = 1 - taper * (1 - Math.sin(Math.PI * t) ** 0.65);
                    return width * profile * widthAt(
                        p.x + Math.cos(angle) * p.r,
                        p.y + Math.sin(angle) * p.r
                    );
                };

                out.push({
                    id: generateId(),
                    d: ribbonArcPath(p, visibleFrom, visibleTo, widthOf),
                    fill: strokeColor,
                    stroke: 'none',
                    strokeWidth: width,
                    opacity
                });
            }
        };

        if (isWholeCircle(rim) && covering.length === 0 && !varyingWidth) {
            outline.push(inkPath(fullCirclePath(p), strokeColor, outlineWidth));
        } else {
            // `creep` runs each arc on past the junction it meets, so the outline
            // pushes a little way into the body instead of stopping dead.
            //
            // Both puffs at a junction creep towards each other, and drawing both
            // tails leaves two lines crossing inside the cloud. A tail is ink on
            // a rim that is buried, so it obeys the same rule as everything else
            // buried: the puff in front wins, and the one behind is cut off where
            // that puff covers it. Only the nearer tail survives the overlap.
            const limit = creep * 0.35;
            for (const [from, to] of rim) {
                // Each end is grown separately and the arc stays one piece, so the
                // taper still runs the whole length instead of restarting at a cut.
                inkArc(outline, from - tailReach(from, -1, limit), to + tailReach(to, 1, limit), outlineWidth);
            }
        }

        // A puff sitting mostly in the open can carry on around its buried side,
        // which is what gives hand-drawn clouds their overlapping-rings look. It
        // is a fraction of that hidden rim rather than an all-or-nothing circle,
        // because whole circles on every lobe read as a flower, not a cloud.
        const exposed = rim.reduce((sweep, [from, to]) => sweep + (to - from), 0) / TWO_PI;
        if (rimCircles > 0.01 && !insideAnotherPuff && exposed >= 0.55) {
            for (const [from, to] of buried) {
                const middle = (from + to) / 2;
                const half = ((to - from) / 2) * rimCircles;
                if (half < 0.08) continue;
                for (const [visibleFrom, visibleTo] of arcWithin([middle - half, middle + half], seenFromCamera)) {
                    inkArc(outline, visibleFrom, visibleTo, outlineWidth * 0.8, 0.95);
                }
            }
        }

        if (hiddenFromCamera) continue;
        const visibleBuried = intersectIntervals(seenFromCamera, buried);

        // Interior lobe seams: buried rim the camera can still see past the puffs
        // in front of it. Only the CROWN of each lobe is drawn — a full buried
        // circle reads as a circle sitting in the cloud, whereas its top arc
        // alone reads as one lobe overlapping another.
        if (detailed || creep > 0.01) {
            const reach = creep * 0.6;
            const crown = intersectIntervals(visibleBuried, [[Math.PI + 0.3 - reach, TWO_PI - 0.3 + reach]]);
            const seamWidth = detailed ? (style === 'sketch' ? 1.9 : 2.6) * weight : outlineWidth * 0.7;

            for (const [from, to] of crown) {
                // Slivers read as specks rather than as a seam.
                if (to - from < 0.4) continue;
                inkArc(lobes, from, to, seamWidth, style === 'sketch' ? 0.75 : 0.9);
            }
        }

        // Shading belongs under a lobe, not over it, so the underside of each
        // buried rim is recorded even though nothing is drawn along it.
        for (const arc of visibleBuried) {
            for (const window of arcWithin(arc, LOWER_HALF)) {
                if (window[1] - window[0] > 0.25) undersides.push({ disc: p, arc: window });
            }
        }
    }

    if (style === 'sketch' && hatch > 0.01) {
        // Two shading passes, both hanging BELOW the edge they follow: the
        // underside of the silhouette, and the underside of the lobes buried
        // mid-cloud. Strokes keep a consistent lean and near-uniform length so
        // their inner ends line up, and they start a little in from the edge —
        // hatching that touches the outline reads as a smudge, not as shading.
        //
        // Candidates are gathered first and thinned by actual screen distance
        // afterwards. Stepping per disc is not enough on its own: where several
        // puffs' undersides pile up in the middle of the cloud, each one hatches
        // the same patch and the result is a scribble.
        const strongest = [...undersides]
            .filter(strand => strand.arc[1] - strand.arc[0] > 0.45)
            .sort((a, b) => (b.arc[1] - b.arc[0]) * b.disc.r - (a.arc[1] - a.arc[0]) * a.disc.r)
            .slice(0, 4);

        const passes = [
            { strands: silhouette, inward: true, reach: 0.3, spacing: 8 },
            { strands: strongest, inward: false, reach: 0.15, spacing: 12 }
        ];

        type Tick = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; width: number; opacity: number };
        const candidates: Tick[] = [];

        for (const { strands, inward, reach, spacing } of passes) {
            for (const { disc, arc } of strands) {
                const step = Math.max(0.1, (spacing / Math.max(8, disc.r)) / hatch);
                // Shading that touches the outline reads as a smudge, so every
                // stroke stands clear of the edge it hangs from.
                const gap = Math.max(2.6, outlineWidth * 0.95);

                for (let a = arc[0] + step * 0.5; a < arc[1]; a += step) {
                    if (inward && Math.sin(a) < 0.2) continue;

                    const at = a + (random() - 0.5) * step * 0.5 * inkiness;
                    // Longest under the belly of a circle and tapering away
                    // towards its sides, so the shading follows the roundness
                    // instead of ringing each puff evenly.
                    const belly = Math.max(0, Math.sin(at)) ** 1.2;
                    const length = Math.min(24, disc.r * reach * hatchLength
                        * (0.3 + 0.7 * belly)
                        * (0.9 + random() * 0.2)
                        * (1 + (random() - 0.5) * 0.22 * inkiness));
                    if (length < 2.2) continue;

                    // Strokes run up and down rather than out along each disc's
                    // radius: radial strokes fan, and a fan does not read as
                    // hatching. One consistent lean off vertical, only nudged —
                    // a hand varies, it does not alternate stroke by stroke.
                    const tilt = 0.2 + (random() - 0.5) * 0.22 * inkiness;
                    const direction = inward ? -1 : 1;
                    const stepX = Math.sin(tilt);
                    const stepY = Math.cos(tilt) * direction;
                    const rimX = disc.x + Math.cos(at) * disc.r;
                    const rimY = disc.y + Math.sin(at) * disc.r;
                    const x0 = rimX + stepX * gap * direction;
                    const y0 = rimY + stepY * gap;
                    const x1 = x0 + stepX * length * direction;
                    const y1 = y0 + stepY * length;

                    // Where the silhouette dips into a notch between two puffs,
                    // "inward" points across the cloud interior, and hatching
                    // there fans out over the middle of the body. Only shade a
                    // stretch with open sky just beyond it.
                    const openSky = (distance: number) => !insideCloud(
                        disc.x + Math.cos(at) * (disc.r + distance),
                        disc.y + Math.sin(at) * (disc.r + distance)
                    );
                    if (inward && !(openSky(Math.max(5, disc.r * 0.16)) && openSky(Math.max(11, disc.r * 0.34)))) continue;
                    // Vertical strokes leave their own disc near its sides, and
                    // outward ones hang into the puff below, so both ends are
                    // checked against the cloud body rather than this one disc.
                    if (!insideCloud(x0, y0) || !insideCloud(x1, y1)) continue;
                    if (behindGeometry(x0, y0, disc.distToCam, occluders)) continue;
                    if (behindGeometry(x1, y1, disc.distToCam, occluders)) continue;

                    // A slight bow and an uneven weight per stroke: a nib wobbles.
                    const bow = (random() - 0.5) * length * 0.18 * inkiness;
                    const dx = x1 - x0;
                    const dy = y1 - y0;
                    const span = Math.max(0.001, Math.hypot(dx, dy));

                    candidates.push({
                        x0, y0, x1, y1,
                        cx: (x0 + x1) / 2 - (dy / span) * bow,
                        cy: (y0 + y1) / 2 + (dx / span) * bow,
                        width: Math.max(0.7, outlineWidth * 0.4 * (0.7 + random() * 0.7 * (0.3 + inkiness))),
                        opacity: 0.62 + random() * 0.33
                    });
                }
            }
        }

        const minGap = Math.max(3.4, outlineWidth) / Math.max(0.5, hatch);
        const laid: Tick[] = [];
        for (const tick of candidates) {
            if (laid.some(other => Math.hypot(other.x0 - tick.x0, other.y0 - tick.y0) < minGap)) continue;
            laid.push(tick);
            details.push(inkPath(
                `M ${tick.x0.toFixed(2)} ${tick.y0.toFixed(2)} Q ${tick.cx.toFixed(2)} ${tick.cy.toFixed(2)} ${tick.x1.toFixed(2)} ${tick.y1.toFixed(2)}`,
                strokeColor,
                tick.width,
                tick.opacity
            ));
        }
    }

    if (style === 'puffy') {
        // Crown ticks, spaced out and each a different size and lean. Drawn as
        // elliptical arcs rather than quadratics: a quadratic peak sharpens into
        // a spike as the tick narrows, which looked like a scratch, not a puff.
        const placed: Array<{ x: number; y: number; r: number }> = [];

        for (let i = sorted.length - 1; i >= 0; i--) {
            const p = sorted[i];
            if (p.r < 8) continue;

            const halfWidth = p.r * (0.2 + random() * 0.2 * (0.5 + tickVariety));
            const x = p.x + (random() - 0.5) * p.r * 0.55 * tickVariety;
            const y = p.y - p.r * (0.18 + random() * 0.3 * (0.4 + tickVariety));
            // Held below the half-width so the crown stays round.
            const arch = Math.min(halfWidth * 0.85, p.r * (0.14 + random() * 0.14));
            const lean = (random() - 0.5) * 0.7 * tickVariety;

            if (placed.some(t => Math.hypot(t.x - x, t.y - y) < (t.r + halfWidth) * 1.05)) continue;
            if (behindGeometry(x, y, p.distToCam, occluders)) continue;
            placed.push({ x, y, r: halfWidth });

            const cos = Math.cos(lean);
            const sin = Math.sin(lean);
            const at = (dx: number, dy: number) =>
                `${(x + dx * cos - dy * sin).toFixed(2)} ${(y + dx * sin + dy * cos).toFixed(2)}`;

            details.push(inkPath(
                `M ${at(-halfWidth, 0)} A ${halfWidth.toFixed(2)} ${arch.toFixed(2)} ${(lean * 180 / Math.PI).toFixed(2)} 0 1 ${at(halfWidth, 0)}`,
                strokeColor,
                Math.max(1, 2.6 * weight * (0.75 + random() * 0.5)),
                0.9
            ));
        }
    }

    if (shade > 0.01) {
        // A soft band tucked inside the lower silhouette, the way a sticker is
        // shaded away from the light.
        for (const { disc, arc } of silhouette) {
            for (const [from, to] of arcWithin(arc, [[0.15, Math.PI - 0.15]])) {
                if (to - from < 0.2) continue;
                const inner = {
                    x: disc.x,
                    y: disc.y,
                    r: Math.max(2, disc.r - outlineWidth * 0.8 - disc.r * 0.1 * shade)
                };
                if (behindGeometry(inner.x, inner.y + inner.r, disc.distToCam, occluders)) continue;
                details.push(inkPath(
                    arcCommand(inner, from, to),
                    '#dee5ed',
                    Math.max(2, disc.r * 0.15 * shade),
                    0.95
                ));
            }
        }
    }

    if (gloss > 0.01) {
        // Highlight streaks inside the biggest puffs, up where the light lands.
        for (const p of [...sorted].sort((a, b) => b.r - a.r).slice(0, 3)) {
            const inner = { x: p.x, y: p.y, r: p.r * (0.74 - gloss * 0.14) };
            const from = Math.PI * (1.12 + random() * 0.1);
            const to = from + Math.PI * (0.24 + gloss * 0.2);
            if (behindGeometry(inner.x + Math.cos(from) * inner.r, inner.y + Math.sin(from) * inner.r, p.distToCam, occluders)) continue;
            details.push(inkPath(arcCommand(inner, from, to), '#eef3f8', Math.max(1.4, 3.4 * gloss * weight), 0.95));
        }
    }

    return [...fills, ...outline, ...lobes, ...details];
}

/** Geometry the far side of a worker boundary has not been sent yet. */
export interface HiddenLineGeometryUpload {
    geometryId: number;
    positionVersion: number;
    indexVersion: number;
    position: Float32Array;
    index: Uint32Array | null;
}

export interface HiddenLinePreparation {
    request: HiddenLineRequest;
    boundsTrees: Map<number, MeshBVH>;
    edgePositions: Map<number, Float32Array>;
    /** Meshes whose triangles the worker needs in order to build its own BVH. */
    meshUploads: HiddenLineGeometryUpload[];
    /** Edge buffers the worker needs in order to walk the segments. */
    edgeUploads: HiddenLineGeometryUpload[];
}

/**
 * Collects everything the hidden line pass reads into plain data, and hands
 * back the local lookups so an inline run can skip the copies entirely.
 *
 * Also performs the geometry bookkeeping the pass depends on: line geometry is
 * replaced by the visible-span result each encode, so the untouched original
 * is stashed on first use and restored on every later one.
 */
export function prepareHiddenLine(
    threeCamera: THREE.Camera,
    bakeMeshes: BakeMesh[],
    lineSegments: THREE.LineSegments[]
): HiddenLinePreparation {
    const camPos = new THREE.Vector3();
    threeCamera.getWorldPosition(camPos);
    const isOrtho = Boolean((threeCamera as THREE.OrthographicCamera).isOrthographicCamera);
    const cameraForward = new THREE.Vector3();
    if (isOrtho) {
        threeCamera.getWorldDirection(cameraForward);
    }

    // Mirrors the old `mesh.parent === child.parent` identity check across the
    // postMessage boundary, where object references cannot survive.
    const groupIds = new Map<THREE.Object3D | null, number>();
    const groupIdFor = (object: THREE.Object3D | null) => {
        let id = groupIds.get(object);
        if (id === undefined) {
            id = groupIds.size;
            groupIds.set(object, id);
        }
        return id;
    };

    const boundsTrees = new Map<number, MeshBVH>();
    const edgePositions = new Map<number, Float32Array>();
    const meshUploads: HiddenLineGeometryUpload[] = [];
    const edgeUploads: HiddenLineGeometryUpload[] = [];

    const meshes: HiddenLineMeshData[] = bakeMeshes.map(bakeMesh => {
        boundsTrees.set(bakeMesh.geometryId, bakeMesh.boundsTree);

        const geometry = bakeMesh.mesh.geometry;
        meshUploads.push({
            geometryId: bakeMesh.geometryId,
            positionVersion: bakeMesh.positionVersion,
            indexVersion: bakeMesh.indexVersion,
            position: geometry.attributes.position.array as Float32Array,
            index: geometry.index ? (geometry.index.array as unknown as Uint32Array) : null
        });

        return {
            geometryId: bakeMesh.geometryId,
            matrixWorld: bakeMesh.mesh.matrixWorld.elements.slice(),
            sphereCenter: [bakeMesh.sphere.center.x, bakeMesh.sphere.center.y, bakeMesh.sphere.center.z],
            sphereRadius: bakeMesh.sphere.radius,
            groupId: groupIdFor(bakeMesh.mesh.parent)
        } satisfies HiddenLineMeshData;
    });

    const edges: HiddenLineEdgeData[] = lineSegments.map(child => {
        if (!child.userData.originalGeometry) {
            child.userData.originalGeometry = child.geometry;
        } else {
            child.geometry = child.userData.originalGeometry;
        }
        child.updateMatrixWorld();

        const geometry = child.geometry;
        const geometryId = geometryIdFor(geometry);
        const position = geometry.attributes.position.array as Float32Array;
        edgePositions.set(geometryId, position);
        edgeUploads.push({
            geometryId,
            positionVersion: attributeVersion(geometry.attributes.position),
            indexVersion: -1,
            position,
            index: null
        });

        return {
            geometryId,
            matrixWorld: child.matrixWorld.elements.slice(),
            ignoreSelfOcclusion: Boolean(child.userData.ignoreSelfOcclusion),
            groupId: groupIdFor(child.parent)
        } satisfies HiddenLineEdgeData;
    });

    return {
        request: {
            cameraPosition: [camPos.x, camPos.y, camPos.z],
            cameraForward: [cameraForward.x, cameraForward.y, cameraForward.z],
            isOrtho,
            meshes,
            edges
        },
        boundsTrees,
        edgePositions,
        meshUploads,
        edgeUploads
    };
}

/** Swaps each line's geometry for the spans that survived occlusion. */
export function applyVisibleSpans(lineSegments: THREE.LineSegments[], spans: Float32Array[]) {
    lineSegments.forEach((child, index) => {
        const visiblePositions = spans[index] ?? new Float32Array(0);
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(visiblePositions, 3));
        child.geometry = newGeo;

        // Force line to render AFTER the faces
        child.renderOrder = 1;
    });
}

interface BakeContext {
    renderer: InstanceType<typeof SVGRenderer>;
    bakeScene: THREE.Scene;
    exportCamera: THREE.Camera;
    lineSegments: THREE.LineSegments[];
    camPos: THREE.Vector3;
    prepared: HiddenLinePreparation | null;
    restoreMaterialSides: () => void;
    pseudoEffects: PseudoEffect[];
    /** World-space triangles (9 floats each) a cloud's ink is clipped against.
     *  Only gathered when the scene actually contains a cloud. */
    clipTriangles: Float32Array;
}

interface PseudoEffect {
    type: 'sun_glow' | 'light_burst' | 'aura_halo' | 'cloud';
    worldPos: THREE.Vector3;
    worldScale: THREE.Vector3;
    matrixWorld: THREE.Matrix4;
    color: string;
    effectParams?: PseudoEffectParams;
}

const EMPTY_TRIANGLES = new Float32Array(0);

/** Ceiling on cloud clip geometry, so a dense scene cannot make a bake crawl. */
const MAX_CLIP_TRIANGLES = 20000;

/** Flattens the rendered meshes into world-space triangles. */
function collectWorldTriangles(meshes: THREE.Mesh[]): Float32Array {
    const out: number[] = [];
    const vertex = new THREE.Vector3();

    for (const mesh of meshes) {
        const position = mesh.geometry?.attributes?.position;
        if (!position) continue;
        mesh.updateMatrixWorld();
        const index = mesh.geometry.index;
        const count = index ? index.count : position.count;

        for (let i = 0; i + 2 < count; i += 3) {
            if (out.length / 9 >= MAX_CLIP_TRIANGLES) return new Float32Array(out);
            for (let corner = 0; corner < 3; corner++) {
                const vertexIndex = index ? index.getX(i + corner) : i + corner;
                vertex.fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
                out.push(vertex.x, vertex.y, vertex.z);
            }
        }
    }

    return new Float32Array(out);
}

/**
 * Projects the clip triangles into the same screen space the cloud puffs are
 * measured in, tagging each with its distance from the camera so the cloud can
 * tell which ones sit in front of it.
 */
function projectClipTriangles(
    triangles: Float32Array,
    camera: THREE.Camera,
    width: number,
    height: number
): CloudOccluder[] {
    if (triangles.length === 0) return [];

    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const corner = new THREE.Vector3();
    // MED-84: Reuse one projected vector instead of corner.clone().project()
    // per vertex — the clip triangle list can be thousands long.
    const projected = new THREE.Vector3();
    const out: CloudOccluder[] = [];

    for (let i = 0; i + 8 < triangles.length; i += 9) {
        const screen: number[] = [];
        let depth = 0;
        let behindCamera = false;

        for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
            const offset = i + vertexIndex * 3;
            corner.set(triangles[offset], triangles[offset + 1], triangles[offset + 2]);
            depth += corner.distanceTo(camPos) / 3;
            projected.copy(corner).project(camera);
            if (projected.z < -1 || projected.z > 1) { behindCamera = true; break; }
            screen.push(projected.x * (width / 2), -projected.y * (height / 2));
        }

        if (behindCamera) continue;

        // Edge-on faces project to a sliver with no area, and a point-in-triangle
        // test against a degenerate triangle answers "inside" for a whole
        // half-plane — which silently erased most of the cloud.
        const [x0, y0, x1, y1, x2, y2] = screen;
        const area = Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
        if (area < 0.75) continue;

        out.push({ points: screen as CloudOccluder['points'], depth });
    }

    return out;
}

/**
 * First half of an encode: clone the scene, gather the meshes/edges/pseudo
 * elements and package up everything the hidden line pass needs. Split out so
 * the pass in the middle can run either inline or on a worker.
 */
// MED-85: Reuse a single SVGRenderer instance across encodes — it's a
// pure JS renderer with no GPU state, so re-creating it just adds GC
// pressure. setSize + overdraw are reset each call.
let sharedSvgRenderer: SVGRenderer | null = null;

function beginEncode(
    threeScene: THREE.Scene,
    threeCamera: THREE.Camera,
    width: number,
    height: number
): BakeContext {
        const renderer = sharedSvgRenderer ?? (sharedSvgRenderer = new SVGRenderer());
    renderer.setSize(width, height);
    renderer.overdraw = 0;

    // Clone and prepare camera & scene with updated matrices for accurate 2D projection
    const exportCamera = threeCamera.clone();
    if ('aspect' in exportCamera) {
        (exportCamera as THREE.PerspectiveCamera).aspect = width / height;
        (exportCamera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
    exportCamera.updateMatrixWorld(true);

    const bakeScene = threeScene.clone();
    bakeScene.updateMatrixWorld(true);

    const meshes: THREE.Mesh[] = [];
    const lineSegments: THREE.LineSegments[] = [];
    const originalSides = new Map();
    const bakeMeshes: BakeMesh[] = [];
    const pseudoEffects: PseudoEffect[] = [];
    // `traverseVisible` decides visibility per node on entry, so hiding a pseudo
    // element's group inside the callback does NOT stop the walk descending into
    // its children — they are still visible in their own right. The placeholder
    // meshes therefore keep arriving here and have to be recognised, or a cloud
    // ends up clipping itself against its own puff spheres.
    const pseudoParts = new Set<THREE.Object3D>();

    /** Adds a mesh to the occluder set the hidden line pass raycasts against. */
    const registerOccluder = (mesh: THREE.Mesh) => {
        // `bakeScene.clone()` shares geometry with the live scene, so this still
        // reads the source geometry before swapping in the bake copy.
        const geometryId = geometryIdFor(mesh.geometry);
        const cached = getBakeGeometry(mesh.geometry);
        mesh.geometry = cached.geometry;
        const sphere = cached.geometry.boundingSphere?.clone();
        if (!sphere) return;
        mesh.updateMatrixWorld();
        sphere.applyMatrix4(mesh.matrixWorld);
        bakeMeshes.push({
            mesh,
            sphere,
            boundsTree: cached.boundsTree,
            geometryId,
            positionVersion: cached.positionVersion,
            indexVersion: cached.indexVersion
        });
    };

    bakeScene.traverseVisible((child) => {
        const objectType = child.userData?.type || child.name;
        if (objectType === 'sun_glow' || objectType === 'light_burst' || objectType === 'aura_halo' || objectType === 'cloud') {
            child.updateMatrixWorld(true);
            const worldPos = new THREE.Vector3();
            child.getWorldPosition(worldPos);
            const worldScale = new THREE.Vector3();
            child.getWorldScale(worldScale);

            const matColor = (child as any).material?.color;
            const hexColor = matColor && typeof matColor.getHexString === 'function' ? `#${matColor.getHexString()}` : '#ffb703';
            const effectColor = child.userData?.color || hexColor;

            pseudoEffects.push({
                type: objectType,
                worldPos,
                worldScale,
                matrixWorld: child.matrixWorld.clone(),
                color: effectColor,
                effectParams: child.userData?.effectParams
            });
            child.traverse(sub => pseudoParts.add(sub));

            // Hide the 3D placeholder mesh so SVGRenderer does NOT draw a plain solid sphere/torus
            child.visible = false;
            return;
        }

        if (child instanceof THREE.Mesh) {
            // A cloud is drawn as flat vector puffs, but it is still a solid body
            // in the scene: geometry buried inside it has to be culled like any
            // other hidden line. So the placeholder meshes stay occluders while
            // being kept out of the render and out of the clip geometry.
            if (pseudoParts.has(child)) {
                registerOccluder(child);
                return;
            }

            meshes.push(child);
            registerOccluder(child);
            if (child.material) {
                // Save original side and force DoubleSide for robust raycasting
                originalSides.set(child, (child.material as THREE.Material).side);
                (child.material as THREE.Material).side = THREE.DoubleSide;
            }
        } else if (child instanceof THREE.LineSegments && child.geometry) {
            lineSegments.push(child);
        }
    });

    // Pseudo effect sizing below projects from the live camera, not the
    // aspect-corrected export clone.
    const camPos = new THREE.Vector3();
    threeCamera.getWorldPosition(camPos);

    const clipTriangles = pseudoEffects.some(effect => effect.type === 'cloud')
        ? collectWorldTriangles(meshes)
        : EMPTY_TRIANGLES;

    return {
        renderer,
        bakeScene,
        exportCamera,
        lineSegments,
        camPos,
        clipTriangles,
        // No edges means nothing for the pass to cull, and preparing it anyway
        // would ship geometry to the worker for no result.
        prepared: bakeMeshes.length > 0 && lineSegments.length > 0
            ? prepareHiddenLine(threeCamera, bakeMeshes, lineSegments)
            : null,
        restoreMaterialSides: () => {
            meshes.forEach(mesh => {
                if (originalSides.has(mesh) && !Array.isArray(mesh.material)) {
                    (mesh.material as THREE.Material).side = originalSides.get(mesh) as THREE.Side;
                }
            });
        },
        pseudoEffects
    };
}

/** Second half of an encode: render the prepared scene and read the vector
 *  product back out, including the stylized pseudo element paths. */
function finishEncode(context: BakeContext, width: number, height: number): PathData[] {
    const { renderer, bakeScene, exportCamera, camPos, pseudoEffects } = context;

    renderer.render(bakeScene, exportCamera);

    const svgOutput = renderer.domElement;
    // Faces and edges are kept apart so a cloud can be composited BETWEEN them.
    // A cloud is flat vector ink laid over the render, so anything it is drawn
    // after, it hides — which buried a cube standing in front of the cloud.
    // Slotting the cloud above the faces and below the edges puts it in the
    // right place at both ends: solid geometry the cloud sits behind keeps its
    // linework, and geometry inside the cloud has already had those edges culled
    // by the hidden line pass (the puff spheres are occluders). Edges last is
    // safe generally, because an edge any face should hide is already gone.
    const facePaths: PathData[] = [];
    const edgePaths: PathData[] = [];
    const effectPaths: PathData[] = [];

    const svgShapes = svgOutput.querySelectorAll('path, polygon');
    svgShapes.forEach(p => {
        let d = p.getAttribute('d');

        if (p.tagName.toLowerCase() === 'polygon') {
            const points = p.getAttribute('points');
            if (points) {
                d = polygonToPath(points);
            }
        }

        const style = p.getAttribute('style') || '';
        const fillMatch = style.match(/(?:^|[\s;])fill:\s*([^;]+)/);
        const strokeMatch = style.match(/(?:^|[\s;])stroke:\s*([^;]+)/);
        const strokeWidthMatch = style.match(/(?:^|[\s;])stroke-width:\s*([^;]+)/);
        const fillOpacityMatch = style.match(/(?:^|[\s;])fill-opacity:\s*([^;]+)/);
        const strokeOpacityMatch = style.match(/(?:^|[\s;])stroke-opacity:\s*([^;]+)/);

        const fill = p.getAttribute('fill') || (fillMatch ? fillMatch[1].trim() : 'none');
        const stroke = p.getAttribute('stroke') || (strokeMatch ? strokeMatch[1].trim() : 'none');
        let strokeWidth = parseFloat(p.getAttribute('stroke-width') || (strokeWidthMatch ? strokeWidthMatch[1].trim() : '2'));
        // Ensure edge lines are at least 2px to match the 3D preview
        if (stroke !== 'none' && strokeWidth < 2) strokeWidth = 2;

        // THREE SVGRenderer emits material.opacity as fill-opacity / stroke-opacity
        // rather than as a single opacity attribute. Faces have fill, edges have
        // stroke — they are mutually exclusive — so one opacity field is enough.
        let opacity: number | undefined;
        if (fill !== 'none') {
            const v = parseFloat(p.getAttribute('fill-opacity') || (fillOpacityMatch ? fillOpacityMatch[1].trim() : ''));
            if (!isNaN(v) && v < 1) opacity = v;
        } else if (stroke !== 'none') {
            const v = parseFloat(p.getAttribute('stroke-opacity') || (strokeOpacityMatch ? strokeOpacityMatch[1].trim() : ''));
            if (!isNaN(v) && v < 1) opacity = v;
        }

        if (d) {
            (stroke === 'none' ? facePaths : edgePaths).push({
                id: generateId(),
                d: d.trim(),
                fill,
                stroke,
                strokeWidth,
                ...(opacity != null ? { opacity } : {})
            });
        }
    });

    // Render pseudo elements (sun_glow, light_burst, aura_halo, cloud) into stylized SVG vector paths
    for (const effect of pseudoEffects) {
        if (effect.type === 'cloud') {
            const puffs2D: Array<{ x: number; y: number; r: number; distToCam: number }> = [];
            const cloudMat = effect.matrixWorld;
            const avgScale = (effect.worldScale.x + effect.worldScale.y + effect.worldScale.z) / 3;

            const camPos = new THREE.Vector3();
            exportCamera.getWorldPosition(camPos);
            // MED-84: Reuse scratch vectors and the cloud matrix instead of
            // allocating per puff (clone + new Vector3 each iteration).
            const scratchLocal = new THREE.Vector3();
            const scratchWorld = new THREE.Vector3();
            const scratchProj = new THREE.Vector3();

            for (const puff of getCloudPuffNodes(effect.effectParams?.cloud)) {
                scratchLocal.set(...puff.offset);
                // applyMatrix4 reads the matrix without mutating it, so no clone needed.
                scratchWorld.copy(scratchLocal).applyMatrix4(cloudMat);
                scratchProj.copy(scratchWorld).project(exportCamera);
                const px = scratchProj.x * (width / 2);
                const py = -scratchProj.y * (height / 2);
                const puff3DRadius = 0.8 * puff.scale * avgScale;
                const pr = getProjectedSphereRadius(scratchWorld, puff3DRadius, exportCamera, height);
                const distToCam = scratchWorld.distanceTo(camPos);
                puffs2D.push({ x: px, y: py, r: pr, distToCam });
            }

            const cloudPaths = generateDynamic3DCloudPaths(
                puffs2D,
                effect.color,
                effect.effectParams?.cloud,
                projectClipTriangles(context.clipTriangles, exportCamera, width, height)
            );
            effectPaths.push(...cloudPaths);
        } else {
            const projPos = effect.worldPos.clone().project(exportCamera);
            const cx = projPos.x * (width / 2);
            const cy = -projPos.y * (height / 2);

            const avgScale = (effect.worldScale.x + effect.worldScale.y + effect.worldScale.z) / 3;
            const distToCam = Math.max(0.1, effect.worldPos.distanceTo(camPos));
            const projRadius = Math.max(15, (avgScale * width) / (distToCam * 2.2));

            const typePaths = generatePseudoEffectPaths(
                effect.type,
                cx,
                cy,
                projRadius,
                effect.color,
                effect.effectParams
            );

            effectPaths.push(...typePaths);
        }
    }

    return [...facePaths, ...effectPaths, ...edgePaths];
}

export function encodeSceneToSvg(
    threeScene: THREE.Scene,
    threeCamera: THREE.Camera,
    width: number,
    height: number
): PathData[] {
    try {
        const context = beginEncode(threeScene, threeCamera, width, height);

        if (context.prepared) {
            const { request, boundsTrees, edgePositions } = context.prepared;
            applyVisibleSpans(context.lineSegments, computeVisibleSpans(
                request,
                geometryId => boundsTrees.get(geometryId) ?? null,
                geometryId => edgePositions.get(geometryId) ?? null
            ));
        }
        context.restoreMaterialSides();

        return finishEncode(context, width, height);
    } catch (err) {
        console.error('[encodeSceneToSvg ERROR]', err);
        return [];
    }
}

/**
 * Same encode, with the hidden line pass delegated to `computeSpans` — which
 * the caller backs with a worker. The scene clone and the SVG render still
 * happen here because both need the DOM.
 *
 * Material sides are restored before awaiting rather than after: the bake
 * shares materials with the live scene, and holding them double-sided across a
 * worker round trip would be visible in the 3D viewport.
 */
export async function encodeSceneToSvgAsync(
    threeScene: THREE.Scene,
    threeCamera: THREE.Camera,
    width: number,
    height: number,
    computeSpans: (prepared: HiddenLinePreparation) => Promise<Float32Array[]>
): Promise<PathData[]> {
    try {
        const context = beginEncode(threeScene, threeCamera, width, height);
        context.restoreMaterialSides();

        if (context.prepared) {
            applyVisibleSpans(context.lineSegments, await computeSpans(context.prepared));
        }

        return finishEncode(context, width, height);
    } catch (err) {
        // MED-10: SupersededError is expected when a newer encode from the same
        // consumer is already in flight — don't log it as an error.
        if (err instanceof Error && err.name !== 'SupersededError') {
            console.error('[encodeSceneToSvgAsync ERROR]', err);
        }
        return [];
    }
}
