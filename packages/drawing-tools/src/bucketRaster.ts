import type { Ring, MultiPolygon } from 'polygon-clipping';
import type { PathData } from './types.ts';
import { drawPathBarrier } from './raster.ts';
import { ringsToMultiPolygon, simplifyRing } from './rings.ts';
import {
    emptyStats, fail, finishFill, isBarrierPath, now, resolveFillOptions,
    type FillOptions, type FillOutcome, type FillRequest, type FillStats
} from './bucketFill.ts';

/** Bucket fill, engine A: flood a bitmap, then trace the result back to vectors.
 *
 *  Rasterising is not a compromise here — it is what makes the tool behave the
 *  way people expect a paint bucket to. A region is "what you could pour paint
 *  into", which is a question about coverage, and coverage is exactly what a
 *  bitmap answers. The vector engine (`bucketVector.ts`) answers a different,
 *  stricter question — "which face of the stroke arrangement is this?" — and
 *  the two disagree in interesting ways on real drawings, which is why both
 *  exist.
 *
 *  The pipeline: paint every barrier opaque into an offscreen mask → grow the
 *  barriers by the gap-closing radius → 4-connected scanline flood from the
 *  seed → grow the region back → trace its boundary as closed rings → simplify
 *  → emit one `d`. Everything after the mask exists is pure typed-array work
 *  and runs in Node, which is where it is tested. */

export interface MaskGeometry {
    /** Mask size in pixels. */
    width: number;
    height: number;
    /** Mask pixels per canvas unit. */
    scale: number;
}

export function maskGeometry(canvasWidth: number, canvasHeight: number, scale: number): MaskGeometry {
    return {
        width: Math.max(1, Math.ceil(canvasWidth * scale)),
        height: Math.max(1, Math.ceil(canvasHeight * scale)),
        scale
    };
}

/**
 * Paint the barrier set into `ctx` and read it back as a one-byte-per-pixel
 * mask (1 = wall).
 *
 * The context must belong to a canvas already sized to `geom.width` ×
 * `geom.height`; the caller owns it so the surface can be reused across fills
 * rather than reallocated per click.
 */
export function buildBarrierMask(
    ctx: CanvasRenderingContext2D,
    barriers: PathData[],
    geom: MaskGeometry,
    alphaThreshold: number
): Uint8Array {
    const { width, height, scale } = geom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // One mask pixel is 1/scale user units; anything thinner than that leaves
    // gaps a flood pours through, so hairlines are floored to a full pixel.
    const minStroke = 1 / scale;
    for (const p of barriers) {
        if (!isBarrierPath(p)) continue;
        drawPathBarrier(ctx, p, minStroke);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const img = ctx.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0, a = 3; i < mask.length; i++, a += 4) {
        if (img[a] >= alphaThreshold) mask[i] = 1;
    }
    return mask;
}

/**
 * Grow a mask by `radius` pixels.
 *
 * Alternating 4-neighbour and 8-neighbour passes traces out an octagon rather
 * than the square a repeated 3×3 dilation gives, which is a good enough disc at
 * the radii this is used with (single digits) and costs one pass per pixel of
 * radius. A square would visibly over-fill into corners.
 */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    if (radius <= 0) return mask;
    let src: Uint8Array = mask;
    let dst: Uint8Array = new Uint8Array(mask.length);
    for (let step = 0; step < radius; step++) {
        const diagonal = step % 2 === 1;
        dst.fill(0);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const i = row + x;
                if (!src[i]) continue;
                dst[i] = 1;
                if (x > 0) dst[i - 1] = 1;
                if (x < width - 1) dst[i + 1] = 1;
                if (y > 0) dst[i - width] = 1;
                if (y < height - 1) dst[i + width] = 1;
                if (!diagonal) continue;
                if (x > 0 && y > 0) dst[i - width - 1] = 1;
                if (x < width - 1 && y > 0) dst[i - width + 1] = 1;
                if (x > 0 && y < height - 1) dst[i + width - 1] = 1;
                if (x < width - 1 && y < height - 1) dst[i + width + 1] = 1;
            }
        }
        // Ping-pong the two buffers, but never hand the caller's own mask back
        // as scratch — the barrier mask is dilated more than once (gap closing,
        // then the region grow) and must survive intact.
        if (src === mask) {
            src = dst;
            dst = new Uint8Array(mask.length);
        } else {
            const swap = src;
            src = dst;
            dst = swap;
        }
    }
    return src;
}

export interface FloodResult {
    region: Uint8Array;
    count: number;
    /** True when the flood hit the pixel budget and was abandoned. */
    aborted: boolean;
}

/**
 * 4-connected scanline flood from a seed pixel over everything `barrier` does
 * not mark.
 *
 * Span-based rather than per-pixel: each pop fills a whole horizontal run and
 * only pushes seeds for the runs newly exposed above and below it. On a mask
 * this size (millions of pixels) the per-pixel stack version spends all its time
 * in stack traffic.
 *
 * `maxCount` is the leak guard. A fill that escapes through a gap in the
 * drawing would otherwise flood every remaining pixel and hand back a
 * canvas-sized blob; stopping early makes that both fast and detectable.
 */
export function floodRegion(
    barrier: Uint8Array,
    width: number,
    height: number,
    seedX: number,
    seedY: number,
    maxCount: number
): FloodResult {
    const region = new Uint8Array(barrier.length);
    if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) {
        return { region, count: 0, aborted: false };
    }
    if (barrier[seedY * width + seedX]) return { region, count: 0, aborted: false };

    let count = 0;
    let aborted = false;
    const stack: number[] = [seedX, seedY];

    while (stack.length > 0) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        const row = y * width;
        if (region[row + x] || barrier[row + x]) continue;

        let left = x;
        while (left > 0 && !barrier[row + left - 1] && !region[row + left - 1]) left--;
        let right = x;
        while (right < width - 1 && !barrier[row + right + 1] && !region[row + right + 1]) right++;

        for (let i = left; i <= right; i++) region[row + i] = 1;
        count += right - left + 1;
        if (count > maxCount) { aborted = true; break; }

        // Push one seed per contiguous unvisited run on each adjacent row —
        // pushing every pixel would make the stack the bottleneck.
        for (const ny of [y - 1, y + 1]) {
            if (ny < 0 || ny >= height) continue;
            const nrow = ny * width;
            let inRun = false;
            for (let i = left; i <= right; i++) {
                const open = !barrier[nrow + i] && !region[nrow + i];
                if (open && !inRun) { stack.push(i, ny); inRun = true; }
                else if (!open) inRun = false;
            }
        }
    }

    return { region, count, aborted };
}

/**
 * Trace the boundary of a pixel region as closed rings, in mask-corner
 * coordinates.
 *
 * Rather than marching squares (whose saddle cases are a well-known source of
 * subtly wrong topology), this walks the region's boundary EDGES directly:
 * every filled pixel contributes a unit edge for each of its four sides whose
 * neighbour is empty, oriented so the filled side is consistently on one hand.
 * Chaining those edges head-to-tail yields every ring exactly once, and the
 * winding falls out for free — outer boundaries come out one way, hole
 * boundaries the other.
 *
 * The one ambiguity is a vertex where the region pinches to a point
 * diagonally: two edges arrive and two leave. Pairing them by "turn left"
 * separates the loops correctly; pairing them the other way would weld two
 * distinct rings into a figure-eight.
 */
export function traceRegionRings(region: Uint8Array, width: number, height: number): Ring[] {
    const stride = width + 1;
    const edgeFrom: number[] = [];
    const edgeTo: number[] = [];
    const outgoing = new Map<number, number[]>();

    const addEdge = (fx: number, fy: number, tx: number, ty: number) => {
        const from = fy * stride + fx;
        const index = edgeFrom.length;
        edgeFrom.push(from);
        edgeTo.push(ty * stride + tx);
        const list = outgoing.get(from);
        if (list) list.push(index);
        else outgoing.set(from, [index]);
    };

    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (!region[row + x]) continue;
            if (y === 0 || !region[row - width + x]) addEdge(x, y, x + 1, y);
            if (x === width - 1 || !region[row + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
            if (y === height - 1 || !region[row + width + x]) addEdge(x + 1, y + 1, x, y + 1);
            if (x === 0 || !region[row + x - 1]) addEdge(x, y + 1, x, y);
        }
    }

    const used = new Uint8Array(edgeFrom.length);
    const rings: Ring[] = [];

    for (let start = 0; start < edgeFrom.length; start++) {
        if (used[start]) continue;
        const ring: Ring = [];
        let edge = start;
        const startVertex = edgeFrom[start];

        while (edge >= 0 && !used[edge]) {
            used[edge] = 1;
            const from = edgeFrom[edge];
            ring.push([from % stride, Math.floor(from / stride)]);
            const to = edgeTo[edge];
            if (to === startVertex) break;

            const candidates = outgoing.get(to);
            if (!candidates) { edge = -1; break; }

            const inDx = (to % stride) - (from % stride);
            const inDy = Math.floor(to / stride) - Math.floor(from / stride);
            let best = -1;
            let bestCross = Infinity;
            for (const c of candidates) {
                if (used[c]) continue;
                const cTo = edgeTo[c];
                const outDx = (cTo % stride) - (to % stride);
                const outDy = Math.floor(cTo / stride) - Math.floor(to / stride);
                // Screen axes (y down): a negative cross is a left turn. Taking
                // the most-left option at a diagonal pinch keeps the two loops
                // that meet there separate.
                const cross = inDx * outDy - inDy * outDx;
                if (cross < bestCross) { bestCross = cross; best = c; }
            }
            edge = best;
        }

        if (ring.length >= 3) {
            ring.push([ring[0][0], ring[0][1]]);
            rings.push(ring);
        }
    }

    return rings;
}

/** Mask-corner coordinates → canvas units. */
export function maskRingToCanvas(ring: Ring, scale: number): Ring {
    return ring.map(([x, y]) => [x / scale, y / scale]) as Ring;
}

export interface RasterFillDeps {
    /** A 2D context whose canvas is sized to the mask. Owned and reused by the
     *  caller — see `maskGeometry`. */
    ctx: CanvasRenderingContext2D;
}

/**
 * Run the raster engine end to end.
 *
 * The canvas surface is the only part that cannot run in Node, which is why it
 * arrives as a dependency rather than being created here.
 */
export function rasterBucketFill(req: FillRequest, deps: RasterFillDeps): FillOutcome {
    const opts: FillOptions = resolveFillOptions(req.options);
    const stats: FillStats = emptyStats('raster');
    const t0 = now();

    const geom = maskGeometry(req.width, req.height, opts.rasterScale);
    const barriers = req.barriers.filter(isBarrierPath);
    stats.barrierCount = barriers.length;

    const tMask = now();
    const rawBarrier = buildBarrierMask(deps.ctx, barriers, geom, opts.alphaThreshold);
    stats.phases.mask = now() - tMask;

    const seedX = Math.floor(req.x * opts.rasterScale);
    const seedY = Math.floor(req.y * opts.rasterScale);
    if (seedX < 0 || seedY < 0 || seedX >= geom.width || seedY >= geom.height) {
        return fail('leaked', 'Click was outside the canvas.', stats, t0);
    }
    if (rawBarrier[seedY * geom.width + seedX]) {
        return fail('on-ink', 'That spot is already covered by ink.', stats, t0);
    }

    const tDilate = now();
    const gapPx = Math.round(opts.gapClose * opts.rasterScale);
    const closedBarrier = dilateMask(rawBarrier, geom.width, geom.height, gapPx);
    stats.phases.dilateBarrier = now() - tDilate;

    // Closing the gaps can swallow the seed itself when the click was within the
    // gap radius of a stroke. Rather than refuse, step to the nearest pixel that
    // is still open — the user clearly meant the region next to that ink.
    const seed = findOpenPixel(closedBarrier, geom.width, geom.height, seedX, seedY, gapPx + 2);
    if (!seed) {
        return fail('on-ink', 'No open space here — try a smaller gap-closing radius.', stats, t0);
    }

    const tFlood = now();
    const maxCount = Math.floor(geom.width * geom.height * opts.maxAreaFraction);
    const flood = floodRegion(closedBarrier, geom.width, geom.height, seed[0], seed[1], maxCount);
    stats.phases.flood = now() - tFlood;

    if (flood.count === 0) {
        return fail('empty', 'Nothing to fill here.', stats, t0);
    }
    if (flood.aborted) {
        stats.areaFraction = flood.count / (geom.width * geom.height);
        return fail(
            'leaked',
            'The fill escaped the shape — increase gap closing, or close the outline.',
            stats, t0
        );
    }

    // Undo the barrier growth and add the tuck-under, in one pass.
    const tGrow = now();
    const growPx = gapPx + Math.round(opts.expand * opts.rasterScale);
    const grown = dilateMask(flood.region, geom.width, geom.height, growPx);
    stats.phases.growRegion = now() - tGrow;

    const tTrace = now();
    const rings = traceRegionRings(grown, geom.width, geom.height);
    stats.phases.trace = now() - tTrace;

    const tSimplify = now();
    // Simplify in mask pixels (so the tolerance scales with resolution), then
    // convert to canvas units once.
    const tolerancePx = opts.simplify * opts.rasterScale;
    const simplified = rings.map(r => maskRingToCanvas(simplifyRing(r, tolerancePx), opts.rasterScale));
    const region: MultiPolygon = ringsToMultiPolygon(simplified);
    stats.phases.simplify = now() - tSimplify;

    return finishFill(region, req, stats, t0, opts);
}

/** Nearest open pixel to (x, y) within `maxRadius`, searched in rings outward. */
function findOpenPixel(
    barrier: Uint8Array, width: number, height: number,
    x: number, y: number, maxRadius: number
): [number, number] | null {
    if (!barrier[y * width + x]) return [x, y];
    for (let r = 1; r <= maxRadius; r++) {
        for (let dy = -r; dy <= r; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            // Only the perimeter of this ring is new.
            const dxs = Math.abs(dy) === r ? range(-r, r) : [-r, r];
            for (const dx of dxs) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                if (!barrier[ny * width + nx]) return [nx, ny];
            }
        }
    }
    return null;
}

function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
}

