import type { Ring, Polygon, MultiPolygon } from 'polygon-clipping';
import type { PathData } from './types.ts';
import { cachedPathBounds, rectsIntersect, type Rect } from './raster.ts';
import { difference, union } from './clipping.ts';
import { flattenPathData } from './flatten.ts';
import { inflateMultiPolygon, strokeToRegion } from './offset.ts';
import { multiPolygonBox, pointInRing, ringsToMultiPolygon, snapMultiPolygon } from './rings.ts';
import {
    emptyStats, fail, finishFill, isBarrierPath, now, resolveFillOptions,
    type FillOptions, type FillOutcome, type FillRequest, type FillStats
} from './bucketFill.ts';

/** Bucket fill, engine B: solve it as geometry, never touch a pixel.
 *
 *  Every stroke in this app is already a region — perfect-freehand emits a
 *  filled outline, and a centreline stroke is one `strokeToRegion` call away
 *  from being one. Union them all and you have the planar arrangement of the
 *  ink; the area you clicked is then literally a HOLE of that union, available
 *  exactly, at infinite resolution, with no tracing and no staircase.
 *
 *  What it buys over the raster engine: exact boundaries that stay sharp at any
 *  zoom, far fewer points on curved shapes, and a fill that follows the true
 *  stroke edge instead of a thresholded approximation of it.
 *
 *  What it costs: strictness. A hole only exists if the outline genuinely
 *  closes, so `gapClose` is doing real work here, not polish. And the union is
 *  the expensive part — hence the expanding window below, which is the
 *  difference between "instant" and "seconds" on a dense drawing. */

/** Windows tried around the seed, in canvas units, before giving up and using
 *  the whole canvas. Doubling keeps the worst case to a handful of attempts. */
const WINDOW_STEPS = [192, 384, 768, 1536];

/** Flattened-and-outlined barrier regions, cached per path.
 *
 *  The expanding window below retries with progressively more barriers, and
 *  without this every retry re-flattens every curve and re-outlines every
 *  centreline stroke it already processed — on a dense drawing that repeated
 *  work dominated the failure path. Keyed on the PathData object and invalidated
 *  when the geometry changes, same as the Path2D and bbox caches in `raster.ts`;
 *  entries fall away with the path. */
const barrierRegionCache = new WeakMap<PathData, { key: string; regions: MultiPolygon[] }>();

function cachedBarrierRegion(p: PathData, tolerance: number, grow: number): MultiPolygon[] {
    const key = `${p.d}|${p.transform ?? ''}|${p.strokeWidth}|${p.fill}|${p.stroke}|${tolerance}|${grow}`;
    const hit = barrierRegionCache.get(p);
    if (hit && hit.key === key) return hit.regions;
    const regions = pathToBarrierRegion(p, tolerance, grow);
    barrierRegionCache.set(p, { key, regions });
    return regions;
}

/**
 * Turn one path into the region its ink covers, optionally grown by `grow` in
 * every direction for gap closing.
 *
 * A path can be both filled and stroked, in which case both contribute — that
 * is what it looks like on screen, so that is what should stop the bucket.
 *
 * Growing HERE rather than inflating the finished union is not just an
 * optimisation, it is the same operation: a Minkowski sum distributes over
 * union, so `(A ∪ B) ⊕ D` and `(A ⊕ D) ∪ (B ⊕ D)` are equal. Doing it per path
 * is dramatically cheaper — the whole-union version had to stroke every ring of
 * a canvas-sized polygon (measured at ~750ms on a dense drawing), while a
 * centreline stroke absorbs the growth for free by simply being outlined wider.
 */
export function pathToBarrierRegion(p: PathData, tolerance: number, grow = 0): MultiPolygon[] {
    const subpaths = flattenPathData(p, tolerance);
    if (subpaths.length === 0) return [];
    const parts: MultiPolygon[] = [];

    if (p.fill && p.fill !== 'none') {
        // SVG fills an open subpath as though it were closed, so every subpath
        // with enough points is a ring here regardless of its `Z`.
        const rings = subpaths.filter(s => s.points.length >= 3).map(s => s.points);
        // Nesting is resolved by even-odd containment. That matches `evenodd`
        // exactly and matches `nonzero` for the non-self-intersecting shapes
        // this app produces (freehand outlines are a single ring; clip output is
        // already normalised).
        if (rings.length > 0) {
            const mp = ringsToMultiPolygon(rings);
            if (mp.length > 0) parts.push(grow > 0 ? inflateMultiPolygon(mp, grow) : mp);
        }
    }

    if (p.stroke && p.stroke !== 'none' && p.strokeWidth) {
        for (const sp of subpaths) {
            if (sp.points.length === 0) continue;
            // A wider outline IS the grown region for a centreline stroke, so
            // the gap-closing growth costs nothing here.
            const region = strokeToRegion(sp.points, p.strokeWidth + grow * 2, sp.closed);
            if (region.length > 0) parts.push(region);
        }
    }

    return parts;
}

/** How many barrier regions go into one union attempt when the all-at-once
 *  union has already failed. Small enough that a single bad polygon only
 *  contaminates a handful of its neighbours. */
const UNION_CHUNK = 24;

export interface SafeUnionResult {
    geometry: MultiPolygon;
    /** How many input regions were replaced by their bounding box. Safe to
     *  proceed on: a bigger barrier can only shrink the fill. */
    approximated: number;
    /** How many input regions were lost entirely. Unsafe to proceed on — the
     *  fill would be bounded by ink that is no longer there. */
    dropped: number;
}

/** A region's bounding box as a rectangle.
 *
 *  The safe substitute for a polygon the boolean engine cannot process. It is a
 *  strict SUPERSET of the region, so using it as a barrier can only make the
 *  resulting fill smaller or make it fail — never larger than it should be. A
 *  fill that stops slightly short is a cosmetic problem; one that floods past a
 *  wall that quietly went missing looks deliberate and is not. */
function boxRegion(mp: MultiPolygon): MultiPolygon | null {
    const b = multiPolygonBox(mp);
    if (!b) return null;
    return [[[
        [b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY], [b.minX, b.minY]
    ] as Ring]];
}

/**
 * Union the barrier regions, defensively.
 *
 * Martinez is the only boolean engine available on the main thread (the
 * Clipper2 wasm module is installed inside the erase worker and nowhere else),
 * and it does fail on real input: unioning a few hundred overlapping freehand
 * outlines is enough to make its sweep line lose a segment and throw. This tries
 * the cheap fixes first — grid snapping, then raw — and only then falls back to
 * chunking, which isolates the polygon that cannot be processed.
 *
 * A dropped region is reported rather than absorbed. Losing a barrier does not
 * make the fill fail, it makes it silently WRONG — the enclosing wall goes
 * missing and two regions merge into one oversized blob. Better to tell the
 * caller nothing usable came back.
 */
export function safeUnionBarriers(parts: MultiPolygon[]): SafeUnionResult | null {
    if (parts.length === 0) return null;
    const snapped = parts.map(p => snapMultiPolygon(p));

    try {
        return { geometry: union(snapped[0], ...snapped.slice(1)), approximated: 0, dropped: 0 };
    } catch { /* fall through */ }
    try {
        return { geometry: union(parts[0], ...parts.slice(1)), approximated: 0, dropped: 0 };
    } catch { /* fall through */ }

    let approximated = 0;
    let dropped = 0;
    const chunks: MultiPolygon[] = [];
    for (let i = 0; i < snapped.length; i += UNION_CHUNK) {
        const batch = snapped.slice(i, i + UNION_CHUNK);
        try {
            chunks.push(union(batch[0], ...batch.slice(1)));
        } catch {
            // Retry the batch one region at a time so only the genuinely
            // unprocessable polygon needs approximating.
            for (const one of batch) {
                try {
                    chunks.push(union(one));
                } catch {
                    const box = boxRegion(one);
                    if (box) { chunks.push(box); approximated++; } else dropped++;
                }
            }
        }
    }
    if (chunks.length === 0) return null;

    try {
        return { geometry: union(chunks[0], ...chunks.slice(1)), approximated, dropped };
    } catch { /* fall through */ }

    // Accumulate pairwise, re-snapping after every step. This matters more than
    // it looks: a union's output carries full-precision INTERSECTION
    // coordinates, so an accumulator that started snapped drifts off the grid
    // after one merge and takes the fragility straight back. Re-snapping each
    // result keeps every subsequent operand on the grid.
    let acc = snapMultiPolygon(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
        const next = snapMultiPolygon(chunks[i]);
        try {
            acc = snapMultiPolygon(union(acc, next));
            continue;
        } catch { /* fall through to the conservative substitute */ }
        const box = boxRegion(next);
        if (!box) { dropped++; continue; }
        try {
            acc = snapMultiPolygon(union(acc, box));
            approximated++;
        } catch {
            dropped++;
        }
    }
    return { geometry: acc, approximated, dropped };
}

/** The hole of `barriers` that contains (x, y), or null if the point is on ink
 *  or in unbounded space. */
export function findEnclosingHole(barriers: MultiPolygon, x: number, y: number): Ring | null {
    for (const poly of barriers) {
        if (poly.length < 2) continue;
        if (!pointInRing(x, y, poly[0])) continue;
        for (let i = 1; i < poly.length; i++) {
            if (pointInRing(x, y, poly[i])) return poly[i];
        }
    }
    return null;
}

/** Is the seed inside any barrier's outer ring (i.e. sitting on ink)? */
function seedIsOnInk(barriers: MultiPolygon, x: number, y: number): boolean {
    for (const poly of barriers) {
        if (poly.length === 0) continue;
        if (!pointInRing(x, y, poly[0])) continue;
        let inHole = false;
        for (let i = 1; i < poly.length; i++) {
            if (pointInRing(x, y, poly[i])) { inHole = true; break; }
        }
        if (!inHole) return true;
    }
    return false;
}

function windowRect(x: number, y: number, half: number, req: FillRequest): Rect {
    const minX = Math.max(0, x - half);
    const minY = Math.max(0, y - half);
    const maxX = Math.min(req.width, x + half);
    const maxY = Math.min(req.height, y + half);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Run the vector engine end to end.
 *
 * Pure geometry — no canvas, no DOM — so this runs unchanged in Node and is
 * where the engine's tests live.
 */
export function vectorBucketFill(req: FillRequest): FillOutcome {
    const opts: FillOptions = resolveFillOptions(req.options);
    const stats: FillStats = emptyStats('vector');
    const t0 = now();

    const candidates = req.barriers.filter(isBarrierPath);
    if (req.x < 0 || req.y < 0 || req.x > req.width || req.y > req.height) {
        return fail('leaked', 'Click was outside the canvas.', stats, t0);
    }

    const grow = opts.gapClose / 2;
    // Gap-closing growth is folded into the per-path outlining, so it shows up
    // under `flatten` rather than as a phase of its own.
    let flattenMs = 0, unionMs = 0;
    let barrierUnion: MultiPolygon = [];
    let hole: Ring | null = null;
    let onInk = false;

    // Expanding window. Correctness does not depend on the window size: a hole
    // is a closed loop of real ink, and any path that could sit inside that
    // hole necessarily has a bounding box intersecting the window, so it is
    // already included. A too-small window can only FAIL to find a hole, never
    // find a wrong one — so the first hole found is the answer.
    const fullCanvas = Math.max(req.width, req.height);
    const steps = WINDOW_STEPS.filter(s => s < fullCanvas).concat([fullCanvas]);
    let lastRect: Rect | null = null;

    for (const half of steps) {
        const rect = windowRect(req.x, req.y, half, req);
        // Windows are clamped to the canvas, so once one covers it entirely
        // every larger step produces the identical rect — and the identical
        // (expensive) union. Skipping those is free.
        if (lastRect && rect.x === lastRect.x && rect.y === lastRect.y &&
            rect.width === lastRect.width && rect.height === lastRect.height) continue;
        lastRect = rect;

        const inWindow = candidates.filter(p => {
            const b = cachedPathBounds(p);
            return !b || rectsIntersect(b, rect);
        });
        stats.barrierCount = inWindow.length;

        const tFlatten = now();
        const parts: MultiPolygon[] = [];
        for (const p of inWindow) {
            for (const part of cachedBarrierRegion(p, opts.flattenTolerance, grow)) parts.push(part);
        }
        flattenMs += now() - tFlatten;
        if (parts.length === 0) continue;

        const tUnion = now();
        const unioned = safeUnionBarriers(parts);
        unionMs += now() - tUnion;
        if (!unioned) {
            return fail('unavailable', 'The strokes here could not be combined.', stats, t0);
        }
        if (unioned.dropped > 0) {
            // Carrying on would paint a region bounded by ink we know went
            // missing — an oversized fill that looks deliberate. Refuse instead.
            return fail(
                'unavailable',
                `Too much overlapping ink here for the vector engine (${unioned.dropped} strokes unusable) — try the raster engine.`,
                stats, t0
            );
        }
        // Approximated barriers are safe to continue with; surfaced in the stats
        // because they explain a fill that stops a little short of the ink.
        if (unioned.approximated > 0) stats.approximatedBarriers = unioned.approximated;
        barrierUnion = unioned.geometry;

        hole = findEnclosingHole(barrierUnion, req.x, req.y);
        if (hole) break;
        onInk = seedIsOnInk(barrierUnion, req.x, req.y);
        // Sitting on ink is a definitive answer — a bigger window cannot change
        // it, so stop rather than re-unioning the whole canvas to say the same.
        if (onInk) break;
    }

    stats.phases.flatten = flattenMs;
    stats.phases.union = unionMs;

    if (!hole) {
        if (onInk) return fail('on-ink', 'That spot is already covered by ink.', stats, t0);
        return fail(
            'leaked',
            'No closed shape around that point — increase gap closing, or close the outline.',
            stats, t0
        );
    }

    // The hole is the enclosed void, but anything floating inside it (an island
    // stroke that does not touch the boundary) is still ink and must not be
    // painted over. Subtracting the whole barrier set removes exactly those.
    const tCut = now();
    let region: MultiPolygon;
    try {
        region = difference(snapMultiPolygon([[hole]]), barrierUnion);
    } catch {
        try {
            region = difference([hole] as Polygon, barrierUnion);
        } catch (err) {
            return fail(
                'unavailable',
                `Could not cut the islands out: ${err instanceof Error ? err.message : String(err)}`,
                stats, t0
            );
        }
    }
    stats.phases.cutIslands = now() - tCut;

    // Undo the gap-closing shrink and tuck the fill under the strokes, exactly
    // as the raster engine does with its final dilation.
    const expand = grow + opts.expand;
    if (expand > 0 && region.length > 0) {
        const tExpand = now();
        try {
            region = inflateMultiPolygon(region, expand);
        } catch (err) {
            return fail(
                'unavailable',
                `Could not expand the fill: ${err instanceof Error ? err.message : String(err)}`,
                stats, t0
            );
        }
        stats.phases.expandRegion = now() - tExpand;
    }

    // Re-derive nesting and winding from scratch so both engines hand back the
    // same conventions no matter what the boolean engine emitted.
    const flatRings: Ring[] = [];
    for (const poly of region) for (const ring of poly) flatRings.push(ring);
    const normalised = ringsToMultiPolygon(flatRings);

    return finishFill(normalised, req, stats, t0, opts);
}
