import type { Ring, Polygon, MultiPolygon } from 'polygon-clipping';

/** Ring-level geometry shared by both bucket-fill engines.
 *
 *  Both engines end up holding a flat list of closed rings — the raster engine
 *  from tracing a pixel region's boundary, the vector engine from a boolean op —
 *  and both need the same three things afterwards: work out which ring is a hole
 *  of which outer, give every ring the winding that makes the result fillable
 *  with the NONZERO rule, and serialise it to an SVG `d`.
 *
 *  NONZERO, not evenodd, is deliberate: `clipping.ts` runs Clipper2 with
 *  `FillRule.NonZero` and the erase pipeline's own clip output already carries
 *  "holes opposite the outer" winding (see `PathData.clipDerived`). Emitting
 *  fills in the same convention means a bucket fill is just another path to the
 *  eraser — no `fillRule` special-casing anywhere downstream. */

export interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Shoelace. Positive = counterclockwise in math axes (clockwise on screen,
 *  where y grows downward). Sign is all we use it for, plus discarding slivers. */
export function ringSignedArea(ring: Ring): number {
    const n = ring.length;
    if (n < 3) return 0;
    let sum = 0;
    // Rings may or may not repeat the first point at the end; treating the list
    // as implicitly closed handles both, since a repeated point adds a zero term.
    for (let i = 0, j = n - 1; i < n; j = i++) {
        sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return sum / 2;
}

export function ringBox(ring: Ring): Box | null {
    if (ring.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
}

export function boxContains(outer: Box, inner: Box): boolean {
    return outer.minX <= inner.minX && outer.minY <= inner.minY &&
        outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

export function boxesIntersect(a: Box, b: Box): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boxExpand(b: Box, by: number): Box {
    return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

/** Even-odd ray crossing. Points exactly on the boundary are unspecified — every
 *  caller here votes across many samples rather than trusting a single test. */
export function pointInRing(x: number, y: number, ring: Ring): boolean {
    let inside = false;
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/** Is `inner` nested inside `outer`?
 *
 *  Testing one representative point is the textbook approach and the textbook
 *  trap: rings that came out of a boolean op frequently SHARE vertices with the
 *  ring enclosing them, and a shared vertex lands exactly on the boundary where
 *  the crossing test is a coin flip. So sample up to 16 vertices spread around
 *  `inner` and take the majority — a handful of coincident vertices cannot
 *  outvote the interior ones. */
function ringContainsRing(outer: Ring, inner: Ring): boolean {
    const n = inner.length;
    if (n === 0) return false;
    const samples = Math.min(16, n);
    const step = Math.max(1, Math.floor(n / samples));
    let hits = 0, tested = 0;
    for (let i = 0; i < n && tested < samples; i += step) {
        if (pointInRing(inner[i][0], inner[i][1], outer)) hits++;
        tested++;
    }
    return tested > 0 && hits * 2 > tested;
}

/** Ramer–Douglas–Peucker over an open chain, inclusive of both endpoints. */
function rdp(points: Ring, first: number, last: number, tolerance: number, keep: boolean[]): void {
    if (last <= first + 1) return;
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxDistSq = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
        const [px, py] = points[i];
        let distSq: number;
        if (lenSq === 0) {
            const ex = px - ax, ey = py - ay;
            distSq = ex * ex + ey * ey;
        } else {
            // Perpendicular distance to the infinite line through a→b. The chain
            // endpoints are pinned, so clamping t to the segment is unnecessary.
            const cross = (px - ax) * dy - (py - ay) * dx;
            distSq = (cross * cross) / lenSq;
        }
        if (distSq > maxDistSq) {
            maxDistSq = distSq;
            maxIndex = i;
        }
    }
    if (maxIndex < 0 || maxDistSq <= tolerance * tolerance) return;
    keep[maxIndex] = true;
    rdp(points, first, maxIndex, tolerance, keep);
    rdp(points, maxIndex, last, tolerance, keep);
}

/** RDP for a CLOSED ring.
 *
 *  A ring has no endpoints, but RDP needs two, and whichever two it gets are
 *  pinned into the output. Picking them badly is visible: pinning the vertex the
 *  tracer happened to start on leaves a redundant point sitting in the middle of
 *  a straight edge, and which point that is depends on where the trace began —
 *  so the same shape simplifies differently depending on how it was found.
 *
 *  Both pins are therefore chosen to be genuine corners. The ring is first
 *  rotated to start at its lexicographically smallest vertex, which is always a
 *  convex-hull vertex and so can never be mid-edge; the second pin is the vertex
 *  farthest from it, which is also necessarily on the hull. The result depends
 *  only on the shape, not on the traversal that produced it. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
    // Work on the open point list; the closing duplicate is re-added at the end.
    const raw: Ring = ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? (ring.slice(0, -1) as Ring)
        : (ring.slice() as Ring);

    const n = raw.length;
    if (n <= 4 || tolerance <= 0) return closeRing(raw);

    let startIndex = 0;
    for (let i = 1; i < n; i++) {
        if (raw[i][0] < raw[startIndex][0] ||
            (raw[i][0] === raw[startIndex][0] && raw[i][1] < raw[startIndex][1])) {
            startIndex = i;
        }
    }
    const pts: Ring = startIndex === 0
        ? raw
        : (raw.slice(startIndex).concat(raw.slice(0, startIndex)) as Ring);

    let far = 0;
    let farDistSq = -1;
    for (let i = 1; i < n; i++) {
        const dx = pts[i][0] - pts[0][0];
        const dy = pts[i][1] - pts[0][1];
        const dSq = dx * dx + dy * dy;
        if (dSq > farDistSq) { farDistSq = dSq; far = i; }
    }

    const keep = new Array<boolean>(n + 1).fill(false);
    keep[0] = true;
    keep[far] = true;
    keep[n] = true; // sentinel: the wrap-around back to index 0
    // Chain A: 0 → far. Chain B: far → n (i.e. back to 0), addressed through a
    // view that appends the start point so rdp sees an ordinary open chain.
    const wrapped = pts.concat([pts[0]]) as Ring;
    rdp(wrapped, 0, far, tolerance, keep);
    rdp(wrapped, far, n, tolerance, keep);

    const out: Ring = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    // A ring that simplified below a triangle is a sliver; hand back the original
    // rather than something that cannot be filled.
    if (out.length < 3) return closeRing(pts);
    return closeRing(out);
}

function closeRing(pts: Ring): Ring {
    if (pts.length === 0) return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return pts;
    return pts.concat([[first[0], first[1]]]) as Ring;
}

/** Group a flat ring list into outers-with-holes and normalise winding.
 *
 *  Nesting depth decides the role: depth 0 is an outer, depth 1 is one of its
 *  holes, depth 2 is an outer again (an island sitting inside a hole), and so on
 *  — the even-odd reading, which agrees with nonzero for the well-formed,
 *  non-self-intersecting rings both engines produce. Each hole is attached to
 *  the deepest ring that contains it, which is its immediate parent.
 *
 *  Winding is then forced: outers positive, holes negative. That is what makes
 *  the emitted `d` fill correctly under NONZERO. */
export function ringsToMultiPolygon(rings: Ring[]): MultiPolygon {
    const usable: { ring: Ring; box: Box; area: number }[] = [];
    for (const ring of rings) {
        if (ring.length < 3) continue;
        const area = ringSignedArea(ring);
        if (Math.abs(area) < 1e-9) continue;
        const box = ringBox(ring);
        if (!box) continue;
        usable.push({ ring, box, area });
    }
    if (usable.length === 0) return [];

    // Larger rings first, so a ring's potential parents are all earlier in the
    // list and "deepest container" is simply the last match.
    usable.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

    const depth = new Array<number>(usable.length).fill(0);
    const parent = new Array<number>(usable.length).fill(-1);
    for (let i = 0; i < usable.length; i++) {
        for (let j = 0; j < i; j++) {
            if (!boxContains(usable[j].box, usable[i].box)) continue;
            if (!ringContainsRing(usable[j].ring, usable[i].ring)) continue;
            if (depth[j] + 1 > depth[i]) {
                depth[i] = depth[j] + 1;
                parent[i] = j;
            }
        }
    }

    const polygonOf = new Map<number, Polygon>();
    const out: MultiPolygon = [];
    for (let i = 0; i < usable.length; i++) {
        if (depth[i] % 2 !== 0) continue;
        const poly: Polygon = [orient(usable[i].ring, usable[i].area, true)];
        polygonOf.set(i, poly);
        out.push(poly);
    }
    for (let i = 0; i < usable.length; i++) {
        if (depth[i] % 2 === 0) continue;
        const poly = parent[i] >= 0 ? polygonOf.get(parent[i]) : undefined;
        // A hole whose parent somehow wasn't materialised would silently vanish;
        // promoting it to its own outer at least keeps the ink on screen.
        if (poly) poly.push(orient(usable[i].ring, usable[i].area, false));
        else out.push([orient(usable[i].ring, usable[i].area, true)]);
    }
    return out;
}

function orient(ring: Ring, area: number, wantPositive: boolean): Ring {
    const isPositive = area > 0;
    const closed = closeRing(ring);
    return isPositive === wantPositive ? closed : (closed.slice().reverse() as Ring);
}

/** Snap every coordinate to a grid.
 *
 *  polygon-clipping (Martinez) is markedly more robust on grid-snapped input:
 *  full-precision floats produce near-degenerate vertices that make its sweep
 *  line lose track of a segment and throw outright. The eraser already snaps to
 *  0.1 before every clip for exactly this reason (`safeDifference`), and the
 *  fill needs the same protection — it unions far more polygons at once than the
 *  eraser ever does, so it meets the failure sooner. At 0.1 user units the snap
 *  is two orders of magnitude below anything visible. */
export function snapMultiPolygon(mp: MultiPolygon, grid = 0.1): MultiPolygon {
    const inv = 1 / grid;
    return mp.map(poly =>
        poly.map(ring =>
            ring.map(([x, y]) => [Math.round(x * inv) / inv, Math.round(y * inv) / inv]) as Ring
        ) as Polygon
    );
}

export function multiPolygonBox(mp: MultiPolygon): Box | null {
    let out: Box | null = null;
    for (const poly of mp) {
        const b = ringBox(poly[0]);
        if (!b) continue;
        out = out
            ? {
                minX: Math.min(out.minX, b.minX), minY: Math.min(out.minY, b.minY),
                maxX: Math.max(out.maxX, b.maxX), maxY: Math.max(out.maxY, b.maxY)
            }
            : b;
    }
    return out;
}

/** Net area: outers minus holes. Used for the leak guard and the stats readout. */
export function multiPolygonArea(mp: MultiPolygon): number {
    let total = 0;
    for (const poly of mp) {
        for (let i = 0; i < poly.length; i++) {
            total += i === 0 ? Math.abs(ringSignedArea(poly[i])) : -Math.abs(ringSignedArea(poly[i]));
        }
    }
    return total;
}

export function multiPolygonPointCount(mp: MultiPolygon): number {
    let n = 0;
    for (const poly of mp) for (const ring of poly) n += ring.length;
    return n;
}

export function multiPolygonRingCount(mp: MultiPolygon): number {
    let n = 0;
    for (const poly of mp) n += poly.length;
    return n;
}

/** Trim trailing zeros so the emitted `d` doesn't carry "123.4500000000001" for
 *  every one of several thousand points — it bloats both the DOM and the save. */
function fmt(v: number, precision: number): string {
    const s = v.toFixed(precision);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** MultiPolygon → SVG `d`, one closed subpath per ring. */
export function multiPolygonToPathD(mp: MultiPolygon, precision = 2): string {
    const parts: string[] = [];
    for (const poly of mp) {
        for (const ring of poly) {
            if (ring.length < 3) continue;
            // The `Z` closes the subpath, so the explicit repeat of the first
            // point is redundant and just costs bytes.
            const pts = ring.length > 1 &&
                ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
                ? ring.slice(0, -1)
                : ring;
            if (pts.length < 3) continue;
            let d = `M ${fmt(pts[0][0], precision)} ${fmt(pts[0][1], precision)}`;
            for (let i = 1; i < pts.length; i++) {
                d += ` L ${fmt(pts[i][0], precision)} ${fmt(pts[i][1], precision)}`;
            }
            parts.push(d + ' Z');
        }
    }
    return parts.join(' ');
}
