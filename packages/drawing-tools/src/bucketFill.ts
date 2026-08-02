import type { MultiPolygon } from 'polygon-clipping';
import type { PathData } from './types.ts';
import {
    multiPolygonArea, multiPolygonBox, multiPolygonPointCount, multiPolygonRingCount,
    multiPolygonToPathD, type Box
} from './rings.ts';

/** Shared contract for the two bucket-fill engines.
 *
 *  Both take the same inputs (the barrier paths, a seed point in canvas units,
 *  these options) and return the same `FillOutcome`, so the app can swap engines
 *  behind one setting and compare them on identical work. Everything that could
 *  differ between them — how a region is found, how its boundary becomes points
 *  — stays inside the engine; everything the caller sees is here. */

export type FillEngine = 'raster' | 'vector';

export interface FillOptions {
    /** Barriers grow by this much (canvas units) before the region is found, so
     *  a hand-drawn outline with gaps up to roughly this size still encloses.
     *  The region is grown back by the same amount afterwards, so the fill still
     *  reaches the ink — at the cost of a nub of at most this width poking
     *  through each gap that was bridged. */
    gapClose: number;
    /** Extra growth applied to the finished region so it slides UNDER the
     *  strokes that bounded it. Without it the fill stops at the outer edge of
     *  each stroke's anti-aliasing and a pale hairline shows along every
     *  boundary. */
    expand: number;
    /** RDP tolerance (canvas units) for the traced boundary. Raster engine only
     *  — the vector engine's boundary is already the real geometry. */
    simplify: number;
    /** Alpha (0–255) at or above which a barrier pixel counts as solid. Raster
     *  engine only. Low values make faint/anti-aliased ink a wall. */
    alphaThreshold: number;
    /** Mask pixels per canvas unit. Raster engine only. */
    rasterScale: number;
    /** Abort if the region covers more than this fraction of the canvas — the
     *  signature of a fill that escaped through a gap and flooded everything. */
    maxAreaFraction: number;
    /** Max deviation when turning curves into points. Vector engine only. */
    flattenTolerance: number;
}

export const DEFAULT_FILL_OPTIONS: FillOptions = {
    gapClose: 2,
    expand: 1.5,
    simplify: 0.6,
    alphaThreshold: 24,
    rasterScale: 2,
    maxAreaFraction: 0.92,
    flattenTolerance: 0.3
};

export interface FillStats {
    engine: FillEngine;
    /** Total wall-clock time for the fill. */
    ms: number;
    /** Per-phase breakdown, so a slow fill can be attributed rather than guessed
     *  at — the same reason `clipStats` exists for the eraser. */
    phases: Record<string, number>;
    ringCount: number;
    pointCount: number;
    /** Region area in square canvas units. */
    area: number;
    /** Region area as a fraction of the whole canvas. */
    areaFraction: number;
    /** Barrier paths actually considered (after any windowing). */
    barrierCount: number;
    /** Vector engine only: barriers the boolean engine could not process, which
     *  were replaced by their (larger) bounding box. Non-zero means the fill may
     *  stop short of the ink in those places — never that it overran. */
    approximatedBarriers?: number;
}

export type FillFailureReason =
    /** The region reached the canvas edge / exceeded the area cap. */
    | 'leaked'
    /** The seed sits on ink rather than in a fillable gap. */
    | 'on-ink'
    /** A region was found but had no usable area once simplified. */
    | 'empty'
    /** The engine could not run (no drawing surface available). */
    | 'unavailable';

export interface FillSuccess {
    ok: true;
    /** SVG path data, rings wound for the NONZERO rule. */
    d: string;
    region: MultiPolygon;
    box: Box;
    stats: FillStats;
}

export interface FillFailure {
    ok: false;
    reason: FillFailureReason;
    message: string;
    stats: FillStats;
}

export type FillOutcome = FillSuccess | FillFailure;

export interface FillRequest {
    /** Everything that should stop the flood. Order is irrelevant — only
     *  coverage matters — so the caller is free to pre-filter by layer. */
    barriers: PathData[];
    /** Seed point in canvas units. */
    x: number;
    y: number;
    /** Canvas extent in canvas units. */
    width: number;
    height: number;
    options?: Partial<FillOptions>;
}

export function resolveFillOptions(partial?: Partial<FillOptions>): FillOptions {
    return { ...DEFAULT_FILL_OPTIONS, ...(partial ?? {}) };
}

/** A path contributes a barrier only if it actually paints something. Fully
 *  transparent paths and zero-width strokes are skipped by both engines, which
 *  keeps "invisible ink blocks the bucket" from ever being a bug report. */
export function isBarrierPath(p: PathData): boolean {
    if (p.opacity !== undefined && p.opacity <= 0) return false;
    const hasFill = !!p.fill && p.fill !== 'none';
    const hasStroke = !!p.stroke && p.stroke !== 'none' && !!p.strokeWidth && p.strokeWidth > 0;
    return hasFill || hasStroke;
}

export function emptyStats(engine: FillEngine): FillStats {
    return {
        engine,
        ms: 0,
        phases: {},
        ringCount: 0,
        pointCount: 0,
        area: 0,
        areaFraction: 0,
        barrierCount: 0
    };
}

export function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function fail(reason: FillFailureReason, message: string, stats: FillStats, t0: number): FillFailure {
    stats.ms = now() - t0;
    return { ok: false, reason, message, stats };
}

/**
 * Shared tail for both engines: measure the region, apply the leak guard, emit
 * `d`.
 *
 * Living here rather than in either engine is what lets the app compare them
 * honestly — identical area accounting, identical failure wording, identical
 * `d` formatting, so any difference the user sees is a real difference in how
 * the region was found.
 */
export function finishFill(
    region: MultiPolygon,
    req: FillRequest,
    stats: FillStats,
    t0: number,
    opts: FillOptions
): FillOutcome {
    const area = multiPolygonArea(region);
    const canvasArea = Math.max(1, req.width * req.height);
    stats.area = area;
    stats.areaFraction = area / canvasArea;
    stats.ringCount = multiPolygonRingCount(region);
    stats.pointCount = multiPolygonPointCount(region);

    if (region.length === 0 || area <= 0) {
        return fail('empty', 'Nothing to fill here.', stats, t0);
    }
    if (stats.areaFraction > opts.maxAreaFraction) {
        return fail(
            'leaked',
            'The fill escaped the shape — increase gap closing, or close the outline.',
            stats, t0
        );
    }

    const box = multiPolygonBox(region);
    if (!box) return fail('empty', 'Nothing to fill here.', stats, t0);

    stats.ms = now() - t0;
    return { ok: true, d: multiPolygonToPathD(region), region, box, stats };
}
