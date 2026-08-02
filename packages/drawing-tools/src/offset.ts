import type { Ring, Polygon, MultiPolygon } from 'polygon-clipping';
import { union } from './clipping.ts';
import { snapMultiPolygon } from './rings.ts';

/** Round-join polygon offsetting, built from one primitive.
 *
 *  The vector bucket engine needs two things the boolean engines here don't
 *  provide: turn a centreline stroke into the region it actually covers, and
 *  grow the whole barrier set outward to close the gaps a hand-drawn outline
 *  always has. Clipper2 has `InflatePathsD` for exactly this, but the wasm
 *  module is only ever installed inside the erase worker (`setClipper2Module`
 *  is called there and nowhere else), so on the main thread — where the fill
 *  runs — it does not exist. Rather than stand up a second worker just to reach
 *  it, both operations are built here from an analytic outline walk.
 *
 *  The trick that keeps this small: a Minkowski sum with a disc of radius δ is
 *  `region ∪ (boundary ⊕ disc_δ)`, and `boundary ⊕ disc_δ` is just the stroke
 *  outline of that boundary at width 2δ. So ONE outline routine gives both
 *  stroke-to-region and polygon inflation, and the boolean union that follows
 *  cleans up the self-intersections the walk deliberately leaves behind at
 *  concave corners. */

/** Chord-height cap on the arc segments approximating a round join. 0.2 user
 *  units keeps a joint visually round at any brush size this app produces while
 *  costing a handful of points. */
const ARC_TOLERANCE = 0.2;

/** Angular step that keeps an arc of radius `r` within `tolerance` of true. */
function arcStep(r: number, tolerance: number): number {
    if (r <= tolerance) return Math.PI / 2;
    return 2 * Math.acos(1 - tolerance / r);
}

/** Rotate (x, y) by `a` radians. */
function rot(x: number, y: number, a: number): [number, number] {
    const c = Math.cos(a), s = Math.sin(a);
    return [x * c - y * s, x * s + y * c];
}

/** Drop consecutive duplicates — zero-length segments have no direction, and
 *  every normal below is derived from one. */
function dedupe(points: Ring): Ring {
    const out: Ring = [];
    for (const p of points) {
        const n = out.length;
        if (n > 0 && Math.abs(out[n - 1][0] - p[0]) < 1e-9 && Math.abs(out[n - 1][1] - p[1]) < 1e-9) continue;
        out.push(p);
    }
    return out;
}

function circle(cx: number, cy: number, r: number, tolerance: number): Ring {
    const step = arcStep(r, tolerance);
    const n = Math.max(8, Math.ceil((2 * Math.PI) / step));
    const out: Ring = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    out.push([out[0][0], out[0][1]]);
    return out;
}

/**
 * The region swept by a disc of radius `halfWidth` moving along `points`, as a
 * single closed ring: up one side, round the end cap, back down the other, round
 * the start cap.
 *
 * The ring self-intersects wherever the polyline turns tighter than its own
 * radius — that is expected and left alone. Feeding it through `union` resolves
 * those loops into the correct outline, which is far cheaper and far more robust
 * than trying to trim them analytically.
 */
export function strokeOutlineRing(points: Ring, halfWidth: number, tolerance = ARC_TOLERANCE): Ring | null {
    const pts = dedupe(points);
    if (pts.length === 0 || halfWidth <= 0) return null;
    if (pts.length === 1) return circle(pts[0][0], pts[0][1], halfWidth, tolerance);

    const step = arcStep(halfWidth, tolerance);
    const out: Ring = [];

    // Unit direction and left normal of each segment.
    const segCount = pts.length - 1;
    const dirs: [number, number][] = [];
    const norms: [number, number][] = [];
    for (let i = 0; i < segCount; i++) {
        const dx = pts[i + 1][0] - pts[i][0];
        const dy = pts[i + 1][1] - pts[i][1];
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        dirs.push([ux, uy]);
        norms.push([-uy * halfWidth, ux * halfWidth]);
    }

    /** Arc of offset points around `pts[vi]`, sweeping from normal `a` to normal
     *  `b` the short way. Emitted on both the outer and the inner side of a
     *  joint: on the inner side it produces a small loop, which the union eats. */
    const joint = (vi: number, a: [number, number], b: [number, number]) => {
        const a0 = Math.atan2(a[1], a[0]);
        const a1 = Math.atan2(b[1], b[0]);
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const steps = Math.ceil(Math.abs(delta) / step);
        for (let k = 1; k < steps; k++) {
            const [rx, ry] = rot(a[0], a[1], delta * (k / steps));
            out.push([pts[vi][0] + rx, pts[vi][1] + ry]);
        }
    };

    /** Half-turn around an endpoint, sweeping the offset normal through the
     *  travel direction so the cap bulges past the end rather than folding back
     *  over the stroke. `n` is the left normal, `d` the outgoing direction; the
     *  left normal is `d` rotated +90°, so the sweep that passes through `d`
     *  runs clockwise. */
    const cap = (vi: number, n: [number, number]) => {
        const steps = Math.ceil(Math.PI / step);
        for (let k = 1; k < steps; k++) {
            const [rx, ry] = rot(n[0], n[1], -Math.PI * (k / steps));
            out.push([pts[vi][0] + rx, pts[vi][1] + ry]);
        }
    };

    // Left side, start → end.
    for (let i = 0; i < segCount; i++) {
        out.push([pts[i][0] + norms[i][0], pts[i][1] + norms[i][1]]);
        out.push([pts[i + 1][0] + norms[i][0], pts[i + 1][1] + norms[i][1]]);
        if (i + 1 < segCount) joint(i + 1, norms[i], norms[i + 1]);
    }
    cap(segCount, norms[segCount - 1]);

    // Right side, end → start. The right normal is the negated left normal, so
    // the joint sweeps run in the mirrored order.
    for (let i = segCount - 1; i >= 0; i--) {
        const nx = -norms[i][0], ny = -norms[i][1];
        out.push([pts[i + 1][0] + nx, pts[i + 1][1] + ny]);
        out.push([pts[i][0] + nx, pts[i][1] + ny]);
        if (i > 0) joint(i, [-norms[i][0], -norms[i][1]], [-norms[i - 1][0], -norms[i - 1][1]]);
    }
    cap(0, [-norms[0][0], -norms[0][1]]);

    if (out.length < 3) return null;
    out.push([out[0][0], out[0][1]]);
    return out;
}

/**
 * A centreline stroke as the region it covers. `closed` re-enters the first
 * point so a closed subpath's seam gets the same round treatment as any other
 * joint.
 */
export function strokeToRegion(points: Ring, strokeWidth: number, closed = false, tolerance = ARC_TOLERANCE): MultiPolygon {
    const pts = closed && points.length > 1 ? (points.concat([points[0]]) as Ring) : points;
    const ring = strokeOutlineRing(pts, strokeWidth / 2, tolerance);
    if (!ring) return [];
    // Self-intersections from tight turns are resolved here. Snapped first
    // because a hairpin produces exactly the near-degenerate vertices Martinez
    // chokes on, and a stroke this fails on would take the whole fill with it.
    const raw: MultiPolygon = [[ring]];
    try {
        return union(snapMultiPolygon(raw));
    } catch {
        try {
            return union(raw);
        } catch {
            // Hand back the unresolved outline. It still covers the right area,
            // and the caller's own union gets another chance to resolve it —
            // which is strictly better than dropping the stroke and letting the
            // fill escape through a wall that should have been there.
            return raw;
        }
    }
}

/**
 * Grow (or, with a negative delta, shrink) a region by `delta` in every
 * direction, with round corners.
 *
 * `region ⊕ disc_δ  =  region ∪ (boundary ⊕ disc_δ)` — so every ring of the
 * input is stroked at width 2δ and unioned back in. Holes shrink and outers
 * grow from the same operation, because a hole's boundary band lands inside the
 * hole.
 *
 * A negative delta is the mirror image: the boundary band is subtracted rather
 * than added. That is not what this is for and is not implemented — the fill
 * pipeline only ever grows.
 */
export function inflateMultiPolygon(mp: MultiPolygon, delta: number, tolerance = ARC_TOLERANCE): MultiPolygon {
    if (delta <= 0 || mp.length === 0) return mp;
    const bands: Polygon[] = [];
    for (const poly of mp) {
        for (const ring of poly) {
            // Every ring is closed, so it is stroked as a polyline that returns
            // to its own start; the two coincident end caps there simply add the
            // disc a round join would have added at that vertex anyway.
            const outline = strokeOutlineRing(closedAsPolyline(ring), delta, tolerance);
            if (outline) bands.push([outline]);
        }
    }
    if (bands.length === 0) return mp;
    try {
        return union(snapMultiPolygon(mp), ...bands.map(b => snapMultiPolygon([b])));
    } catch {
        try {
            return union(mp as MultiPolygon, ...bands);
        } catch {
            // Growth is a refinement, not the result. Returning the input
            // un-grown costs a hairline gap along the ink; throwing would lose
            // the whole fill.
            return mp;
        }
    }
}

function closedAsPolyline(ring: Ring): Ring {
    if (ring.length < 2) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return ring;
    return ring.concat([[first[0], first[1]]]) as Ring;
}
