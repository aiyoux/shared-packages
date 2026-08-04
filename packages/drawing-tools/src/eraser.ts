import type { PathData } from './types.ts';
import { parsePath, parseTranslate, sampleArc } from './path.ts';
import { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import { difference, intersection, union } from './clipping.ts';
import { getStroke } from 'perfect-freehand';
import { generateId } from './id.ts';


type Geometry = Polygon | MultiPolygon;
type Point = { x: number; y: number };
type FlatCommand = { type: string; x: number; y: number };
type Interval = { start: number; end: number };

/** Rebase a content-local `clipRect` into world space by the path's translate.
 *  Erase pieces bake the translate into `d` (world-space) and drop `transform`,
 *  so a leftover local `clipRect` would be misread as world space. Mirrors the
 *  same rebase in selection.ts `pieceFrom` and SketchApp `drawPathWithClip`. */
function rebaseClipRect(path: PathData, tx: number, ty: number): PathData['clipRect'] {
    if (!path.clipRect) return undefined;
    return { x: path.clipRect.x + tx, y: path.clipRect.y + ty, width: path.clipRect.width, height: path.clipRect.height };
}

/**
 * How a freehand (perfect-freehand) stroke is erased in `split` mode:
 * the eraser is subtracted from the committed outline polygon with
 * polygon-clipping (`clip`). Pixel-exact, no reshape; cut ends follow the
 * eraser shape. Reuses the hardened filled-shape branch. (The earlier
 * `regenerate` and `cut` strategies were removed — both reshaped or glitched
 * on self-overlapping outlines; clip is the only method now.)
 */

// ---- Clip-erase diagnostics (opt-in; see setClipDiagnosticsEnabled) ----
// Every clip erase of a freehand stroke records an entry here (most recent 12),
// each carrying the full emitted pieces (`d` + bbox + authArea + renderedArea +
// dist-to-eraser) so a stray can be located geometrically. A piece is flagged
// STRAY when its rendered nonzero area exceeds its authoritative area (a hole
// filling solid) OR it's a tiny piece far from the eraser (a stray sliver).
// To report: enable "Clip buffer" in the debug popover, erase where the stray
// appears, then in the console run
//   copy(JSON.stringify(window.__clipBuf))
//
// This is OFF by default and toggled on from the debug popover in dev builds.
// It is genuinely expensive — it copies every emitted piece's full `d` string
// on every freehand/clipDerived candidate — so leaving it on costs real time on
// a dense erase (it is the `recordMs` counter in EraseStats).
let clipDiagnosticsEnabled = false;
/** Enable/disable the verbose per-piece clip diagnostics (`__clipBuf` + the
 *  per-piece `d`/stray capture in `__lastClipDiag`). The cheap fields
 *  (`bailReason`, `rejectReasons`, areas) are always recorded — regression tests
 *  assert on them and they cost nothing. */
export function setClipDiagnosticsEnabled(on: boolean) {
    clipDiagnosticsEnabled = on;
    if (!on) __clipBuf.length = 0;
}
export function areClipDiagnosticsEnabled() { return clipDiagnosticsEnabled; }

let __clipBuf: unknown[] = [];
export function getClipBuf() { return __clipBuf; }
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__clipBuf = __clipBuf;
}
let __lastClipDiag: Record<string, unknown> | null = null;
export function getLastClipDiag() { return __lastClipDiag; }

// Records one clip-freehand erase. Always attaches the full stroke source +
// eraser so the exact failing input can be replayed locally; attaches the full
// emitted piece `d`s so the stray geometry is captured verbatim.
function recordClipErase(path: PathData, eraserPoints: Point[], radius: number, diag: Record<string, unknown> | null) {
    if (!clipDiagnosticsEnabled) return;
    if (!diag) return;
    const src = path.freehandSource;
    const pieces = diag.pieces as Array<{ d: string; stray?: string }> | undefined;
    const entry: Record<string, unknown> = {
        radius,
        eraserPoints,
        transform: path.transform ?? null,
        diag
    };
    if (src) entry.freehand = { points: src.points, options: src.options };
    __clipBuf.push(entry);
    if (__clipBuf.length > 12) __clipBuf.shift();
    // Re-attach on every record so a hot-reload can never leave window.__clipBuf
    // dangling (pointing at a stale, orphaned array from a previous module instance).
    if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__clipBuf = __clipBuf;
    }
    const flagged = (pieces || []).filter(p => p.stray);
    if (flagged.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
            `[CLIP-STRAY] ${flagged.length} stray piece(s) on this erase — ` +
            `run copy(JSON.stringify(window.__clipBuf.at(-1))) and paste. ` +
            flagged.map(p => p.stray).join(' | ')
        );
    }
}

// ---- Erase performance counters ----
// Accumulated across one erase drag (reset on pointerdown, read anytime — the
// debug popover polls it live via the store's eraseEditTick). Purely
// diagnostic: never read by any drawing/erase logic, so it can't affect
// correctness. Kept coarse-grained (a handful of counters + summed ms per
// phase) rather than per-move detail, since the goal is "where does an erase
// drag's time actually go", not a full profiler.
export type EraseStats = {
    /** Erase moves (pointer samples) processed since the last reset. */
    moves: number;
    /** Paths handed to splitOnePathByEraser (grid candidates, or every path
     *  when the spatial grid is off) since the last reset. */
    pathsChecked: number;
    /** Rejected by the cheap pre-flatten bbox broadphase (no geometry work). */
    bboxRejected: number;
    /** Went through the closed-filled-path branch (polygon-clipping subject +
     *  difference) — freehand strokes and their split pieces, plus filled
     *  shapes. */
    closedFilledChecked: number;
    /** Rejected by closedPathMayIntersectEraser after the subject was built —
     *  candidate touched the bbox but the eraser doesn't actually overlap it. */
    mayIntersectRejected: number;
    /** Subject-geometry builds (the union() over a path's rings) + total ms.
     *  Counts CACHE MISSES only — subjects are cached per path identity
     *  (subjectCache), so this should be ~one per path touched per drag, not
     *  per move. A high count relative to grid candidates means paths are
     *  being replaced (split) often, which is expected while actively cutting. */
    subjectBuilds: number;
    subjectMs: number;
    /** safeDifference calls (the polygon-clipping subtract) + total ms. */
    differenceCalls: number;
    differenceMs: number;
    /** Total ms inside splitClosedFilledPath — the difference call (already
     *  counted in differenceMs) PLUS everything wrapped around it: the dropped-
     *  hole repair pass, the per-polygon artifact guards (polygonWithinSubject /
     *  polygonIsValidResult / polygonIsSpuriousFarPiece), and piece emission.
     *  (closedFilledSplitMs − differenceMs) isolates the guard/repair cost. */
    closedFilledSplitMs: number;
    /** Total ms in recordClipErase — the __clipBuf diagnostic write (copies
     *  every emitted piece's full `d` string into a ring buffer). Runs for
     *  every freehand-or-clipDerived candidate every move; on a drawing made
     *  mostly of already-split pieces that's nearly every candidate, so this
     *  is pure diagnostic overhead worth knowing the cost of. */
    recordMs: number;
    /** localEraserRegion calls + total ms: per-candidate construction of the
     *  eraser's swept region (scan the trail for segments reaching this path's
     *  bbox, build a capsule per hit, union them). On a LONG trail this is the
     *  other half of the drag-end cost besides the differences — the scan is
     *  O(trail length) per candidate, and each local union is its own Martinez
     *  call. `eraserRegionCachedHits` counts candidates that reused the
     *  ctx-cached full-trail union instead of building their own. */
    eraserRegionCalls: number;
    eraserRegionMs: number;
    eraserRegionCachedHits: number;
    /** Vertex count of the full-trail eraser polygon (snapshot) — the size every
     *  difference that uses it has to chew through. */
    eraserPolygonVerts: number;
    /** Total PathData pieces emitted by all splits since the last reset (a
     *  proxy for how much the drawing is fragmenting as you erase). */
    piecesEmitted: number;
    /** Wall time of the store's erasePathsWithPoints calls (the true per-move
     *  cost the user feels), summed since the last reset. */
    totalMs: number;
    /** Total paths in the document as of the most recent move (a snapshot, not
     *  summed) — the O(N) side of the spatial-grid tradeoff. */
    lastDocPathCount: number;
    /** Grid query result size (candidates near the eraser) as of the most
     *  recent move — only set when the spatial grid path ran. `-1` means the
     *  grid wasn't used this move (fallback full-array path). Compare against
     *  lastDocPathCount to judge whether the grid is actually narrowing the
     *  work, or whether pathsChecked (post-lock-filter) is now cheap enough
     *  that the store's own O(N) id-scan (idea #6) is the real ceiling. */
    lastGridCandidates: number;
};

const zeroEraseStats = (): EraseStats => ({
    moves: 0,
    pathsChecked: 0,
    bboxRejected: 0,
    closedFilledChecked: 0,
    mayIntersectRejected: 0,
    subjectBuilds: 0,
    subjectMs: 0,
    differenceCalls: 0,
    differenceMs: 0,
    closedFilledSplitMs: 0,
    recordMs: 0,
    eraserRegionCalls: 0,
    eraserRegionMs: 0,
    eraserRegionCachedHits: 0,
    eraserPolygonVerts: 0,
    piecesEmitted: 0,
    totalMs: 0,
    lastDocPathCount: 0,
    lastGridCandidates: -1
});

let eraseStats: EraseStats = zeroEraseStats();

/** Zero every counter. Call at the start of an erase drag (pointerdown) so the
 *  numbers reflect "this gesture", not the whole session. */
export function resetEraseStats() {
    eraseStats = zeroEraseStats();
}

/** A snapshot copy (not the live object) — safe to read from a reactive $effect
 *  without aliasing internal state. */
export function getEraseStats(): EraseStats {
    return { ...eraseStats };
}

/** Record one store-level move's wall time. Called by sketchStore around each
 *  erasePathsWithPoints call — the only place that knows a "move" boundary. */
export function recordEraseMoveTime(ms: number) {
    eraseStats.moves++;
    eraseStats.totalMs += ms;
}

/** Record the document size and (if the spatial grid ran) its candidate-set
 *  size for the move just completed. Snapshot, not accumulated — see
 *  EraseStats.lastDocPathCount. */
export function recordEraseGridInfo(docPathCount: number, gridCandidates: number) {
    eraseStats.lastDocPathCount = docPathCount;
    eraseStats.lastGridCandidates = gridCandidates;
}



const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

const quadAt = (p0: number, p1: number, p2: number, t: number) => {
    const mt = 1 - t;
    return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
};

const distToSegmentSq = (px: number, py: number, vx: number, vy: number, wx: number, wy: number) => {
    const l2 = (vx - wx) ** 2 + (vy - wy) ** 2;
    if (l2 === 0) return (px - vx) ** 2 + (py - vy) ** 2;
    let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (px - (vx + t * (wx - vx))) ** 2 + (py - (vy + t * (wy - vy))) ** 2;
};

const addCircleInterval = (intervals: Interval[], a: Point, b: Point, center: Point, radius: number) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const fx = a.x - center.x;
    const fy = a.y - center.y;
    const aa = vx * vx + vy * vy;
    if (aa === 0) {
        if (fx * fx + fy * fy <= radius * radius) intervals.push({ start: 0, end: 1 });
        return;
    }

    const bb = 2 * (fx * vx + fy * vy);
    const cc = fx * fx + fy * fy - radius * radius;
    const discriminant = bb * bb - 4 * aa * cc;
    if (discriminant < 0) return;

    const root = Math.sqrt(discriminant);
    const t1 = (-bb - root) / (2 * aa);
    const t2 = (-bb + root) / (2 * aa);
    const start = Math.max(0, Math.min(t1, t2));
    const end = Math.min(1, Math.max(t1, t2));
    if (start <= end) intervals.push({ start, end });
};

const addStripInterval = (intervals: Interval[], a: Point, b: Point, c: Point, d: Point, radius: number) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = d.x - c.x;
    const wy = d.y - c.y;
    const wLenSq = wx * wx + wy * wy;
    if (wLenSq === 0) return;

    const px = a.x - c.x;
    const py = a.y - c.y;
    const projA = (px * wx + py * wy) / wLenSq;
    const projB = (vx * wx + vy * wy) / wLenSq;
    const crossA = px * wy - py * wx;
    const crossB = vx * wy - vy * wx;
    const limit = radius * Math.sqrt(wLenSq);

    let start = 0;
    let end = 1;

    const intersectLinearRange = (base: number, slope: number, min: number, max: number) => {
        if (Math.abs(slope) < 1e-9) {
            return base >= min && base <= max ? { start: 0, end: 1 } : null;
        }

        const t1 = (min - base) / slope;
        const t2 = (max - base) / slope;
        return { start: Math.min(t1, t2), end: Math.max(t1, t2) };
    };

    const projectionRange = intersectLinearRange(projA, projB, 0, 1);
    const distanceRange = intersectLinearRange(crossA, crossB, -limit, limit);
    if (!projectionRange || !distanceRange) return;

    start = Math.max(start, projectionRange.start, distanceRange.start);
    end = Math.min(end, projectionRange.end, distanceRange.end);

    if (start <= end) intervals.push({ start: Math.max(0, start), end: Math.min(1, end) });
};

const mergeIntervals = (intervals: Interval[]) => {
    const sorted = intervals
        .map(interval => ({ start: Math.max(0, interval.start), end: Math.min(1, interval.end) }))
        .filter(interval => interval.start <= interval.end)
        .sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];

    for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (!last || interval.start > last.end + 1e-6) {
            merged.push(interval);
        } else {
            last.end = Math.max(last.end, interval.end);
        }
    }

    return merged;
};

const intervalFullyCoversSegment = (intervals: Interval[]) => {
    return intervals.length === 1 && intervals[0].start <= 1e-6 && intervals[0].end >= 1 - 1e-6;
};

const erasedIntervalsForSegment = (a: Point, b: Point, eraserPoints: Point[], eraserSegments: { a: Point; b: Point }[], radius: number, padding = 0) => {
    const intervals: Interval[] = [];

    for (const p of eraserPoints) {
        addCircleInterval(intervals, a, b, p, radius);
    }

    for (const segment of eraserSegments) {
        addCircleInterval(intervals, a, b, segment.a, radius);
        addCircleInterval(intervals, a, b, segment.b, radius);
        addStripInterval(intervals, a, b, segment.a, segment.b, radius);
    }

    const merged = mergeIntervals(intervals);
    if (padding <= 0) return merged;

    const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    const paddingT = len > 0 ? padding / len : 0;
    const padded = mergeIntervals(merged.map(interval => ({
        start: interval.start - paddingT,
        end: interval.end + paddingT
    })));

    const rawFullyErases = intervalFullyCoversSegment(merged);
    const paddedFullyErases = intervalFullyCoversSegment(padded);

    return paddedFullyErases && !rawFullyErases ? merged : padded;
};

const flattenPath = (d: string): FlatCommand[] => {
    const commands = parsePath(d);
    const flatCmds: FlatCommand[] = [];
    let lastPt: Point | null = null;
    let startPt: Point | null = null;
    let lastCtrlPt: Point | null = null;

    for (const cmd of commands) {
        const type = cmd.type.toUpperCase();
        if (type === 'M') {
            lastPt = { x: cmd.args[0], y: cmd.args[1] };
            startPt = lastPt;
            flatCmds.push({ type: 'M', x: lastPt.x, y: lastPt.y });
            lastCtrlPt = null;
        } else if (type === 'L' && lastPt) {
            lastPt = { x: cmd.args[0], y: cmd.args[1] };
            flatCmds.push({ type: 'L', x: lastPt.x, y: lastPt.y });
            lastCtrlPt = null;
        } else if (type === 'C' && cmd.args.length >= 6 && lastPt) {
            const p0x = lastPt.x, p0y = lastPt.y;
            const p1x = cmd.args[0], p1y = cmd.args[1];
            const p2x = cmd.args[2], p2y = cmd.args[3];
            const p3x = cmd.args[4], p3y = cmd.args[5];
            const chordLen = Math.sqrt((p3x - p0x) ** 2 + (p3y - p0y) ** 2);
            const ctrlLen = Math.sqrt((p1x - p0x) ** 2 + (p1y - p0y) ** 2) +
                Math.sqrt((p2x - p1x) ** 2 + (p2y - p1y) ** 2) +
                Math.sqrt((p3x - p2x) ** 2 + (p3y - p2y) ** 2);
            const steps = Math.max(4, Math.ceil((chordLen + ctrlLen) / 8));

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                flatCmds.push({ type: 'L', x: cubicAt(p0x, p1x, p2x, p3x, t), y: cubicAt(p0y, p1y, p2y, p3y, t) });
            }
            lastPt = { x: p3x, y: p3y };
            lastCtrlPt = { x: p2x, y: p2y };
        } else if (type === 'Q' && cmd.args.length >= 4 && lastPt) {
            const p0x = lastPt.x, p0y = lastPt.y;
            const p1x = cmd.args[0], p1y = cmd.args[1];
            const p2x = cmd.args[2], p2y = cmd.args[3];
            const chordLen = Math.sqrt((p2x - p0x) ** 2 + (p2y - p0y) ** 2);
            const ctrlLen = Math.sqrt((p1x - p0x) ** 2 + (p1y - p0y) ** 2) + Math.sqrt((p2x - p1x) ** 2 + (p2y - p1y) ** 2);
            const steps = Math.max(4, Math.ceil((chordLen + ctrlLen) / 8));

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                flatCmds.push({ type: 'L', x: quadAt(p0x, p1x, p2x, t), y: quadAt(p0y, p1y, p2y, t) });
            }
            lastPt = { x: p2x, y: p2y };
            lastCtrlPt = { x: p1x, y: p1y };
        } else if (type === 'S' && cmd.args.length >= 4 && lastPt) {
            const p0x = lastPt.x, p0y = lastPt.y;
            const p1x: number = lastCtrlPt ? 2 * p0x - lastCtrlPt.x : p0x;
            const p1y: number = lastCtrlPt ? 2 * p0y - lastCtrlPt.y : p0y;
            const p2x = cmd.args[0], p2y = cmd.args[1];
            const p3x = cmd.args[2], p3y = cmd.args[3];
            const chordLen = Math.sqrt((p3x - p0x) ** 2 + (p3y - p0y) ** 2);
            const ctrlLen = Math.sqrt((p1x - p0x) ** 2 + (p1y - p0y) ** 2) + Math.sqrt((p2x - p1x) ** 2 + (p2y - p1y) ** 2) + Math.sqrt((p3x - p2x) ** 2 + (p3y - p2y) ** 2);
            const steps = Math.max(4, Math.ceil((chordLen + ctrlLen) / 8));

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                flatCmds.push({ type: 'L', x: cubicAt(p0x, p1x, p2x, p3x, t), y: cubicAt(p0y, p1y, p2y, p3y, t) });
            }
            lastPt = { x: p3x, y: p3y };
            lastCtrlPt = { x: p2x, y: p2y };
        } else if (type === 'T' && cmd.args.length >= 2 && lastPt) {
            const p0x = lastPt.x, p0y = lastPt.y;
            const p1x: number = lastCtrlPt ? 2 * p0x - lastCtrlPt.x : p0x;
            const p1y: number = lastCtrlPt ? 2 * p0y - lastCtrlPt.y : p0y;
            const p2x = cmd.args[0], p2y = cmd.args[1];
            const chordLen = Math.sqrt((p2x - p0x) ** 2 + (p2y - p0y) ** 2);
            const ctrlLen = Math.sqrt((p1x - p0x) ** 2 + (p1y - p0y) ** 2) + Math.sqrt((p2x - p1x) ** 2 + (p2y - p1y) ** 2);
            const steps = Math.max(4, Math.ceil((chordLen + ctrlLen) / 8));

            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                flatCmds.push({ type: 'L', x: quadAt(p0x, p1x, p2x, t), y: quadAt(p0y, p1y, p2y, t) });
            }
            lastPt = { x: p2x, y: p2y };
            lastCtrlPt = { x: p1x, y: p1y };
        } else if (type === 'A' && cmd.args.length >= 7 && lastPt) {
            // Baked round primitives (cloud puffs, sun glows, halos) are emitted
            // as arc circles — see svgBake.ts. Before this branch existed they
            // flattened to their start point alone, so they had no rings, no
            // fill subject, and the eraser could not touch them at all.
            // `a` is relative (which is how they are emitted); `A` is absolute.
            const isRelative = cmd.type === 'a';
            let cur: Point = lastPt;
            for (let i = 0; i + 6 < cmd.args.length; i += 7) {
                const rx = cmd.args[i], ry = cmd.args[i + 1];
                const rot = cmd.args[i + 2];
                const largeArc = cmd.args[i + 3], sweep = cmd.args[i + 4];
                const endX: number = isRelative ? cur.x + cmd.args[i + 5] : cmd.args[i + 5];
                const endY: number = isRelative ? cur.y + cmd.args[i + 6] : cmd.args[i + 6];

                for (const pt of sampleArc(cur.x, cur.y, rx, ry, rot, largeArc, sweep, endX, endY)) {
                    flatCmds.push({ type: 'L', x: pt.x, y: pt.y });
                }
                cur = { x: endX, y: endY };
            }
            lastPt = cur;
            lastCtrlPt = null;
        } else if (type === 'H' && lastPt) {
            lastPt = { x: cmd.args[0], y: lastPt.y };
            flatCmds.push({ type: 'L', x: lastPt.x, y: lastPt.y });
            lastCtrlPt = null;
        } else if (type === 'V' && lastPt) {
            lastPt = { x: lastPt.x, y: cmd.args[0] };
            flatCmds.push({ type: 'L', x: lastPt.x, y: lastPt.y });
            lastCtrlPt = null;
        } else if (type === 'Z' && lastPt && startPt) {
            lastPt = startPt;
            flatCmds.push({ type: 'L', x: lastPt.x, y: lastPt.y });
            lastCtrlPt = null;
        }
    }

    return flatCmds;
};

/** Re-serialize flattened commands (already in absolute space) back to a `d`.
 *  Used when a path with a translate is re-issued unsplit: the flat commands
 *  carry the translate baked in, so the transform has to be dropped with it. */
const flatCmdsToD = (flatCmds: FlatCommand[]): string =>
    flatCmds.map((c, i) => `${i === 0 || c.type === 'M' ? 'M' : 'L'} ${c.x.toFixed(EMIT_DECIMALS)} ${c.y.toFixed(EMIT_DECIMALS)}`).join(' ');

const pointBounds = (points: Point[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
};

// Cache of flattened commands + bbox + parsed translate per PathData, keyed by
// object identity. A path's transform is immutable, so its translated flatCmds,
// bbox and (tx,ty) are stable. The incremental erase model pushes untouched paths
// through unchanged (same object), so after the first move that sees a path, every
// later move reuses the cache — skipping parsePath + flattenPath AND the
// parseTranslate regex (which previously ran once per path per move, the dominant
// per-path cost on a dense drawing). Touched paths become new objects (cache miss
// → recompute), but those are the few near the eraser. Entries are GC'd with their
// path objects (WeakMap).
const flattenCache = new WeakMap<PathData, { flatCmds: FlatCommand[]; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null; tx: number; ty: number }>();
const cachedFlatten = (path: PathData) => {
    let entry = flattenCache.get(path);
    if (!entry) {
        const [tx, ty] = parseTranslate(path.transform);
        const flatCmds = translateFlatCommands(flattenPath(path.d), tx, ty);
        const bbox = flatCmds.length ? pointBounds(flatCmds.map(({ x, y }) => ({ x, y }))) : null;
        entry = { flatCmds, bbox, tx, ty };
        flattenCache.set(path, entry);
    }
    return entry;
};

const translateFlatCommands = (flatCmds: FlatCommand[], tx: number, ty: number) => {
    if (tx === 0 && ty === 0) return flatCmds;
    return flatCmds.map(cmd => ({ ...cmd, x: cmd.x + tx, y: cmd.y + ty }));
};

/**
 * Fade eraser policy. Rather than cutting ink away, each pass multiplies the
 * opacity of whatever sits under the eraser, so repeated passes wear a stroke
 * down the way a real rubber does.
 *
 * Opacity is QUANTIZED to a fixed ladder. Two reasons, both about keeping the
 * document from exploding: neighbouring pieces that land on the same rung can
 * be merged back into one path, and repeated passes converge onto rungs instead
 * of generating an endless spread of distinct values. Anything that falls below
 * the floor is dropped outright — otherwise a stroke never actually goes away
 * and the path count only ever grows.
 */
export type FadeOptions = {
    factor: number;
    floor: number;
    /** Whether scrubbing back and forth WITHOUT lifting the pointer keeps
     *  wearing the ink down. The trail is cut into passes at each reversal and
     *  each pass applies its own fade step, so a scrub darkens the gap the way
     *  rubbing harder does. Off means one step per pointerdown→pointerup. */
    accumulate?: boolean;
    /**
     * Treat ink stacked under the eraser as ONE body rather than a pile of
     * independent strokes.
     *
     * Without this, each stroke steps down its own ladder. Three opaque strokes
     * on top of each other faded once are each 0.55, but stacked they still
     * composite to 1-(1-0.55)^3 = 0.91 — barely touched. Keep going and the top
     * one thins out first, so the result reads as peeling layers apart rather
     * than erasing: the lines underneath are revealed instead of removed.
     *
     * With it, each stroke is faded to whatever value makes the STACK land on
     * the ladder: a = 1-(1-target)^(1/depth). The pile lightens together, which
     * is what a real eraser does.
     */
    normalizeStack?: boolean;
};

/** Overlap area, in square units, below which flattening leaves well alone. */
const MIN_WORTHWHILE_TRIM = 4;

/**
 * `floor` is the opacity below which a piece is removed rather than kept at a
 * whisker of alpha — ink has to be able to GO, not linger invisibly and keep
 * being split forever.
 *
 * It has to sit below what anyone can see, because the mask standing in during
 * the rub has no floor: it just keeps multiplying. At 0.08 the stand-in showed a
 * faint 8% of ink and then the commit deleted it outright, so a long scrub
 * jumped to blank the moment the pass landed. At 0.02 the two part company only
 * where nothing is left to see.
 */
export const DEFAULT_FADE: FadeOptions = { factor: 0.55, floor: 0.02, accumulate: true };

/**
 * Eraser intensity as a 1..5 dial, mapped to how much of the ink one pass takes.
 * Gentler settings need more rungs to reach the floor, which is what makes a
 * light rub feel gradual and a heavy one bite; the ladder quantization keeps
 * every setting converging rather than trailing off into ever-fainter ink.
 */
export const FADE_INTENSITY_FACTORS: Record<number, number> = {
    1: 0.8,
    2: 0.68,
    3: 0.55,
    4: 0.42,
    5: 0.3
};

export function fadeForIntensity(intensity: number, base: FadeOptions = DEFAULT_FADE): FadeOptions {
    const clamped = Math.max(1, Math.min(5, Math.round(intensity)));
    return { ...base, factor: FADE_INTENSITY_FACTORS[clamped] ?? base.factor };
}

/**
 * How near the trail has to come to its own earlier path, at the moment it
 * reverses, for the reversal to count as a second pass over the same ink —
 * as a multiple of `minBacktrack` (an eraser radius).
 *
 * At this separation the two legs' swept corridors still overlap over half
 * their width, so the return really is rubbing ink the outward leg already
 * touched. See `retracesOwnPath`.
 */
const RETRACE_NEARNESS = 1;

/**
 * Does the trail at `b` sit back on top of the part of `current` it swept
 * BEFORE the reversal — or has it merely turned a corner and headed off?
 *
 * The recent tail is excluded: every reversal is trivially close to the points
 * it just came through, and those are the ones the turn itself laid down. The
 * skip covers the whole reversal (`minBacktrack` of backtrack, by definition)
 * plus the nearness margin, so the corner cannot answer the question about
 * itself — without the margin a right-angle hook reads as a retrace of its own
 * turn, which is the shape this exists to tell apart.
 */
const retracesOwnPath = (current: Point[], b: Point, minBacktrack: number): boolean => {
    const skipBy = minBacktrack * (1 + RETRACE_NEARNESS);
    let skipped = 0;
    let i = current.length - 1;
    for (; i > 1; i--) {
        skipped += Math.hypot(current[i].x - current[i - 1].x, current[i].y - current[i - 1].y);
        if (skipped >= skipBy) break;
    }
    const nearSq = (minBacktrack * RETRACE_NEARNESS) ** 2;
    for (let k = 1; k <= i; k++) {
        const v = current[k - 1], w = current[k];
        if (distToSegmentSq(b.x, b.y, v.x, v.y, w.x, w.y) <= nearSq) return true;
    }
    return false;
};

/**
 * Cut an eraser trail into individual passes, splitting wherever the stroke
 * doubles back OVER ITSELF.
 *
 * A single drag that scrubs to and fro is one trail, and unioning it means the
 * second sweep over a spot changes nothing — the ink just sits at the first
 * step. Splitting at the reversals turns that scrub back into the sequence of
 * passes the user actually made.
 *
 * Reversal is measured against the pass's own heading and requires a real
 * backtrack (`minBacktrack`, an eraser radius) before it counts, so hand jitter
 * along a straight sweep does not shatter it into dozens of passes.
 *
 * Turning a sharp corner is NOT a second pass, and treating it as one is what
 * stamped a circle just after every hook: each pass is swept with a round cap,
 * so a seam laid down where the trail turns puts two caps — a whole disc of
 * double-strength erase — on ink the gesture only crossed once. Where the trail
 * genuinely comes back over itself that disc is buried inside the overlap of
 * the two legs and no one can see it; where the legs part company it is the
 * only doubled thing in the picture. So a reversal only splits when the trail
 * has actually returned to its own earlier path (`retracesOwnPath`); a corner
 * just re-aims the heading and carries on in the same pass.
 */
export function splitTrailIntoPasses(points: Point[], minBacktrack: number): Point[][] {
    if (points.length < 2) return [points];

    const passes: Point[][] = [];
    let current: Point[] = [points[0]];
    let heading: { x: number; y: number } | null = null;
    let forward = 0;
    let backward = 0;

    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len = Math.hypot(vx, vy);
        current.push(b);
        if (len < 1e-6) continue;

        if (!heading) {
            heading = { x: vx / len, y: vy / len };
            forward = len;
            backward = 0;
            continue;
        }

        const along = vx * heading.x + vy * heading.y;
        if (along < 0) backward -= along;
        // Moving forward again bleeds off a little of the backtrack so a wobble
        // part-way through a long sweep cannot slowly accumulate into a split.
        else backward = Math.max(0, backward - along * 0.5);
        if (along > 0) forward += along;

        if (backward > minBacktrack && forward > minBacktrack) {
            if (!retracesOwnPath(current, b, minBacktrack)) {
                // A corner, not a second pass. Re-aim and stay in this sweep,
                // or the same reversal fires again on every point after it.
                heading = { x: vx / len, y: vy / len };
                forward = len;
                backward = 0;
                continue;
            }
            passes.push(current);
            // The reversal point starts the next pass too, so coverage stays
            // continuous across the seam.
            current = [b];
            heading = null;
            forward = 0;
            backward = 0;
        }
    }

    if (current.length > 1) passes.push(current);
    return passes.length > 0 ? passes : [points];
}

/** Opacity rungs, coarse enough that scrubbing converges quickly. */
/**
 * Opacity is quantized so repeated passes are REPEATABLE: two pieces faded the
 * same number of times land on the same value and can be merged back into one
 * path, instead of the document accumulating a spread of near-identical
 * opacities.
 *
 * Two decimal places rather than a handful of fixed rungs. A coarse table made
 * every intensity below ~0.7 collapse onto the same ladder, and its rounding
 * compounded — each step re-multiplied an already-rounded value, so the commit
 * drifted well below the smooth curve the preview draws.
 */
export function quantizeFade(opacity: number): number {
    return Math.round(opacity * 100) / 100;
}

/** The opacity a piece takes after one pass of the fade eraser, or null when
 *  it has worn away entirely. */
/**
 * What one pass of the fade eraser leaves behind.
 *
 * ONE MULTIPLY, and deliberately so: the drag shows a mask stroke at `factor`
 * while the geometry is still being worked out, and the moment the two disagree
 * the picture jumps as the real result lands. A mask multiplies whatever is
 * under it; so does this. Nothing to quantize, nothing to round, nothing that
 * can drift apart from the stand-in the eye is already looking at.
 *
 * (It used to walk a quantized ladder of rungs. That is why fade could not show
 * a preview at all for so long — no mask can imitate a ladder, least of all on
 * stacked ink, where the composite of several faded strokes bears no relation to
 * a single flat alpha.)
 *
 * Null when the ink has worn through and the piece should be removed.
 */
export function fadedOpacity(current: number | undefined, fade: FadeOptions): number | null {
    const base = current ?? 1;
    const next = base * fade.factor;
    if (next < fade.floor || next >= base) return null;
    return next;
}

/** What one pass leaves this piece at, or null when it has worn through. */
export function fadeStep(path: PathData, fade: FadeOptions): { opacity: number } | null {
    const next = fadedOpacity(path.opacity, fade);
    return next === null ? null : { opacity: next };
}

/**
 * The opacities a fully-opaque stroke lands on after each successive pass,
 * ending in 0 once it wears through.
 *
 * The live preview needs this because it fades by compositing, which gives a
 * CONTINUOUS `factor^n`, while the committed pass walks a quantized ladder and
 * re-multiplies from each already-rounded rung. Those diverge fast — by the
 * third pass the commit is ~28% darker than the preview, and on the fourth the
 * preview still shows faint ink where the commit has deleted it. Driving the
 * preview off this sequence instead keeps the two in step.
 */
export function fadeSequence(fade: FadeOptions, maxPasses = 32): number[] {
    const out: number[] = [];
    let current = 1;
    for (let i = 0; i < maxPasses; i++) {
        const next = fadedOpacity(current, fade);
        if (next === null) { out.push(0); break; }
        out.push(next);
        current = next;
    }
    return out;
}

export function isClosedFilledPath(path: PathData) {
    return !!(path.d.toUpperCase().includes('Z') && path.fill && path.fill !== 'none');
}

const closeRing = (points: Point[]): Ring => {
    const ring: Ring = points.map(p => [p.x, p.y]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
        ring.push([first[0], first[1]]);
    }
    return ring;
};

const flatPathToRings = (flatCmds: FlatCommand[]): Ring[] => {
    const rings: Ring[] = [];
    let current: Point[] = [];

    for (const cmd of flatCmds) {
        if (cmd.type === 'M') {
            if (current.length >= 3) rings.push(closeRing(current));
            current = [{ x: cmd.x, y: cmd.y }];
        } else if (cmd.type === 'L') {
            const last = current[current.length - 1];
            if (!last || Math.abs(last.x - cmd.x) >= 0.01 || Math.abs(last.y - cmd.y) >= 0.01) {
                current.push({ x: cmd.x, y: cmd.y });
            }
        }
    }

    if (current.length >= 3) rings.push(closeRing(current));
    return rings;
};

const ringCentroid = (ring: Ring) => {
    const points = normalizedRingPoints(ring);
    const sum = points.reduce((acc, [x, y]) => ({ x: acc.x + x, y: acc.y + y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
};

// A point strictly INSIDE a ring. Tries the centroid first (one point-in-polygon
// test — correct for the common convex-ish hole), then falls back to grid-
// scanning the ring's bbox for the first sample the ray-cast test accepts. The
// fallback exists because a concave ring's centroid can fall OUTSIDE it (e.g.
// the C-shaped gaps between crossing freehand strands).
//
// Memoized per ring object: the erase guards ask for the same subject holes'
// interior points every move (the dropped-hole repair pass AND the detection
// pass both ask), and with the subject geometry cached per path the ring
// objects are stable across moves — so after the first move this is a WeakMap
// hit instead of a bbox grid scan. The profiling counters showed these scans
// inside "split guards/repair" as the single biggest erase cost.
const interiorPointCache = new WeakMap<Ring, Point | null>();
const interiorPointOfRing = (ring: Ring): Point | null => {
    const cached = interiorPointCache.get(ring);
    if (cached !== undefined) return cached;
    const result = computeInteriorPointOfRing(ring);
    interiorPointCache.set(ring, result);
    return result;
};

const computeInteriorPointOfRing = (ring: Ring): Point | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) return null;
    const centroid = ringCentroid(ring);
    if (pointInsidePolygon(centroid, ring)) return centroid;
    const step = 2;
    for (let y = minY + step / 2; y < maxY; y += step) {
        for (let x = minX + step / 2; x < maxX; x += step) {
            const p = { x, y };
            if (pointInsidePolygon(p, ring)) return p;
        }
    }
    return null;
};

// Subject fill geometry cached per path identity, same contract as
// flattenCache: a path object's d/transform never mutate (splits emit new
// objects), so its subject MultiPolygon is stable for the object's lifetime.
// Before this cache the subject was rebuilt (union of all rings for freehand /
// clip-derived paths) for EVERY candidate near the eraser on EVERY move — the
// profiling counters showed thousands of rebuilds per drag on a dense drawing.
// The subject is read-only downstream (difference/guards never mutate it), and
// stable ring objects are what make interiorPointCache effective. `null` is a
// valid cached value (unparseable geometry), so absence is `undefined`.
const subjectCache = new WeakMap<PathData, MultiPolygon | null>();
const cachedSubject = (path: PathData, flatCmds: FlatCommand[]): MultiPolygon | null => {
    let entry = subjectCache.get(path);
    if (entry === undefined) {
        const t0 = performance.now();
        entry = flatPathToFillGeometry(path, flatCmds);
        eraseStats.subjectBuilds++;
        eraseStats.subjectMs += performance.now() - t0;
        subjectCache.set(path, entry);
    }
    return entry;
};

// Per-subject-polygon outer bboxes, keyed on the SUBJECT array (stable object
// identity, since cachedSubject returns the same array every cache hit) rather
// than the path — computed once ever per path's subject, not once per move and
// not once per candidate result polygon (polygonIsValidResult runs once per
// piece emitted, and a split can emit several). Read-only downstream.
const subjectPolyBoundsCache = new WeakMap<MultiPolygon, { minX: number; minY: number; maxX: number; maxY: number }[]>();
const cachedSubjectPolyBounds = (subject: MultiPolygon) => {
    let bounds = subjectPolyBoundsCache.get(subject);
    if (!bounds) {
        bounds = subject.map(subjPoly => polygonOuterBounds(subjPoly));
        subjectPolyBoundsCache.set(subject, bounds);
    }
    return bounds;
};

const flatPathToFillGeometry = (path: PathData, flatCmds: FlatCommand[]): MultiPolygon | null => {
    const rings = flatPathToRings(flatCmds).filter(ring => ringArea(ring) >= 0.5);
    if (rings.length === 0) return null;
    if (rings.length === 1 || path.fillRule === 'evenodd') return [rings];

    // Classify each ring as an outer-candidate or a hole-candidate by winding
    // sign relative to the largest ring, then assign each hole to the
    // SMALLEST outer that geometrically contains it — using a reliable
    // interior sample (interiorPointOfRing), not the centroid, which can land
    // outside a concave hole. This is real geometric containment, not a
    // ring-order assumption, so it correctly separates two DIFFERENT
    // situations that a naive "rings[0] is the outer, everything else is its
    // hole" grouping conflates:
    //   - a genuinely separate, non-overlapping solid region (e.g. a
    //     self-crossing scribble with a disconnected loop, or any
    //     multi-subpath freehand/clipDerived stroke) — this must stay its own
    //     outer, or its entire area silently vanishes from the subject before
    //     the eraser is even considered ("a piece disappears that the eraser
    //     never touched" the moment ANY part of the same PathData is erased).
    //   - a true nested hole (a real gap the ink wraps around) — this must
    //     stay a hole of its containing outer, or it renders solid (the
    //     "random part fills in when I erase" glitch).
    // A homeless hole (contained by no outer — a concave/self-overlapping
    // shape edge case) is dropped: pushing it as a standalone outer would
    // render its region solid, which is wrong; dropping leaves it empty,
    // which is what a hole should be.
    const largestRing = rings.reduce((largest, ring) => ringArea(ring) > ringArea(largest) ? ring : largest, rings[0]);
    const outerSign = Math.sign(signedRingArea(largestRing)) || 1;
    const groups: Ring[][] = [];
    const holes: Ring[] = [];

    for (const ring of rings) {
        const sign = Math.sign(signedRingArea(ring)) || outerSign;
        if (sign === outerSign) {
            groups.push([ring]);
        } else {
            holes.push(ring);
        }
    }

    for (const hole of holes) {
        const p = interiorPointOfRing(hole) || ringCentroid(hole);
        let targetIndex = -1;
        let targetArea = Infinity;

        for (let i = 0; i < groups.length; i++) {
            const outer = groups[i][0];
            if (!pointInsidePolygon(p, outer)) continue;

            const area = ringArea(outer);
            if (area < targetArea) {
                targetIndex = i;
                targetArea = area;
            }
        }

        if (targetIndex >= 0) {
            groups[targetIndex].push(hole);
        }
        // else: homeless hole — drop it (see comment above).
    }

    if (groups.length === 0) return null;

    // Freehand/clip-derived outlines additionally get each group run through
    // `union()` — Martinez's own winding/geometry cleanup for a SINGLE solid
    // (with its now-correctly-assigned holes), which resolves self-crossing
    // segments within that one outer that the grouping above can't (grouping
    // only decides which existing rings pair together; it can't fix a ring
    // that self-intersects). Each group is unioned INDEPENDENTLY — critical,
    // since unioning separate groups together is exactly the bug this
    // replaced (a hole-shaped ring with no spatial overlap in a DIFFERENT
    // group would be a no-op "hole" of the wrong outer, silently erasing it).
    // Falls back to the plain grouped polygons for a group whose union throws
    // or comes back empty (still correct, just without the extra cleanup).
    const isFreehand = !!(path.freehandSource && path.freehandSource.points.length > 0) || !!path.clipDerived;
    if (isFreehand) {
        const cleanedGroups: Polygon[] = [];
        for (const group of groups) {
            let resolved: Polygon | undefined;
            try {
                const unified = union(group as Polygon);
                if (unified && unified.length > 0) {
                    const cleaned = unified
                        .map(polygon => polygon.filter(ring => ring && ringArea(ring) >= 0.5))
                        .filter(polygon => polygon.length > 0);
                    if (cleaned.length === 1) resolved = cleaned[0];
                    else if (cleaned.length > 1) {
                        // A single outer's self-union produced multiple disjoint
                        // pieces (rare, e.g. a figure-eight self-crossing outline) —
                        // keep them all as separate groups.
                        cleanedGroups.push(...cleaned);
                        continue;
                    }
                }
            } catch {
                // fall through to the un-cleaned group below
            }
            cleanedGroups.push(resolved ?? group);
        }
        if (cleanedGroups.length > 0) return cleanedGroups;
    }

    return groups;
};

const circlePolygon = (center: Point, radius: number, steps = 40): Polygon => {
    const points: Point[] = [];
    for (let i = 0; i < steps; i++) {
        const angle = (Math.PI * 2 * i) / steps;
        points.push({
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius
        });
    }
    return [closeRing(points)];
};

const capsulePolygon = (a: Point, b: Point, radius: number, steps = 20): Polygon => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) return circlePolygon(a, radius);

    const angle = Math.atan2(dy, dx);
    const points: Point[] = [];

    for (let i = 0; i <= steps; i++) {
        const t = -Math.PI / 2 + (Math.PI * i) / steps;
        points.push({
            x: b.x + Math.cos(angle + t) * radius,
            y: b.y + Math.sin(angle + t) * radius
        });
    }

    for (let i = 0; i <= steps; i++) {
        const t = Math.PI / 2 + (Math.PI * i) / steps;
        points.push({
            x: a.x + Math.cos(angle + t) * radius,
            y: a.y + Math.sin(angle + t) * radius
        });
    }

    return [closeRing(points)];
};

const eraserGeometry = (eraserPoints: Point[], radius: number): Geometry | null => {
    if (eraserPoints.length === 0) return null;

    let geometry: Geometry = circlePolygon(eraserPoints[0], radius);
    for (let i = 1; i < eraserPoints.length; i++) {
        const shape = capsulePolygon(eraserPoints[i - 1], eraserPoints[i], radius);
        geometry = union(geometry, shape) || geometry;
    }

    return geometry;
};

const eraserGeometryParts = (eraserPoints: Point[], radius: number): Polygon[] => {
    if (eraserPoints.length === 0) return [];

    const parts: Polygon[] = [circlePolygon(eraserPoints[0], radius)];
    for (let i = 1; i < eraserPoints.length; i++) {
        parts.push(capsulePolygon(eraserPoints[i - 1], eraserPoints[i], radius));
    }

    return parts;
};

/** The eraser's swept region as a WELL-FORMED MultiPolygon: the boolean union
 *  of a start circle plus one capsule per trail segment — by construction the
 *  exact shape the live preview paints (the trail stroked at width 2·radius
 *  with round caps/joins), so the committed cut matches the preview along its
 *  edges.
 *
 *  This deliberately does NOT use a perfect-freehand single-outline stroke:
 *   - getStroke's smoothing/streamline pull the centerline off the true trail
 *     (visible edge "adjustment" at commit), and
 *   - even with those at 0, the single outline ring SELF-INTERSECTS whenever
 *     the trail curls back within 2·radius of itself — completely ordinary
 *     erasing behavior — and self-intersecting rings are undefined input for
 *     polygon-clipping (Martinez), the prime suspect for its corrupted
 *     differences (shatter/dropped-hole artifacts) on erase.
 *  A union of simple convex parts is the library's happy path and its output
 *  is always well-formed. One union per drag (the result is cached on the
 *  EraserCtx) is affordable now that erasing clips once at pointerup instead
 *  of once per pointer move. Falls back to the raw parts-as-multipolygon
 *  (overlapping but individually well-formed rings, nonzero-equivalent) if the
 *  union itself throws. */
export const eraserOutlinePolygon = (eraserPoints: Point[], radius: number): MultiPolygon | null => {
    if (eraserPoints.length === 0) return null;
    if (eraserPoints.length === 1) return [circlePolygon(eraserPoints[0], radius)];

    // Preferred path: trace the swept region's OUTLINE and self-resolve it.
    //
    // Feeding one capsule per segment to the clipper describes a ~4,800-vertex
    // boundary with 92,407 input vertices — 95% of it interior detail that is
    // computed and then discarded. Tracing the offset outline (see
    // strokeOutlineRing) emits ~9,500 vertices for the same region and measured
    // 658ms -> 30ms (21x) on a real 2149-point trail, with a rasterized
    // difference of 0.0097% against the capsule union.
    //
    // Everything is grid-snapped to the same 0.1 grid safeDifference uses before
    // clipping: a curving trail otherwise makes edges self-touch at
    // near-degenerate coordinates that Martinez chokes on ("Unable to find
    // segment … in SweepLine tree").
    const deduped: Point[] = [eraserPoints[0]];
    for (let i = 1; i < eraserPoints.length; i++) {
        const p = eraserPoints[i], q = deduped[deduped.length - 1];
        if (Math.abs(p.x - q.x) > 1e-9 || Math.abs(p.y - q.y) > 1e-9) deduped.push(p);
    }
    if (deduped.length === 1) return [circlePolygon(deduped[0], radius)];
    // NOTE: Clipper2's native offsetter (InflatePathsD with round joins/caps) was
    // measured as a replacement for strokeOutlineRing and REJECTED — it was ~3x
    // slower for this step (9.8ms vs 3.5ms; it needs a separate union pass to
    // clean and group its flat output, where the ring below needs one self-union)
    // and diverged further from shipped output, not less. Finer arc tolerances
    // made it worse, converging on a true circle and away from the arcs here.
    try {
        const resolved = union(roundPolygon([strokeOutlineRing(deduped, radius)]));
        if (resolved && resolved.length > 0) return resolved;
    } catch {
        // fall through to the capsule union below
    }

    // Fallback: the capsule union. Slower, but a different construction, so it
    // survives cases where the outline ring hits a degeneracy the clipper
    // rejects.
    const parts = eraserGeometryParts(eraserPoints, radius).map(roundPolygon);
    const chunked = unionPolygonsChunked(parts);
    if (chunked) return chunked;
    // Chunked fold failed — try the single-call union before giving up.
    try {
        const unified = union(parts[0], ...parts.slice(1));
        if (unified && unified.length > 0) return unified;
    } catch {
        // fall through
    }
    // Last resort: the raw parts. Both over-removal and a big slowdown are
    // possible here, but reaching this means every union failed — vanishingly
    // rare, and still better than dropping the erase entirely.
    return parts;
};

const unionGeometryParts = (parts: Geometry[]) => {
    if (parts.length === 0) return null;
    return union(parts[0], ...parts.slice(1));
};

/** Douglas-Peucker simplification of an eraser trail. CURRENTLY UNUSED — kept
 *  as a measured, ready-to-enable option (see buildEraserCtx).
 *
 *  A drag samples the pointer far more finely than the swept region needs: a
 *  real capture had 2149 points over 10896px (median 4.5px apart) while the
 *  eraser is 48px wide, so consecutive capsules overlap almost entirely. Every
 *  extra point costs a capsule (~43 verts) in the union AND a scan step in
 *  every pointDistToEraserPathSq call the guards make.
 *
 *  Enabling it at 0.05px took that capture's drag-end pass from 1025ms to 648ms.
 *  It is off by default because, unlike the rest of the erase speedups, it is a
 *  real geometric approximation: the swept region may shift by up to `epsilon`.
 *  Measured cost was 207 differing pixels out of 3.58M versus 48 without it. */
const simplifyTrail = (points: Point[], epsilon = 0.05): Point[] => {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    // Iterative (an explicit stack) rather than recursive: a long trail would
    // otherwise risk blowing the call stack.
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length) {
        const [i0, i1] = stack.pop()!;
        if (i1 - i0 < 2) continue;
        const a = points[i0], b = points[i1];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let best = -1, bestDist = epsilon;
        for (let i = i0 + 1; i < i1; i++) {
            const p = points[i];
            let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = p.x - (a.x + t * dx), ey = p.y - (a.y + t * dy);
            const d = Math.sqrt(ex * ex + ey * ey);
            if (d > bestDist) { bestDist = d; best = i; }
        }
        if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
    }
    const out: Point[] = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
};

/** Angular resolution of the swept-outline arcs. Deliberately identical to the
 *  capsule caps' (a semicircle in `capsulePolygon`'s default 20 steps), so the
 *  outline approximates the true circular sweep exactly as finely as the capsule
 *  union it replaces — measured, finer arcs actually diverge MORE from current
 *  behaviour because they under-cover the true circle less than the caps do. */
const OUTLINE_ARC_STEP = Math.PI / 20;

const pushArcCW = (cx: number, cy: number, from: number, to: number, radius: number, out: Ring) => {
    // Always sweep clockwise (negative), which is the direction the outline ring
    // is traced in; `from`/`to` are absolute angles.
    let d = to - from;
    while (d > 0) d -= 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(d) / OUTLINE_ARC_STEP));
    for (let i = 1; i < steps; i++) {
        const a = from + d * i / steps;
        out.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    }
};

/** The eraser's swept region as a single stroke OUTLINE ring, rather than a
 *  union of one capsule per trail segment.
 *
 *  This is purely a performance construction — the region is the same Minkowski
 *  sum either way — but the input size is radically smaller. A capsule carries
 *  two full 20-step semicircular caps (~43 vertices) and consecutive caps are
 *  buried inside their neighbours, so a real 2149-point trail fed 92,407
 *  vertices into the clipper to describe a boundary of only ~4,800. Tracing the
 *  offset outline instead emits ~2 vertices per trail point plus an arc only
 *  where the trail actually turns: ~9,500 vertices, and the resolve dropped from
 *  658ms to 30ms (21x) with a rasterized difference of 0.0097% against the
 *  capsule union.
 *
 *  The ring self-intersects wherever the trail curls back within 2*radius, which
 *  is ordinary erasing, so the caller must still run it through `union` to
 *  resolve it into a well-formed MultiPolygon.
 *
 *  Join arcs go ONLY on the convex (outer) side of each turn. On the concave
 *  side the two offset segments cross and the self-union resolves them; adding
 *  an arc there instead carves a notch out of the swept region — that bug cost
 *  0.26% of the eraser's coverage (ink left behind where the eraser passed). */
const strokeOutlineRing = (points: Point[], radius: number): Ring => {
    const n = points.length;
    const ang: number[] = [];
    for (let i = 1; i < n; i++) ang.push(Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x));
    // Sign of the turn at each interior vertex: >0 turns left, <0 turns right.
    const cross: number[] = [];
    for (let i = 1; i < ang.length; i++) {
        cross.push(Math.cos(ang[i - 1]) * Math.sin(ang[i]) - Math.sin(ang[i - 1]) * Math.cos(ang[i]));
    }

    const ring: Ring = [];
    // Left side, forward. Its outer side is a RIGHT turn (cross < 0).
    for (let i = 0; i < ang.length; i++) {
        const na = ang[i] + Math.PI / 2;
        const p0 = points[i], p1 = points[i + 1];
        ring.push([p0.x + Math.cos(na) * radius, p0.y + Math.sin(na) * radius]);
        ring.push([p1.x + Math.cos(na) * radius, p1.y + Math.sin(na) * radius]);
        if (i < ang.length - 1 && cross[i] < 0) pushArcCW(p1.x, p1.y, na, ang[i + 1] + Math.PI / 2, radius, ring);
    }
    // End cap.
    const last = points[n - 1], aLast = ang[ang.length - 1];
    pushArcCW(last.x, last.y, aLast + Math.PI / 2, aLast - Math.PI / 2, radius, ring);
    // Right side, backward. Its outer side is a LEFT turn (cross > 0).
    for (let i = ang.length - 1; i >= 0; i--) {
        const na = ang[i] - Math.PI / 2;
        const p0 = points[i], p1 = points[i + 1];
        ring.push([p1.x + Math.cos(na) * radius, p1.y + Math.sin(na) * radius]);
        ring.push([p0.x + Math.cos(na) * radius, p0.y + Math.sin(na) * radius]);
        if (i > 0 && cross[i - 1] > 0) pushArcCW(p0.x, p0.y, na, ang[i - 1] - Math.PI / 2, radius, ring);
    }
    // Start cap, closing the ring.
    const first = points[0], aFirst = ang[0];
    pushArcCW(first.x, first.y, aFirst - Math.PI / 2, aFirst + Math.PI / 2, radius, ring);
    ring.push([ring[0][0], ring[0][1]]);
    return ring;
};

/** Union many polygons far faster than one giant `union(a, ...rest)` call.
 *
 *  Martinez's cost grows steeply with the number of simultaneous inputs, and on
 *  a long trail the single call ALSO tends to hit a degeneracy and throw. Fold
 *  in fixed-size batches, then merge the batch results: measured on a real 2149
 *  capsule trail, 1185ms → 619ms for a bit-identical result. Inputs must already
 *  be grid-snapped (see eraserOutlinePolygon) — that is what keeps it from
 *  throwing. Returns null if any step fails, so callers can fall back. */
const unionPolygonsChunked = (parts: Polygon[], chunk = 64): MultiPolygon | null => {
    if (parts.length === 0) return null;
    if (parts.length === 1) return [parts[0]];
    try {
        const merged: MultiPolygon[] = [];
        for (let i = 0; i < parts.length; i += chunk) {
            const group = parts.slice(i, i + chunk);
            merged.push(group.length === 1 ? [group[0]] : union(group[0], ...group.slice(1)));
        }
        let acc = merged[0];
        for (let i = 1; i < merged.length; i++) acc = union(acc, merged[i]);
        return acc && acc.length > 0 ? acc : null;
    } catch {
        return null;
    }
};

const isPolygon = (geometry: Geometry): geometry is Polygon => {
    return typeof geometry[0]?.[0]?.[0] === 'number';
};

const normalizeMultiPolygon = (geometry: Geometry): MultiPolygon => {
    return isPolygon(geometry) ? [geometry] : geometry;
};

const signedRingArea = (ring: Ring) => {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        area += x1 * y2 - x2 * y1;
    }
    return area / 2;
};

const ringArea = (ring: Ring) => {
    return Math.abs(signedRingArea(ring));
};

// Filled area of a multipolygon: outer rings minus their holes. Used to detect
// clipping corruption (a difference must not increase filled area).
const multiPolygonFilledArea = (mp: MultiPolygon) => {
    let area = 0;
    for (const polygon of mp) {
        if (!polygon[0]) continue;
        area += ringArea(polygon[0]);
        for (let i = 1; i < polygon.length; i++) area -= ringArea(polygon[i]);
    }
    return area;
};

/**
 * The grid every emitted piece is written on.
 *
 * It has to be a grid: two pieces faded the same number of times can only merge
 * back together if the same point always writes the same way. It just cannot be
 * a COARSE one. Erasing re-emits the ink it touches, so a stroke rubbed over and
 * over is re-snapped dozens of times, and each time an edge that should sit
 * exactly on its neighbour can be pushed a twentieth of a pixel off it. That
 * drift is one source of the hairline cracks down a heavily-erased area — but
 * only a minor one, and it is NOT worth paying for. Measured on a clean blob
 * rubbed sixty times: 168 sub-pixel holes at 0.1, 109 at 0.01. The other ~65%
 * comes from fragmentation (the same run splits the blob into 271 pieces, and
 * every piece boundary is another chance for a hairline), which a finer grid
 * cannot touch. Meanwhile the extra decimal lengthens every `d` in the document
 * and measurably widened the bake encode window. Keep the grid coarse; fix the
 * fragmentation instead.
 */
const EMIT_DECIMALS = 1;
const EMIT_GRID = 10 ** EMIT_DECIMALS;
const roundCoordinate = (value: number) => Math.round(value * EMIT_GRID) / EMIT_GRID;

const normalizedRingPoints = (ring: Ring) => {
    return ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
        ? ring.slice(0, -1)
        : ring;
};

const ringToD = (ring: Ring) => {
    const points = normalizedRingPoints(ring);
    if (points.length < 3) return '';

    let d = `M ${points[0][0].toFixed(EMIT_DECIMALS)} ${points[0][1].toFixed(EMIT_DECIMALS)}`;
    for (let i = 1; i < points.length; i++) {
        d += ` L ${points[i][0].toFixed(EMIT_DECIMALS)} ${points[i][1].toFixed(EMIT_DECIMALS)}`;
    }
    return `${d} Z`;
};

const polygonToD = (polygon: Polygon) => {
    return polygon
        .map(ringToD)
        .filter(Boolean)
        .join(' ');
};


/**
 * Vertices a boolean planted ON an edge it did not actually cut. They carry no
 * shape — the edge is the same line without them — and they are what lets the
 * grid pull an outline off its neighbour.
 *
 * Rounding a point that lies on an edge moves it up to half a grid step
 * PERPENDICULAR to that edge. The neighbouring piece was not re-emitted this
 * pass, so it still has the straight edge, and the two no longer meet: a sliver
 * of background shows between them. Repeat over a much-erased area and the
 * slivers are the white speckling. This is the drift that snap rounding is known
 * for — "repeated applications can cause arbitrary drift of points" — and the
 * cure is not a finer grid (measured: 168 hairline holes at 0.1, still 109 at
 * 0.01, and every path in the document gets longer to buy it). It is to stop
 * rounding points that did not need to exist.
 *
 * ORDER MATTERS. They must go while they are still exactly on the line, before
 * the grid has moved them. Dropping them afterwards moves the edge to wherever
 * the survivors were pushed, which is worse than leaving them (measured: 1214).
 */
const ON_EDGE_EPS = 1e-6;
const dropOnEdgeVertices = (ring: Ring): Ring => {
    if (ring.length < 5) return ring;
    const closed = ring.length > 1
        && ring[0][0] === ring[ring.length - 1][0]
        && ring[0][1] === ring[ring.length - 1][1];
    const pts = closed ? ring.slice(0, -1) : ring;
    if (pts.length < 4) return ring;

    const out: Ring = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = out.length ? out[out.length - 1] : pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const [px, py] = prev, [x, y] = pts[i], [nx, ny] = next;
        const dx = nx - px, dy = ny - py;
        const len = Math.hypot(dx, dy);
        if (len < ON_EDGE_EPS) { out.push(pts[i]); continue; }
        const off = Math.abs(dy * (x - px) - dx * (y - py)) / len;
        // Also require it to sit BETWEEN its neighbours, not past one of them.
        const along = ((x - px) * dx + (y - py) * dy) / (len * len);
        if (off > ON_EDGE_EPS || along < 0 || along > 1) out.push(pts[i]);
    }
    if (out.length < 3) return ring;
    return closed ? ([...out, out[0]] as Ring) : out;
};

const roundPolygon = (polygon: Polygon): Polygon => {
    return polygon.map(ring => dropOnEdgeVertices(ring).map(([x, y]) => [roundCoordinate(x), roundCoordinate(y)]) as Ring);
};

const roundMultiPolygon = (multiPolygon: MultiPolygon): MultiPolygon => {
    return multiPolygon.map(roundPolygon);
};

const safeDifference = (subject: MultiPolygon, clip: Geometry) => {
    // Snap to a 0.1 grid before clipping. polygon-clipping (Martinez) is far more
    // robust on grid-snapped input — full-precision floats produce near-degenerate
    // vertices that occasionally yield corrupted/spurious output, especially in
    // busy scenes. Output is already rounded to 0.1, so this changes nothing
    // visible. Fall back to raw input, then to the unchanged subject, on error.
    eraseStats.differenceCalls++;
    const t0 = performance.now();
    const clipMp = normalizeMultiPolygon(clip);
    try {
        try {
            return difference(roundMultiPolygon(subject), roundMultiPolygon(clipMp));
        } catch {
            try {
                return difference(subject, clipMp);
            } catch {
                return subject;
            }
        }
    } finally {
        eraseStats.differenceMs += performance.now() - t0;
    }
};

const multiPolygonBounds = (mp: MultiPolygon) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const polygon of mp) {
        for (const [x, y] of polygon[0] || []) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
};

const polygonOuterBounds = (polygon: Polygon) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of polygon[0] || []) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
};

// A difference result can only lie within the original shape. Any result polygon
// outside the subject's bounds (or with non-finite coords) is a clipping artifact
// — the "fill in an unrelated place" glitch — so it should be discarded.
const polygonWithinSubject = (
    polygon: Polygon,
    subjectBounds: ReturnType<typeof multiPolygonBounds>,
    eps = 1
) => {
    const b = polygonOuterBounds(polygon);
    if (!Number.isFinite(b.minX)) return false;
    return !(
        b.minX > subjectBounds.maxX + eps ||
        b.maxX < subjectBounds.minX - eps ||
        b.minY > subjectBounds.maxY + eps ||
        b.maxY < subjectBounds.minY - eps
    );
};

// Stricter artifact detector than the bbox test above. polygon-clipping (Martinez)
// can emit a spurious solid that passes the bounds + net-area guards — the
// "unrelated section fills in" glitch — typically either refilling the just-erased
// hole or appearing inside the subject's bbox but outside the actual subject
// polygon. A legitimate difference piece is a subset of (subject − eraser), so:
//   (1) a healthy fraction of its own vertices lie inside the subject solid
//       (outer minus the subject's holes), and
//   (2) no eraser centerline point lies in the piece's SOLID area (outer minus the
//       piece's own holes). A legit notch/hole leaves the eraser zone empty, so the
//       eraser points fall in a hole or outside the piece. A relocated fill puts
//       the erased zone back into solid → caught. Accepts hole-punches (eraser in
//       the hole), which a centroid-deep-in-eraser test would wrongly reject.
//
// (1) samples VERTICES, not the centroid: a valid sub-piece of a concave subject
// (a noisy "spaghetti" outline) can have its centroid fall outside the shape in a
// concave bay, which a centroid test would wrongly reject as an artifact. A legit
// piece always has its cut-edge vertices inside the subject; a spurious fill that
// sits outside the subject polygon (in a bay) has ~none.
const polygonIsValidResult = (
    polygon: Polygon,
    subject: MultiPolygon,
    eraserPoints: Point[],
    /** Per-subject-polygon outer bboxes, precomputed by the caller (see
     *  cachedSubjectPolyBounds) — subject is cached per path identity across
     *  the whole drag, so its bounds are computed ONCE ever, not once per
     *  candidate polygon per move. A sample outside a polygon's bbox skips the
     *  O(ring) ray-cast entirely; point-in-polygon over big subject rings
     *  dominated the guard cost in profiling, so every skipped ray-cast counts. */
    subjectBounds: { minX: number; minY: number; maxX: number; maxY: number }[]
): boolean => {
    const outer = polygon[0];
    if (!outer) return false;

    // Most of a legit piece's vertices lie EXACTLY ON the subject boundary (the
    // difference inherits the subject's edges, grid-snapped to 0.1 by
    // safeDifference), where a strict point-in-polygon test is a coin flip. Test
    // the vertex plus four small axis jitters — a boundary vertex has an inside
    // neighbor, while an artifact vertex sitting genuinely outside the subject
    // (in a concave bay) fails all five. Without the jitter, a long piece whose
    // perimeter is mostly shared boundary can fail the 25% quorum and a REAL
    // half of a cleanly-cut stroke gets discarded as an "artifact" (half the
    // line silently vanishes on one erase pass).
    const jitter = 0.2;
    const insideSolid = (x: number, y: number): boolean => {
        const p = { x, y };
        for (let s = 0; s < subject.length; s++) {
            const b = subjectBounds[s];
            if (x < b.minX - jitter || x > b.maxX + jitter || y < b.minY - jitter || y > b.maxY + jitter) continue;
            const subjPoly = subject[s];
            if (!pointInsidePolygon(p, subjPoly[0])) continue;
            let inHole = false;
            for (let h = 1; h < subjPoly.length; h++) {
                if (pointInsidePolygon(p, subjPoly[h])) { inHole = true; break; }
            }
            if (inHole) continue;
            return true;
        }
        return false;
    };
    const vertexInsideSubject = (v: Ring[number]): boolean => {
        // Plain test first; the four jitter samples only run when it misses
        // (the boundary coin-flip case), so a clearly-inside vertex costs one
        // ray-cast, not five.
        return insideSolid(v[0], v[1]) ||
            insideSolid(v[0] + jitter, v[1]) ||
            insideSolid(v[0] - jitter, v[1]) ||
            insideSolid(v[0], v[1] + jitter) ||
            insideSolid(v[0], v[1] - jitter);
    };

    // Sample up to ~32 of the piece's outer-ring vertices. The total sample
    // count is deterministic, so the quorum is known up front — stop as soon as
    // it's reached (legit pieces, the overwhelmingly common case, pass after
    // the first few samples instead of paying for all ~32).
    const step = Math.max(1, Math.floor(outer.length / 32));
    const planned = Math.ceil(outer.length / step);
    // Legit pieces have ~half+ of vertices on a cut edge that lies inside the
    // subject; a spurious fill outside the subject polygon has ~0. Require a
    // healthy minority inside (>= 25%) to keep concave-but-valid pieces.
    const required = Math.max(1, planned * 0.25);
    let inside = 0;
    for (let i = 0; i < outer.length; i += step) {
        if (vertexInsideSubject(outer[i])) {
            inside++;
            if (inside >= required) break;
        }
    }
    if (inside < required) return false;

    const holes = polygon.slice(1);
    const b = polygonOuterBounds(polygon);
    for (const ep of eraserPoints) {
        if (ep.x < b.minX || ep.x > b.maxX || ep.y < b.minY || ep.y > b.maxY) continue;
        if (!pointInsidePolygon(ep, outer)) continue;
        if (holes.some(hole => pointInsidePolygon(ep, hole))) continue;
        return false;
    }
    return true;
};

const ringWithOppositeWinding = (ring: Ring, outer: Ring) => {
    if (signedRingArea(ring) * signedRingArea(outer) < 0) return ring;
    const points = [...normalizedRingPoints(ring)].reverse().map(([x, y]) => ({ x, y }));
    return closeRing(points);
};

const pointDistToEraserPathSq = (point: Point, eraserPoints: Point[]) => {
    let minSq = Infinity;
    for (const p of eraserPoints) {
        const distSq = (point.x - p.x) ** 2 + (point.y - p.y) ** 2;
        if (distSq < minSq) minSq = distSq;
    }

    for (let i = 1; i < eraserPoints.length; i++) {
        const a = eraserPoints[i - 1];
        const b = eraserPoints[i];
        const distSq = distToSegmentSq(point.x, point.y, a.x, a.y, b.x, b.y);
        if (distSq < minSq) minSq = distSq;
    }

    return minSq;
};

// Does the eraser capsule genuinely cover the ENTIRE subject? A subject vertex
// is covered when it lies within `radius` of the eraser centerline (the capsule
// definition). Used as the gate for dropping a whole stroke on an empty clip
// result: an empty difference is only a legitimate full-erase when every subject
// vertex is inside the eraser. If any vertex is outside, the empty result is a
// polygon-clipping failure (a shatter into sub-0.5 slivers on a self-overlapping
// freehand outline, or a mayIntersect false positive) — the stroke must be kept,
// not lost. The +1 tolerance absorbs the rounding between the strict capsule and
// the getStroke outline the clipper actually used.
const eraserCoversSubject = (subject: MultiPolygon, eraserPoints: Point[], radius: number): boolean => {
    if (eraserPoints.length === 0) return false;
    const radiusSq = (radius + 1) * (radius + 1);
    for (const poly of subject) {
        const outer = poly[0];
        if (!outer) continue;
        for (const v of outer) {
            if (pointDistToEraserPathSq({ x: v[0], y: v[1] }, eraserPoints) > radiusSq) return false;
        }
    }
    return true;
};

// Emits a difference-result polygon as an SVG path (nonzero fill). Every hole in
// the result is a real gap (the difference is authoritative), so ALL holes are
// emitted with winding opposite to the outer — dropping any hole would make
// nonzero fill render that gap solid (the "stray fill in a random place" bug).
const polygonToNonZeroD = (polygon: Polygon) => {
    const outer = polygon[0];
    if (!outer) return '';

    const rings = [outer];
    for (let i = 1; i < polygon.length; i++) {
        rings.push(ringWithOppositeWinding(polygon[i], outer));
    }

    return polygonToD(rings);
};

const polygonIsTinyEraserRemnant = (polygon: Polygon, eraserPoints: Point[], radius: number, subjectArea: number) => {
    const outer = polygon[0];
    if (!outer) return true;

    const area = ringArea(outer);
    // What counts as "tiny dust" is bounded three ways, taking the SMALLEST:
    //  - radius·radius·0.08: a crumb relative to the eraser, BUT this scales with
    //    r², so a wide eraser (r=24 → 46px²) would treat a real 30px² survivor as
    //    dust. That was a repro: a hook erase's two arms leave a genuine ~30px²
    //    segment of a line surviving in the notch between them (it came out of
    //    the difference, so it's real un-erased ink), which got discarded and
    //    "a chunk in the middle of the erase vanished".
    //  - subjectArea·0.25: never treat a meaningful fraction of the source shape
    //    as dust (a small shape reduced to ~50% is not a crumb).
    //  - 12px²: an ABSOLUTE ceiling. Dust is dust regardless of eraser size —
    //    a 12px² piece is visible ink, not a rounding crumb. This caps the
    //    r²-scaled term so wide erasers stop eating small real survivors while
    //    still cleaning genuine sub-pixel slivers. (For r≤12, r²·0.08 ≤ 12, so
    //    small erasers are unaffected.)
    const maxTinyArea = Math.max(0.5, Math.min(radius * radius * 0.08, subjectArea * 0.25, 12));
    if (area > maxTinyArea) return false;

    const points = normalizedRingPoints(outer);
    if (points.length === 0) return true;

    // The definitive dust-vs-remainder discriminator: how far the piece REACHES
    // beyond the eraser footprint. Genuine dust is a crumb the difference leaves
    // hugging the cut edge — it lies ENTIRELY within the eraser footprint (every
    // vertex within `radius` of the trail), poking out by at most a sliver. A
    // real surviving remainder of a cut stroke — even a thin, low-area one whose
    // area falls under the (radius-scaled) cap above — REACHES well past the
    // footprint: its far end is the un-erased part of the stroke, sitting many
    // units beyond `radius`. So if ANY vertex lies more than a small margin past
    // the eraser radius, this is real ink, never dust.
    //
    // This replaced a "≥50% of vertices are near the eraser" heuristic that was
    // a real repro's root cause: a wide eraser (r≈22, so the area cap is r²·0.08
    // ≈ 39) cutting a thin line leaves remainders of only ~27–34 px² that reach
    // ~33–36 px from the trail — clearly OUTSIDE the 22px footprint, unmistakably
    // real ink — yet a thin sliver's cut end hugs the eraser closely enough that
    // ≥50% of its vertices counted as "near", so the remainder was discarded as
    // dust and a chunk of the line silently vanished on erase.
    //
    // The margin past `radius` is a small FIXED tolerance, NOT radius-scaled.
    // A genuine dust crumb hugs the cut edge at maxDist ≈ radius (safeDifference
    // snaps to a 0.1 grid and the capsule polygon is inscribed, so it slightly
    // under-reaches radius); a real fragment reaches further. The tolerance only
    // has to absorb rounding, so it's constant. A radius-SCALED margin
    // (radius·0.15 ≈ 3.6px for r=24) was itself a repro's cause: two adjacent
    // erases left a 10px² fragment reaching 27.3px from a 24px eraser — only
    // 3.3px past the footprint, real ink the user expects to keep — yet
    // 27.3 < 27.6 (the scaled margin) swallowed it as dust. A fixed +2.5 keeps
    // that fragment while still discarding the ~2px caps a near-fully-erased
    // sliver leaves (which must drop, not linger — see the negligible-remnant
    // test).
    const footprintMargin = radius + 2.5;
    const footprintMarginSq = footprintMargin * footprintMargin;
    for (const [x, y] of points) {
        if (pointDistToEraserPathSq({ x, y }, eraserPoints) > footprintMarginSq) return false;
    }

    return true;
};

// Does the SUBJECT have a region that's genuinely far from the eraser (must
// survive) yet is entirely ABSENT from the raw difference output — not
// filtered out by our own tinyRing/tinyRemnant/etc guards (those all act on
// polygons that exist in `polygons`), but never emitted by Martinez at all?
//
// This is a DIFFERENT failure mode than the "shatter into countless
// sub-threshold slivers" one the other guards catch: instead of fragmenting a
// survivor into dust (which shows up as many small entries in `polygons`,
// summing close to the true remaining area), polygon-clipping can also just
// silently OMIT a legitimate sub-region from its output on complex
// self-intersecting input (routine for freehand/clipDerived geometry with
// many holes) — there is no fragment to inspect, no area to sum, nothing for
// the tinyRing/tinyRemnant/resultArea checks to see. A small resultArea from
// an omission looks identical to a small resultArea from a genuine near-total
// erase; only directly checking whether the untouched region actually made it
// into the output tells them apart.
//
// Sampled along the ring's own VERTICES (up to ~24 per outer ring), NOT a
// single interior point. A single interior sample (the first attempt at this
// check) is blind to elongated/thin shapes: a long thin stroke can have its
// eraser-touched end right next to a completely untouched far end within the
// SAME polygon, and one grid-scanned interior point lands wherever it lands —
// often in the touched portion, silently missing a substantial untouched
// region elsewhere on the same outline. Sampling vertices spread along the
// whole ring instead means the far, untouched portion always gets its own
// samples regardless of where the touched portion is.
//
// Each sampled vertex sits exactly ON the subject boundary, where a strict
// point-in-polygon test is a coin flip (same issue polygonIsValidResult
// solves) — so test the vertex plus four small jitters, matching that
// function's approach.
const subjectHasOmittedSurvivor = (subject: MultiPolygon, polygons: MultiPolygon, eraserPoints: Point[], radius: number): boolean => {
    const farSq = (radius * 2) * (radius * 2);
    const jitter = 0.2;
    const insideResult = (x: number, y: number): boolean => {
        for (const rp of polygons) {
            if (!pointInsidePolygon({ x, y }, rp[0])) continue;
            if (rp.slice(1).some(h => pointInsidePolygon({ x, y }, h))) continue;
            return true;
        }
        return false;
    };
    // Axis-only jitter is blind to an untouched AXIS-ALIGNED rectangular piece
    // (the common case for a simple filled shape, or a straight-edge freehand
    // capsule end): a square corner's axis-jittered samples all stay exactly
    // on one of its two edges, never landing strictly inside, so an entirely
    // untouched square could look "omitted" purely from corner geometry. The
    // four diagonal offsets add a sample that moves off BOTH edges at once,
    // landing inside for at least one corner regardless of the shape's
    // orientation.
    // A subject vertex that sits ON a kept piece's boundary edge is PRESERVED,
    // not omitted — the result outline passes right through it. The fill-based
    // jitter test above misses this at a SHARP far corner: every one of the 9
    // samples lands on or just outside the two edges meeting at a narrow convex
    // angle, so a legitimately-kept spike reads as "omitted" and the whole erase
    // gets reverted (an under-erase: the eraser passes through the shape but the
    // stroke is kept whole because one far corner failed the fill test). A
    // difference inherits the subject's edges grid-snapped to 0.1, so a genuinely
    // preserved vertex lands within ~0.15 of a result edge; 0.5 is a safe margin.
    // A genuinely OMITTED region leaves no piece, so its far vertices are far
    // from EVERY result edge (by the omitted region's own width) — this check
    // can't rescue them, keeping the guard's real purpose intact.
    const edgeEpsSq = 0.5 * 0.5;
    const onResultEdge = (x: number, y: number): boolean => {
        for (const rp of polygons) {
            for (const ring of rp) {
                for (let i = 0; i < ring.length - 1; i++) {
                    if (distToSegmentSq(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]) <= edgeEpsSq) return true;
                }
            }
        }
        return false;
    };
    const vertexSurvives = (x: number, y: number): boolean =>
        insideResult(x, y) ||
        insideResult(x + jitter, y) || insideResult(x - jitter, y) ||
        insideResult(x, y + jitter) || insideResult(x, y - jitter) ||
        insideResult(x + jitter, y + jitter) || insideResult(x - jitter, y - jitter) ||
        insideResult(x + jitter, y - jitter) || insideResult(x - jitter, y + jitter) ||
        onResultEdge(x, y);

    for (const subjPoly of subject) {
        const outer = subjPoly[0];
        if (!outer || outer.length < 2) continue;
        const step = Math.max(1, Math.floor(outer.length / 24));
        for (let i = 0; i < outer.length; i += step) {
            const [x, y] = outer[i];
            if (pointDistToEraserPathSq({ x, y }, eraserPoints) <= farSq) continue;
            if (!vertexSurvives(x, y)) return true;
        }
    }
    return false;
};

const splitClosedFilledPath = (
    path: PathData,
    flatCmds: FlatCommand[],
    subject: MultiPolygon | null,
    eraserPoints: Point[],
    radius: number,
    cleanupTinyRemnants = false,
    /** The eraser's swept region (union of trail capsules — see
     *  eraserOutlinePolygon) for this pass, if the caller already computed it.
     *  When omitted, it's computed here. Hoisting it lets one union serve every
     *  closed-filled candidate in a pass instead of one per candidate. */
    precomputedEraserPolygon?: MultiPolygon | null
): PathData[] | null => {
    const eraserPolygon = precomputedEraserPolygon !== undefined
        ? precomputedEraserPolygon
        : eraserOutlinePolygon(eraserPoints, radius);
    if (!subject || !eraserPolygon) {
        if (path.freehandSource) __lastClipDiag = { bailReason: 'noSubject', subjectArea: subject ? multiPolygonFilledArea(subject) : 0 };
        return [path];
    }

    // One difference for the whole eraser pass (see eraserOutlinePolygon). Fall
    // back to the slow per-segment loop only if the single op fails — rare, and
    // keeps erase correctness when it does.
    let result: MultiPolygon;
    try {
        result = safeDifference(subject, eraserPolygon);
    } catch {
        result = subject;
        for (const eraser of eraserGeometryParts(eraserPoints, radius)) {
            result = safeDifference(result, eraser);
            if (result.length === 0) break;
        }
    }
    if (!result) return [];

    const polygons = normalizeMultiPolygon(result);
    // Clip-derived pieces get the same hardened guards as whole freehand
    // outlines: without this, a stroke's FIRST split stripped freehandSource and
    // every later erase of its pieces ran unguarded — a corrupted difference
    // (dropped holes) then rendered a spurious solid over the erased region.
    const isFreehand = !!(path.freehandSource && path.freehandSource.points.length > 0) || !!path.clipDerived;
    // Per-result-polygon outer bboxes, computed ONCE and reused by the repair
    // pass, the detection pass, and (for kept pieces) below — a point outside a
    // polygon's bbox skips its O(ring) ray-cast entirely. Only needed on the
    // isFreehand path (both hole passes below are gated on it); `polygons` here
    // can carry deeply-holed pieces (backgrounds/bakes with 50+ rings), where
    // these full-ring ray-casts were the dominant guard cost in profiling.
    const resultBounds = isFreehand ? polygons.map(rp => polygonOuterBounds(rp)) : null;

    // Repair dropped holes. polygon-clipping's `difference` occasionally returns a
    // polygon MISSING an internal hole that the subject had (a Martinez artifact on
    // self-overlapping freehand outlines). The hole's region then renders SOLID —
    // the "fill in a random place" glitch, often far from the eraser. A dropped hole
    // was not touched by the eraser (an erased hole is legitimately gone/modified),
    // so its original ring is still exactly the correct gap. Re-attach it to the
    // result polygon containing its centroid. This only re-punches a gap that was
    // already empty in the subject — it never reshapes a surviving stroke.
    if (isFreehand && resultBounds) {
        const radiusSq = (radius + 1) * (radius + 1);
        for (const subjPoly of subject) {
            for (let h = 1; h < subjPoly.length; h++) {
                const hole = subjPoly[h];
                // Reliable interior sample (centroid can fall outside a concave hole).
                const p = interiorPointOfRing(hole);
                if (!p) continue;
                // Eraser passed through the hole → its absence/change is expected.
                if (pointDistToEraserPathSq(p, eraserPoints) <= radiusSq) continue;
                // Still present? (the interior sample lands in some result hole)
                let present = false;
                for (let i = 0; i < polygons.length; i++) {
                    const b = resultBounds[i];
                    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
                    const rp = polygons[i];
                    for (let rh = 1; rh < rp.length; rh++) {
                        if (pointInsidePolygon(p, rp[rh])) { present = true; break; }
                    }
                    if (present) break;
                }
                if (present) continue;
                // Dropped: the interior sample landed in a result SOLID (the hole's
                // region got filled) — re-attach the original hole ring to punch it
                // back out. Single injection only (never a duplicate → winding stays
                // correct), so this can't itself create a stray fill.
                for (let i = 0; i < polygons.length; i++) {
                    const b = resultBounds[i];
                    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
                    const rp = polygons[i];
                    if (pointInsidePolygon(p, rp[0]) && !rp.some(r => r === hole)) {
                        rp.push(hole);
                        break;
                    }
                }
            }
        }
    }

    // A difference can only ever REMOVE area. If the result has more filled area
    // than the subject, polygon-clipping corrupted the winding/holes (a region
    // that should be empty filled solid) — the "section fills in" glitch. Bail and
    // keep the original path rather than emit a corrupted fill.
    const subjectArea = multiPolygonFilledArea(subject);
    const resultArea = multiPolygonFilledArea(polygons);
    if (subjectArea > 1 && resultArea > subjectArea * 1.02 + 1) {
        if (path.freehandSource) __lastClipDiag = { bailReason: 'areaGuard', subjectArea, resultArea, polygonCount: polygons.length };
        return null;
    }

    const subjectBounds = multiPolygonBounds(subject);
    const nextPaths: PathData[] = [];
    // Below this a ring is treated as numerical noise and dropped. That is right
    // when CUTTING — the area is being removed anyway — but wrong when fading,
    // where nothing is removed and a dropped sliver is a hole with nothing to
    // paint it. Repeated rubs cut the ink along slightly different polygonal
    // approximations of the same round eraser, which leaves exactly these
    // hairline slivers, and dropping them is most of the white speckling down a
    // much-erased area (measured on a blob rubbed sixty times: 168 hairline
    // holes at 0.5, 70 at 0.01). `cleanupTinyRemnants` already distinguishes the
    // two callers.
    const minArea = cleanupTinyRemnants ? 0.5 : 0.01;
    // The strict subset test (polygonIsValidResult) is only applied to freehand
    // outlines, where the relocated/in-bbox "section fills in" glitch shows up.
    // Filled shapes (rectangles, baked faces) can have legit eraser-punched holes
    // whose outer-ring centroid sits in the hole; for those the existing
    // bbox + area guards are sufficient and stay as-is.
    // True only when a polygon is discarded as a clipping *artifact* (out of
    // bounds or failing the strict subset test) — not when it's a legit tiny
    // remnant. If every polygon is an artifact, the difference is corrupt, so bail
    // (return null) and let the caller fall back to a deterministic erase.
    let sawArtifact = false;
    const rejectReasons: string[] = [];
    // Filled area discarded by the INTENTIONAL remnant cleanup (dust near the
    // eraser). Deducted from resultArea in the empty-result decision below: area
    // the cleanup deliberately dropped is accounted-for erasure, not evidence of
    // a corrupted difference. Without this, a piece whose entire surviving
    // remainder was judged remnant-dust (legal per polygonIsTinyEraserRemnant's
    // own threshold, up to r²·0.08) could exceed the bail's stricter
    // "negligible" threshold and revert the piece to FULL size — un-erasing it.
    let remnantDiscardedArea = 0;
    // Per-kept-piece diagnostic: the verbatim emitted `d`, plus the polygon kept
    // for the post-loop dropped-hole check (the real stray signature — see below).
    const pieces: { d: string; stray?: string }[] = [];
    const keptPolygons: Polygon[] = [];
    const keptBounds: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    // Subject-polygon bboxes for polygonIsValidResult, cached per subject (see
    // cachedSubjectPolyBounds) — computed once ever per path, not once per
    // candidate polygon per move.
    const subjectPolyBounds = isFreehand ? cachedSubjectPolyBounds(subject) : null;

    for (let pi = 0; pi < polygons.length; pi++) {
        const polygon = polygons[pi];
        const outer = polygon[0];
        if (!outer || ringArea(outer) < minArea) { rejectReasons.push('tinyRing'); continue; }
        // Discard clipping artifacts that fall outside the original shape.
        if (!polygonWithinSubject(polygon, subjectBounds)) { rejectReasons.push('outOfBbox'); if (isFreehand) sawArtifact = true; continue; }
        // Discard spurious fills that pass the bbox/area guards but aren't a true
        // subset of (subject − eraser) — the relocated/in-bbox "section fills in"
        // glitch. This is the authoritative artifact test: it vertex-samples the
        // piece against the actual subject geometry. A secondary "small AND far
        // from the eraser" check used to run after this one, on the theory that
        // a tiny distant piece was probably a Martinez artifact — but a real
        // repro showed that profile is equally common for a LEGITIMATE small
        // separate mark within the same multi-ring freehand/clipDerived stroke
        // (a disconnected flourish or dot) that this eraser pass simply never
        // reached. Once a piece passes the vertex-subset check here, "far from
        // the eraser" isn't evidence of anything — it's just unerased ink.
        if (isFreehand && !polygonIsValidResult(polygon, subject, eraserPoints, subjectPolyBounds!)) { rejectReasons.push('notSubset'); sawArtifact = true; continue; }
        if (cleanupTinyRemnants && polygonIsTinyEraserRemnant(polygon, eraserPoints, radius, subjectArea)) {
            rejectReasons.push('tinyRemnant');
            remnantDiscardedArea += ringArea(outer);
            continue;
        }

        const d = polygonToNonZeroD(polygon);
        if (!d) { rejectReasons.push('noD'); continue; }

        if (isFreehand) {
            // `pieces` is purely diagnostic (it copies the full `d` of every
            // emitted piece); keptPolygons/keptBounds are load-bearing — the
            // omitted-survivor and dropped-hole checks read them.
            if (clipDiagnosticsEnabled) pieces.push({ d });
            keptPolygons.push(polygon);
            keptBounds.push(resultBounds![pi]);
        }

        nextPaths.push({
            ...path,
            id: generateId(),
            d,
            fill: path.fill || 'none',
            fillRule: path.fillRule === 'evenodd' ? path.fillRule : undefined,
            freehandSource: undefined,
            // Pieces are polygon-clipping output — mark them so later erases keep
            // the freehand-grade guards + union reconstruction (see PathData).
            clipDerived: true
        });
    }

    // Dropped-hole detection: the difference can occasionally return a polygon
    // MISSING an internal hole that the subject had (a polygon-clipping artifact).
    // The hole's region then renders SOLID — the "fill in a random place" glitch —
    // yet rendered area == authoritative area (both count the region solid), so the
    // area/bbox/vertex guards can't see it. A subject hole is genuinely dropped iff
    // its reliable interior sample (NOT the centroid, which can fall outside a
    // concave hole) is un-erased AND lands in a kept piece's SOLID (in some kept
    // outer, not in any kept hole). This stops false-positive warnings on concave
    // holes whose centroid sits in solid.
    // This pass only ANNOTATES the diagnostic pieces with a stray warning — the
    // functional repair that re-punches dropped holes ran earlier — so it is
    // skipped entirely unless the verbose diagnostics are on. It walks every
    // subject hole doing point-in-polygon work, which is not free on a deeply
    // holed background.
    let droppedHoles: { cx: number; cy: number; area: number }[] = [];
    if (isFreehand && clipDiagnosticsEnabled) {
        const radiusSq = (radius + 1) * (radius + 1);
        for (const subjPoly of subject) {
            for (let h = 1; h < subjPoly.length; h++) {
                const hole = subjPoly[h];
                const p = interiorPointOfRing(hole);
                if (!p) continue;
                if (pointDistToEraserPathSq(p, eraserPoints) <= radiusSq) continue;
                let inSolid = false;
                for (let ki = 0; ki < keptPolygons.length; ki++) {
                    const b = keptBounds[ki];
                    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue;
                    const kp = keptPolygons[ki];
                    if (!pointInsidePolygon(p, kp[0])) continue;
                    if (kp.slice(1).some(khole => pointInsidePolygon(p, khole))) continue;
                    inSolid = true;
                    break;
                }
                if (inSolid) droppedHoles.push({ cx: Math.round(p.x), cy: Math.round(p.y), area: Math.round(ringArea(hole)) });
            }
        }
        if (droppedHoles.length > 0) {
            for (const p of pieces) {
                if (!p.stray) p.stray = `DROPPED_HOLE: ${droppedHoles.length} subject hole(s) now solid at ${droppedHoles.map(d => `(${d.cx},${d.cy})`).join(' ')}`;
            }
        }
    }

    // Does the subject have a genuinely untouched region that's entirely
    // absent from the KEPT pieces — the final post-filter survivor set? This
    // catches two distinct failure modes:
    //   1. Martinez silently omits a disjoint region from its raw output (no
    //      fragment to inspect), AND
    //   2. Martinez DOES emit a region, but the per-piece filter loop
    //      (polygonIsValidResult / polygonWithinSubject / tinyRing) incorrectly
    //      discards it — e.g. a valid disconnected survivor from a
    //      self-overlapping freehand stroke whose reshuffled boundary fails the
    //      vertex-in-subject quorum or eraser-containment heuristic.
    // Checking keptPolygons (the post-filter set) instead of raw `polygons`
    // covers both: keptPolygons ⊆ polygons, so any omission from raw output is
    // also absent from keptPolygons, and filter-introduced loss is ADDITIONALLY
    // caught. The previous code checked raw `polygons`, which was blind to loss
    // introduced by the filter loop — a valid piece present in raw output
    // looked "not omitted" even after the filter discarded it.
    // This must be checked regardless of whether OTHER pieces survived
    // (nextPaths.length > 0): a real repro showed the near-side of a thin
    // self-crossing freehand stroke surviving as a small kept piece (passing
    // every per-piece guard, so nextPaths was non-empty) while a separate,
    // disjoint, genuinely-untouched far portion of the SAME stroke vanished —
    // the "some ink survives here, but a whole unrelated region silently
    // disappears" glitch.
    const omittedSurvivor = isFreehand && subjectHasOmittedSurvivor(subject, keptPolygons, eraserPoints, radius);
    if (omittedSurvivor) {
        if (isFreehand) __lastClipDiag = { bailReason: 'omittedSurvivor', subjectArea, resultArea, polygonCount: polygons.length, kept: nextPaths.length, rejectReasons, pieces };
        return null;
    }

    if (nextPaths.length > 0) {
        if (isFreehand) __lastClipDiag = { bailReason: 'ok', subjectArea, resultArea, polygonCount: polygons.length, kept: nextPaths.length, rejectReasons, pieces };
        return nextPaths;
    }
    // The whole stroke is about to be dropped (nextPaths empty). That is
    // correct in two cases:
    //  - the eraser genuinely covered the entire subject (eraserCoversSubject)
    //    — an unambiguous full-erase, or
    //  - polygon-clipping's OWN raw result area (resultArea, computed above
    //    from the difference's output BEFORE any of our per-piece guards ran)
    //    is already negligible relative to the subject. That means the
    //    difference legitimately reduced the stroke to dust — our per-piece
    //    guards (tinyRing/tinyRemnant) then correctly discarded that dust —
    //    not the Martinez failure mode described below, which instead leaves
    //    a SUBSTANTIAL resultArea shattered into countless sub-threshold
    //    fragments. `sawArtifact` (set only by outOfBbox/notSubset/spuriousFar
    //    — the actual corruption signals) must also be clear, since any of
    //    those catching something means a real survivor may have been
    //    wrongly discarded.
    //    Missing this case was a real bug: a piece that polygon-clipping
    //    genuinely erased down to ~1% remaining area (which cleanupTinyRemnants
    //    then correctly trimmed to nothing) got reverted to its FULL pristine
    //    size just because the eraser capsule didn't touch literally every
    //    vertex — "erasing over an already-mostly-erased shape makes it whole
    //    again", which then LOOKS like ink reappearing once whatever was
    //    hiding it is erased away later.
    //  Otherwise (an artifact was seen, or the raw result is still a
    //  meaningful area) an empty result is untrustworthy — it may be a
    //  polygon-clipping failure: a shatter into sub-0.5 slivers (Martinez
    //  artifact on self-overlapping freehand outlines) or a mayIntersect false
    //  positive with no real overlap. Dropping would lose the whole stroke
    //  ("a line just disappears when I erase part of it"), so keep the
    //  original instead.
    const covered = eraserCoversSubject(subject, eraserPoints, radius);
    // Only area NOT already accounted for by the intentional remnant cleanup
    // counts as suspicious. A remnant-cleaned piece can legitimately leave up
    // to r²·0.08 of dust (polygonIsTinyEraserRemnant's own limit) — that area
    // was LOCATION-VERIFIED near the eraser before being discarded, so it is
    // trustworthy evidence of a real erase. Without the deduction,
    // remnant-cleaned pieces got reverted to full size ("lines reappear when
    // erasing over an already-erased region").
    const unaccountedArea = Math.max(0, resultArea - remnantDiscardedArea);
    // The unaccounted remainder (sub-minArea rings, unemittable pieces) is NOT
    // location-verified, so its allowance must stay ABSOLUTE dust — a couple of
    // crumb-slivers at most. This threshold was briefly proportional
    // (min(r²·4, subject·0.25), i.e. hundreds of px²), which let a Martinez
    // SHATTER — corrupt near-empty output from a mere graze, the very failure
    // this bail exists to catch — pass as "legitimately erased" and delete an
    // entire stroke the eraser barely touched.
    const maxDustArea = Math.max(2, radius * radius * 0.05);
    const resultNegligible = unaccountedArea <= maxDustArea;
    // omittedSurvivor was already checked (and would have returned null)
    // above, so it's known false here — no need to recheck it.
    const genuinelyErased = covered || (!sawArtifact && resultNegligible);
    if (isFreehand) {
        __lastClipDiag = {
            bailReason: covered ? 'fullyErased' : (sawArtifact ? 'allArtifacts' : (resultNegligible ? 'negligibleResult' : 'emptyNotCovered')),
            subjectArea, resultArea, remnantDiscardedArea, polygonCount: polygons.length, rejectReasons, pieces
        };
    }
    return genuinelyErased ? [] : null;
};

export const sourceStrokeToD = (source: NonNullable<PathData['freehandSource']>) => {
    const outline = getStroke(source.points, { ...source.options, last: true });
    if (outline.length === 0) return '';

    const ring: Ring = outline.map(([x, y]) => [x, y]);
    let flattened: MultiPolygon;
    try {
        flattened = union([closeRing(ring.map(([x, y]) => ({ x, y })))]);
    } catch {
        flattened = [[closeRing(ring.map(([x, y]) => ({ x: roundCoordinate(x), y: roundCoordinate(y) })))]]; 
    }
    return flattened
        .map(polygonToD)
        .filter(Boolean)
        .join(' ');
};

const freehandSourceGeometry = (source: NonNullable<PathData['freehandSource']>): Geometry | null => {
    const points = source.points.map(([x, y]) => ({ x, y }));
    if (points.length === 0) return null;

    const radius = Math.max(0.5, source.options.size / 2);
    const parts: Geometry[] = [];

    if (points.length === 1) {
        parts.push(circlePolygon(points[0], radius));
    } else {
        for (let i = 1; i < points.length; i++) {
            parts.push(capsulePolygon(points[i - 1], points[i], radius));
        }
    }

    return unionGeometryParts(parts);
};

export function freehandSourceToPath(source: NonNullable<PathData['freehandSource']>) {
    return sourceStrokeToD(source);
}

// Ring bounding box, memoized per ring object (same contract as
// interiorPointCache: ring arrays are stable for their owner's lifetime).
const ringBBoxCache = new WeakMap<Ring, { minX: number; minY: number; maxX: number; maxY: number }>();
const ringBBox = (ring: Ring) => {
    const cached = ringBBoxCache.get(ring);
    if (cached) return cached;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < ring.length; i++) {
        const x = ring[i][0], y = ring[i][1];
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const bb = { minX, minY, maxX, maxY };
    ringBBoxCache.set(ring, bb);
    return bb;
};

// Ray-cast point-in-ring, with a memoized bbox reject in front.
//
// The reject is EXACTLY equivalent, not an approximation: the loop wraps
// (j = length-1), so the edge set is always a closed loop. A point outside the
// y-range crosses no edge; one past maxX satisfies no `px < xIntersect`; one
// before minX satisfies every crossing, and a closed loop crosses any horizontal
// line an even number of times, so the toggles cancel. All three cases return
// false either way. Boundary-equal points are NOT rejected (strict compares) —
// they fall through to the full test.
//
// This is the hottest function in the erase pass (14% of total): the guards test
// every eraser trail point against the same few rings, so without it the cost is
// O(trailPoints × ringVerts). Reading y before x also skips the division and the
// x reads entirely whenever the y-straddle test fails, which is most edges.
const pointInsidePolygon = (point: Point, ring: Ring) => {
    const px = point.x, py = point.y;
    const bb = ringBBox(ring);
    if (px < bb.minX || px > bb.maxX || py < bb.minY || py > bb.maxY) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const vi = ring[i], vj = ring[j];
        const yi = vi[1], yj = vj[1];
        if ((yi > py) !== (yj > py)) {
            const xi = vi[0], xj = vj[0];
            if (px < (xj - xi) * (py - yi) / (yj - yi || 1e-9) + xi) inside = !inside;
        }
    }
    return inside;
};

const pathBoundsOverlap = (pathBounds: ReturnType<typeof pointBounds>, eraserBounds: ReturnType<typeof pointBounds>, radius: number) => {
    return !(pathBounds.maxX < eraserBounds.minX - radius || pathBounds.minX > eraserBounds.maxX + radius ||
        pathBounds.maxY < eraserBounds.minY - radius || pathBounds.minY > eraserBounds.maxY + radius);
};

const closedPathMayIntersectEraser = (flatCmds: FlatCommand[], subject: MultiPolygon | null, eraserPoints: Point[], radius: number) => {
    const pathPoints = flatCmds.map(({ x, y }) => ({ x, y }));
    const pathBounds = pointBounds(pathPoints);
    const eraserBounds = pointBounds(eraserPoints);
    if (!pathBoundsOverlap(pathBounds, eraserBounds, radius)) return false;

    if (subject) {
        for (const p of eraserPoints) {
            if (subject.some(polygon => pointInsidePolygon(p, polygon[0]))) return true;
        }
    }

    const eraserSegments = eraserPoints.slice(1).map((p, i) => ({ a: eraserPoints[i], b: p }));
    let prevPt: Point | null = null;
    for (const fCmd of flatCmds) {
        if (fCmd.type === 'M') {
            prevPt = { x: fCmd.x, y: fCmd.y };
        } else if (fCmd.type === 'L' && prevPt) {
            const a = prevPt;
            const b = { x: fCmd.x, y: fCmd.y };
            if (erasedIntervalsForSegment(a, b, eraserPoints, eraserSegments, radius).length > 0) return true;
            prevPt = b;
        }
    }

    return false;
};

type PointP = Point & { p?: number };
type FlatCommandP = FlatCommand & { p?: number };

// Robust interval-based split of a polyline by the eraser. Geometric and
// deterministic (no polygon clipping). Returns the kept sub-polylines, carrying
// pressure so freehand outlines can be regenerated. Shared by plain strokes and
// freehand centerline erasing.
const splitFlatByEraser = (
    flatCmds: FlatCommandP[],
    sampledEraserPoints: Point[],
    eraserSegments: { a: Point; b: Point }[],
    // Centerline distance at which the ink is cut — see `effectiveRadius` in
    // splitOnePathByEraser for how it is chosen.
    effectiveRadius: number,
    capPadding: number
): { subPaths: PointP[][]; coveredSubPaths: PointP[][]; anyHit: boolean } => {
    const effectiveRadiusSq = effectiveRadius * effectiveRadius;
    const subPaths: PointP[][] = [];
    let currentSubPath: PointP[] = [];
    let anyHit = false;

    const isInside = (cx: number, cy: number) => {
        for (const p of sampledEraserPoints) {
            if ((cx - p.x) ** 2 + (cy - p.y) ** 2 <= effectiveRadiusSq) return true;
        }
        for (const { a, b } of eraserSegments) {
            if (distToSegmentSq(cx, cy, a.x, a.y, b.x, b.y) <= effectiveRadiusSq) return true;
        }
        return false;
    };

    const appendPoint = (pt: PointP) => {
        if (currentSubPath.length > 0) {
            const last = currentSubPath[currentSubPath.length - 1];
            if (Math.abs(last.x - pt.x) < 0.01 && Math.abs(last.y - pt.y) < 0.01) return;
        }
        currentSubPath.push(pt);
    };

    // Covered runs are the mirror image of the kept ones: the stretches that
    // fall UNDER the eraser. The clean-cut modes drop them; the fade eraser
    // keeps them at a reduced opacity, so they are only collected on request.
    const coveredSubPaths: PointP[][] = [];
    let currentCovered: PointP[] = [];
    const flushCovered = () => {
        if (currentCovered.length > 1) coveredSubPaths.push(currentCovered);
        currentCovered = [];
    };
    const appendCoveredPoint = (pt: PointP) => {
        if (currentCovered.length > 0) {
            const last = currentCovered[currentCovered.length - 1];
            if (Math.abs(last.x - pt.x) < 0.01 && Math.abs(last.y - pt.y) < 0.01) return;
        }
        currentCovered.push(pt);
    };

    const processSample = (pt: PointP) => {
        if (isInside(pt.x, pt.y)) {
            anyHit = true;
            if (currentSubPath.length > 0) { subPaths.push(currentSubPath); currentSubPath = []; }
        } else {
            appendPoint(pt);
        }
    };

    let prevPt: PointP | null = null;
    for (const fCmd of flatCmds) {
        if (fCmd.type === 'M') {
            if (currentSubPath.length > 0) { subPaths.push(currentSubPath); currentSubPath = []; }
            flushCovered();
            prevPt = { x: fCmd.x, y: fCmd.y, p: fCmd.p };
            if (isInside(fCmd.x, fCmd.y)) anyHit = true;
            else currentSubPath.push({ x: fCmd.x, y: fCmd.y, p: fCmd.p });
        } else if (fCmd.type === 'L' && prevPt) {
            const a = prevPt;
            const b: PointP = { x: fCmd.x, y: fCmd.y, p: fCmd.p };

            // ONE rule for every segment: erase where the centerline is within
            // `effectiveRadius`, padded by `capPadding` so the surviving round
            // cap does not bulge back into the erased area.
            //
            // A second rule used to run alongside it — when a segment was fully
            // covered it was re-cut at the "full visible thickness" radius
            // (radius - strokeRadius) instead, meaning to nibble rather than cut
            // clean through. Two rules on adjacent segments cut at positions up
            // to strokeRadius apart, which is what left tiny islands of ink
            // stranded at the ends of an erased run (a 2px dot beside a 2px hole
            // on a 4px line) — visible cruft the drag preview never showed. The
            // nibbling it was really compensating for now lives in the choice of
            // `effectiveRadius` itself.
            const erasedIntervals = erasedIntervalsForSegment(a, b, sampledEraserPoints, eraserSegments, effectiveRadius, capPadding);
            if (erasedIntervals.length > 0) {
                anyHit = true;
                const pa = a.p ?? 0.5;
                const pb = b.p ?? 0.5;
                const pointAt = (t: number): PointP => ({
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                    p: pa + (pb - pa) * t
                });
                let cursor = 0;

                const appendKeptSegment = (start: number, end: number) => {
                    if (end - start < 1e-6) return;
                    if (currentSubPath.length === 0 || start > 1e-6) appendPoint(pointAt(start));
                    appendPoint(pointAt(end));
                };

                // Intervals can run past either end of the segment; the covered
                // run only exists where they overlap it.
                const appendCoveredSegment = (start: number, end: number) => {
                    const s = Math.max(0, start);
                    const e = Math.min(1, end);
                    if (e - s < 1e-6) return;
                    appendCoveredPoint(pointAt(s));
                    appendCoveredPoint(pointAt(e));
                };

                for (const interval of erasedIntervals) {
                    const keptBefore = interval.start - cursor > 1e-6;
                    appendKeptSegment(cursor, interval.start);
                    if (currentSubPath.length > 0) { subPaths.push(currentSubPath); currentSubPath = []; }
                    // A surviving stretch breaks the run of covered ink.
                    if (keptBefore) flushCovered();
                    appendCoveredSegment(interval.start, interval.end);
                    cursor = Math.max(cursor, interval.end);
                }
                if (1 - cursor > 1e-6) flushCovered();
                appendKeptSegment(cursor, 1);
            } else {
                processSample(b);
                flushCovered();
            }
            prevPt = b;
        }
    }

    if (currentSubPath.length > 0) subPaths.push(currentSubPath);
    flushCovered();
    return { subPaths, coveredSubPaths, anyHit };
};

/** Move-shared eraser geometry, built once per erase pass and reused across
 *  every path the broadphase surfaces. Hoisting this out of the per-path loop is
 *  the difference between one resample/bounds/segments (and at most one getStroke)
 *  per move vs. one per candidate. */
export type EraserCtx = {
    /** Original (unsampled) eraser points this pass. Used by helpers that index the
     *  raw centerline (pointDistToEraserPathSq, recordClipErase). */
    eraserPoints: Point[];
    /** Resampled (sub-divided for capsule smoothness) eraser points. The clip and
     *  flat-split branches operate on these. */
    sampledEraserPoints: Point[];
    eraserBounds: { minX: number; minY: number; maxX: number; maxY: number };
    eraserSegments: { a: Point; b: Point }[];
    radius: number;
    /** Lazily-computed swept-region MultiPolygon (union of trail capsules —
     *  see eraserOutlinePolygon). `undefined` = not yet computed this pass;
     *  once computed (on the first closed-filled candidate that needs it) it's
     *  reused for every later candidate. Flat-only erase passes never touch it,
     *  so they pay no union. */
    _eraserPolygon: MultiPolygon | null | undefined;
    /** When set, the pass FADES rather than cuts: whatever falls under the
     *  eraser is kept at a reduced opacity instead of being removed. */
    fade?: FadeOptions;
};

/** Build the pass-shared eraser context: resampled points, bounds, and
 *  per-segment pairs. The expensive `eraserOutlinePolygon` (capsule union) is
 *  NOT built here — it's computed lazily via `eraserPolygonFromCtx` on the
 *  first closed-filled candidate that needs it, then reused for every candidate
 *  this pass. Exported so the store can build one ctx per erase pass and split
 *  each broadphase candidate via `splitOnePathByEraser` without re-running the
 *  shared setup. */
export const buildEraserCtx = (eraserPoints: Point[], radius: number, fade?: FadeOptions): EraserCtx => {
    // No resampling: every consumer is exact per straight segment (strips +
    // endpoint circles for the interval math, one capsule per segment for the
    // clip region), so subdividing segments only multiplies the vertex count
    // that the capsule union and every Martinez difference then pay for.
    //
    // The trail is deliberately NOT simplified. Douglas-Peucker at 0.05px would
    // cut a real 2149-point trail to ~1400 and buy another ~1.6x on the drag-end
    // pass, but it is a genuine (if sub-pixel) geometric approximation: measured
    // against the unsimplified result it moved 207 of 3.58M rasterized pixels
    // versus 48 without it. The rest of the speedup here is exact, so the
    // approximation is not worth taking by default — see simplifyTrail.
    const simplified = eraserPoints;
    return {
        eraserPoints,
        sampledEraserPoints: simplified,
        eraserBounds: pointBounds(simplified),
        eraserSegments: simplified.slice(1).map((p, i) => ({ a: simplified[i], b: p })),
        radius,
        _eraserPolygon: undefined,
        fade,
    };
};

const eraserPolygonFromCtx = (ctx: EraserCtx): MultiPolygon | null => {
    if (ctx._eraserPolygon === undefined) {
        ctx._eraserPolygon = eraserOutlinePolygon(ctx.sampledEraserPoints, ctx.radius);
        eraseStats.eraserPolygonVerts = ctx._eraserPolygon
            ? ctx._eraserPolygon.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0)
            : 0;
    }
    return ctx._eraserPolygon;
};

/** The eraser's swept region restricted to the trail segments that can
 *  actually reach `bounds` (a path's bbox): a capsule is included iff its
 *  segment's bbox intersects the bounds expanded by radius+1 — beyond that a
 *  capsule provably cannot touch the path, so the difference result for THIS
 *  path is identical to clipping against the full-trail union.
 *
 *  This is the whole-drag pass's perf linchpin: one drag-end pass clips every
 *  candidate against the trail, and profiling showed the Martinez `difference`
 *  itself dominating (~50ms per stroke against a ~1500-vertex full-trail
 *  union, seconds total on a dense scene — the "page locks up at mouseup"
 *  stall). A stroke only ever meets the few trail segments near it, so each
 *  difference clips against a small local union instead.
 *
 *  Returns null when no trail segment reaches the bounds (caller carries the
 *  path through untouched). */
const localEraserRegion = (ctx: EraserCtx, bounds: { minX: number; minY: number; maxX: number; maxY: number }): MultiPolygon | null => {
    const __t0 = performance.now();
    try {
        return localEraserRegionInner(ctx, bounds);
    } finally {
        eraseStats.eraserRegionCalls++;
        eraseStats.eraserRegionMs += performance.now() - __t0;
    }
};

const localEraserRegionInner = (ctx: EraserCtx, bounds: { minX: number; minY: number; maxX: number; maxY: number }): MultiPolygon | null => {
    const pts = ctx.sampledEraserPoints;
    const radius = ctx.radius;
    if (pts.length === 0) return null;
    const pad = radius + 1;
    const minX = bounds.minX - pad, maxX = bounds.maxX + pad;
    const minY = bounds.minY - pad, maxY = bounds.maxY + pad;

    // Count reachable segments FIRST, with bbox tests only. The cached-full-union
    // branch below throws away every capsule it was given, so building them up
    // front allocated one polygon per trail segment per candidate path and then
    // discarded the lot — on a long stroke over a few large paths that was
    // thousands of dead polygons per pass (visible as capsulePolygon self-time
    // and as GC pressure). The bbox test is the same one used below, so the
    // branch decision and the resulting geometry are unchanged.
    const reaches = (i: number) => {
        const a = pts[i - 1], b = pts[i];
        const sMinX = a.x < b.x ? a.x : b.x, sMaxX = a.x < b.x ? b.x : a.x;
        const sMinY = a.y < b.y ? a.y : b.y, sMaxY = a.y < b.y ? b.y : a.y;
        return !(sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY);
    };
    let included = 0;
    for (let i = 1; i < pts.length; i++) if (reaches(i)) included++;
    if (included > 0 && (included === pts.length - 1 || included > 64)) {
        eraseStats.eraserRegionCachedHits++;
        return eraserPolygonFromCtx(ctx);
    }
    const parts: Polygon[] = [];
    for (let i = 1; i < pts.length; i++) {
        if (reaches(i)) parts.push(capsulePolygon(pts[i - 1], pts[i], radius));
    }
    // Path spans the whole trail — use the ctx-cached full union instead of
    // re-unioning identical parts per candidate (big strokes on a dense scene
    // would otherwise pay the full union N times).
    // Reuse the ctx-cached FULL-trail union rather than building a local one
    // whenever this path needs most of the trail anyway. Capsules excluded above
    // provably cannot reach this path's bbox, so clipping against the full union
    // yields an identical difference — it is purely a cost choice. Building a big
    // local union per candidate was a real drag-end cost: five large paths each
    // spanning the trail paid five ~430ms unions (2149ms) where one shared build
    // suffices. Small local regions (few capsules) are still built locally, since
    // those are cheap and give the difference a smaller polygon to chew on.
    if (parts.length === 0) {
        // Single-point trail (click erase) with the point in reach.
        const p = pts[0];
        if (pts.length === 1 && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
            return [circlePolygon(p, radius)];
        }
        return null;
    }
    try {
        const unified = union(parts[0], ...parts.slice(1));
        if (unified && unified.length > 0) return unified;
    } catch {
        // fall through — overlapping-but-well-formed parts still clip correctly
    }
    return parts;
};

/** Split a single path by the eraser described by `ctx`. Returns the PathData[]
 *  to emit in this path's place: `[]` drops it (the old `continue` on
 *  unparseable geometry), `[path]` carries it through untouched (same object,
 *  so callers can detect a no-op with `pieces.length === 1 && pieces[0] === path`),
 *  and a longer array is the split pieces. `candidates`/`sync` mirror the
 *  `splitPathsByEraser` opts. This is the per-path body of `splitPathsByEraser`
 *  factored out so the store can call it per broadphase candidate while building
 *  `ctx` once per move; per-path split has no cross-path deps, so per-candidate
 *  results are identical to a single full-array split. */
export const splitOnePathByEraser = (
    path: PathData,
    ctx: EraserCtx,
    isLayerLocked: (layerId?: string) => boolean = () => false,
    candidates?: Set<string>,
    sync?: { removed: PathData[]; added: PathData[] }
): PathData[] => {
    const { sampledEraserPoints, eraserBounds, eraserSegments, eraserPoints, radius } = ctx;

    if (isLayerLocked(path.layerId)) return [path];

    // Id-keyed broadphase: a path whose id isn't a candidate can't be hit this
    // pass, so carry it through untouched. Falls back to "always a candidate"
    // when no set is supplied (grid disabled / first build / store Pass 2 which
    // pre-filtered by id already).
    if (candidates && path.id && !candidates.has(path.id)) return [path];


    eraseStats.pathsChecked++;

    // Flattened commands + bbox + parsed translate, cached per path identity.
    // Untouched paths keep their object across moves, so after the first
    // encounter this is a single WeakMap lookup — no parsePath, no flattenPath,
    // no parseTranslate regex (the per-path-per-move cost on a dense drawing).
    const { flatCmds, bbox: pathBBox, tx, ty } = cachedFlatten(path);
    if (flatCmds.length === 0 || !pathBBox) return [];
    const pathBounds = pathBBox;
    const hasTranslate = tx !== 0 || ty !== 0;

    // Freehand strokes erase via the closed-filled-path branch below (polygon-
    // clipping subtract on the committed outline). The `isFreehandPath` flag
    // just selects the hardened freehand guards + diagnostics inside that branch.
    const isFreehandPath = !!(path.freehandSource && path.freehandSource.points.length > 0);

    const strokeRadius = (path.strokeWidth || 1) / 2;
    // The centerline distance at which a cut happens. An open stroke is only ink
    // where it is drawn — a band `strokeRadius` either side of the centerline —
    // so the eraser meets it across a range of centerline distances:
    //
    //   d <= radius - strokeRadius   the eraser covers the ink's FULL thickness
    //   d == radius                  it covers exactly half of it
    //   d <= radius + strokeRadius   it just grazes the far flank
    //
    // A centerline can only be cut or not, so a threshold has to be picked
    // somewhere in that range, and it bounds how far the committed result can
    // differ from the live drag preview (which subtracts the eraser from the
    // RENDERED pixels, and so shows a partly-covered stroke as a thinner one).
    // `radius` — cut once more than half the thickness is gone — is the midpoint:
    // it is wrong by at most strokeRadius either way.
    //
    // This used to be `radius + strokeRadius`, the far end of the range: an
    // eraser that came near a line without removing a single pixel of it deleted
    // the whole grazed run, so a drag that wandered close to other ink punched
    // holes through lines it never visibly touched, and every cut ran half an ink
    // width wider than the preview had shown.
    const effectiveRadius = radius;

    // Pre-flatten broadphase: skip the whole path if its cached bbox can't
    // reach the eraser capsule. The capsule extends `radius` beyond the eraser
    // points; the path's own stroke adds `strokeRadius`.
    const ex = radius + strokeRadius + 1;
    if (pathBounds.maxX + ex < eraserBounds.minX || pathBounds.minX - ex > eraserBounds.maxX ||
        pathBounds.maxY + ex < eraserBounds.minY || pathBounds.minY - ex > eraserBounds.maxY) {
        eraseStats.bboxRejected++;
        return [path];
    }

    // Genuine filled shapes (rectangles, baked mesh faces, …) — polygon
    // clipping is the right tool here.
    if (isClosedFilledPath(path)) {
        eraseStats.closedFilledChecked++;
        const splitPathMetadata = hasTranslate
            ? { ...path, transform: undefined, ...(path.clipRect ? { clipRect: rebaseClipRect(path, tx, ty) } : {}) }
            : path;
        // Diagnostics cover clip-derived pieces too — piece re-erases were the
        // unrecorded blind spot where corrupted differences went unnoticed.
        const isClipFreehand = isFreehandPath || !!path.clipDerived;
        // Subject geometry is eraser-independent AND path-immutable, so it's
        // cached per path identity (see subjectCache) — one build per path
        // lifetime, reused across every move of every drag. subjectBuilds in
        // the perf counters now counts cache MISSES only.
        const subject = cachedSubject(path, flatCmds);
        if (!closedPathMayIntersectEraser(flatCmds, subject, sampledEraserPoints, radius)) {
            eraseStats.mayIntersectRejected++;
            return [path];
        }
        // Clip against only the trail segments that can reach THIS path's bbox
        // (identical result to the full-trail union — see localEraserRegion).
        // The whole-drag trail's full union made each Martinez difference ~50ms
        // on a dense scene; the local region keeps each one small.
        const eraserRegion = localEraserRegion(ctx, pathBounds);
        if (!eraserRegion) return [path];
        // Fade mode on a filled shape: the part outside the eraser keeps its
        // opacity, the overlap comes back dimmer. Same two halves as the clean
        // cut, except the removed half is re-emitted rather than dropped.
        if (ctx.fade && subject) {
            const step = fadeStep(path, ctx.fade);
            const next = step ? step.opacity : null;
            // NO tiny-remnant cleanup when fading. That rule exists for the
            // cutting modes, where a crumb left hugging the cut edge is dust in
            // an area that is being removed anyway. Fading removes nothing: the
            // covered half comes back dimmed, so a sliver dropped from the half
            // that KEEPS its opacity is a hole between the two — nothing else
            // paints there. Over a drag committed in twenty chunks those holes
            // line up into the cracks down the sides of a rubbed band.
            const outside = splitClosedFilledPath(
                splitPathMetadata, flatCmds, subject, sampledEraserPoints, radius,
                false, eraserRegion
            );
            if (!outside) return [path];
            const dimmed: PathData[] = [];
            if (next !== null) {
                let overlap: MultiPolygon = [];
                try { overlap = intersection(subject, eraserRegion); } catch { overlap = []; }
                for (const poly of normalizeMultiPolygon(overlap)) {
                    const d = polygonToNonZeroD(roundPolygon(poly));
                    if (!d) continue;
                    dimmed.push({
                        ...splitPathMetadata,
                        id: generateId(),
                        d,
                        opacity: next,
                        clipDerived: true,
                    });
                }
            }
            const out = [...outside, ...dimmed];
            if (sync) {
                sync.removed.push(path);
                for (const s of out) sync.added.push(s);
            }
            eraseStats.piecesEmitted += out.length;
            return out;
        }
        const __splitT0 = performance.now();
        const split = splitClosedFilledPath(
            splitPathMetadata,
            flatCmds,
            subject,
            sampledEraserPoints,
            radius,
            eraserPoints.length > 1,
            eraserRegion
        );
        eraseStats.closedFilledSplitMs += performance.now() - __splitT0;
        let out: PathData[];
        if (split) {
            // A shape that is BOTH filled and stroked (baked cloud puffs, glows
            // and halos are filled circles with an outline) cannot be erased as
            // one path. Polygon-clipping the fill yields a new closed region,
            // and stroking THAT traces the eraser's cut edge — drawing a fresh
            // outline right where ink was supposed to be removed. That is the
            // "inner lines" appearing inside an erased cloud.
            //
            // So decompose: the fill keeps the clipped geometry but loses its
            // stroke, and the visible outline is re-derived by cutting the
            // ORIGINAL rim as an open polyline. The rim can then only ever
            // follow the shape's true boundary, never the cut.
            const hasVisibleStroke = !!(path.stroke && path.stroke !== 'none' && (path.strokeWidth ?? 0) > 0);
            if (hasVisibleStroke && !isClipFreehand) {
                const fillPieces = split.map(s => ({ ...s, stroke: 'none' }));
                const rim = splitFlatByEraser(
                    flatCmds, sampledEraserPoints, eraserSegments,
                    effectiveRadius, strokeRadius
                );
                const outlinePieces: PathData[] = [];
                for (const sub of rim.subPaths) {
                    if (sub.length < 2) continue;
                    let d = `M ${sub[0].x.toFixed(EMIT_DECIMALS)} ${sub[0].y.toFixed(EMIT_DECIMALS)}`;
                    for (let i = 1; i < sub.length; i++) d += ` L ${sub[i].x.toFixed(EMIT_DECIMALS)} ${sub[i].y.toFixed(EMIT_DECIMALS)}`;
                    outlinePieces.push({
                        ...path,
                        id: generateId(),
                        d,
                        fill: 'none',
                        transform: hasTranslate ? undefined : path.transform,
                        ...(hasTranslate && path.clipRect ? { clipRect: rebaseClipRect(path, tx, ty) } : {})
                    });
                }
                out = [...fillPieces, ...outlinePieces];
            } else {
                out = split;
            }
            eraseStats.piecesEmitted += out.length;
            if (sync) {
                sync.removed.push(path);
                for (const s of out) sync.added.push(s);
            }
        } else {
            // polygon-clipping totally bailed on this outline (every piece was an
            // artifact). Keep the path unchanged rather than emit a corrupted fill —
            // the per-piece artifact discard above handles the common spurious-fill
            // case; a total bail just leaves this one stroke un-erased this pass.
            if (isClipFreehand) {
                // eslint-disable-next-line no-console
                console.log('[CLIP] a stroke was left un-erased this pass (safe, no reshape).');
            }
            out = [splitPathMetadata];
            // On a bail with a translate, splitPathMetadata is a NEW object
            // (transform stripped) sharing the path's id — its bounds differ, so
            // re-key the grid entry. Without translate splitPathMetadata === path,
            // so nothing changed and no sync is needed.
            if (sync && hasTranslate) {
                sync.removed.push(path);
                sync.added.push(splitPathMetadata);
            }
        }
        if (isClipFreehand) {
            const __recordT0 = performance.now();
            recordClipErase(path, eraserPoints, radius, __lastClipDiag as Record<string, unknown> | null);
            eraseStats.recordMs += performance.now() - __recordT0;
        }
        return out;
    }

    const capPadding = strokeRadius;

    if (pathBounds.maxX < eraserBounds.minX - effectiveRadius || pathBounds.minX > eraserBounds.maxX + effectiveRadius ||
        pathBounds.maxY < eraserBounds.minY - effectiveRadius || pathBounds.minY > eraserBounds.maxY + effectiveRadius) {
        return [path];
    }

    const { subPaths, coveredSubPaths, anyHit } = splitFlatByEraser(flatCmds, sampledEraserPoints, eraserSegments, effectiveRadius, capPadding);
    if (!anyHit) return [path];

    const fade = ctx.fade;
    // Fade mode: whatever the eraser covered comes back at a lower opacity
    // instead of disappearing. When the eraser swallowed the path whole there
    // is nothing to cut, so re-issue it unsplit — that keeps scrubbing over a
    // stroke from multiplying the path count on every pass.
    if (fade && subPaths.length === 0 && coveredSubPaths.length > 0) {
        const step = fadeStep(path, fade);
        if (sync) sync.removed.push(path);
        if (step === null) return [];
        const worn = { ...path, id: generateId(), opacity: step.opacity, transform: hasTranslate ? undefined : path.transform, d: hasTranslate ? flatCmdsToD(flatCmds) : path.d, ...(hasTranslate && path.clipRect ? { clipRect: rebaseClipRect(path, tx, ty) } : {}) };
        if (sync) sync.added.push(worn);
        eraseStats.piecesEmitted += 1;
        return [worn];
    }

    // anyHit ⇒ the original is replaced (split into pieces, or fully erased if
    // no valid sub-path survives). Record the removal up front; each surviving
    // piece is recorded as an addition as it is emitted.
    if (sync) sync.removed.push(path);

    const pieces: PathData[] = [];
    // Set by the fade branch below before it emits anything; `emit` stamps the
    // covered runs with it so the next sweep of this rub knows their floor.
    let fadeStepForPiece: { opacity: number } | null = null;
    const emit = (sub: PointP[], opacity?: number) => {
        if (sub.length < 2) return;

        let d = `M ${sub[0].x.toFixed(EMIT_DECIMALS)} ${sub[0].y.toFixed(EMIT_DECIMALS)}`;
        for (let i = 1; i < sub.length; i++) {
            d += ` L ${sub[i].x.toFixed(EMIT_DECIMALS)} ${sub[i].y.toFixed(EMIT_DECIMALS)}`;
        }

        const piece = {
            ...path,
            id: generateId(),
            d,
            fill: path.fill || 'none',
            transform: hasTranslate ? undefined : path.transform,
            ...(hasTranslate && path.clipRect ? { clipRect: rebaseClipRect(path, tx, ty) } : {}),
            // `opacity` is only passed for the run the eraser actually covered,
            // so it doubles as "this piece took its fade step" for the sweep
            // stamp. Remainders are emitted without it and stay fadeable.
            ...(opacity !== undefined ? { opacity } : {}),
        };
        pieces.push(piece);
        if (sync) sync.added.push(piece);
    };

    if (fade) {
        // The eraser band never lands in exactly the same place twice, so each
        // pass would otherwise shave a hair-thin sliver off the neighbouring
        // pieces at a slightly different opacity — and those accumulate. Runs
        // below a pixel are visually meaningless, so they are absorbed into
        // whichever side they came from instead of becoming their own path.
        //
        // The floor is at least `capPadding`, because a run that short is one the
        // padding created: a piece from an earlier pass reaches capPadding beyond
        // the covered band, so re-covering it leaves exactly that much sticking
        // out — and erasedIntervalsForSegment drops the padding when it would
        // swallow the piece whole, so no amount of further rubbing can ever reach
        // it. Below this floor the sliver shares the band's fate instead of
        // stranding a half-faded crumb at the edge of the gap forever.
        const MIN_FADE_RUN = Math.max(1.5, capPadding + 0.1);
        const runLength = (sub: PointP[]) => {
            let len = 0;
            for (let i = 1; i < sub.length; i++) len += Math.hypot(sub[i].x - sub[i - 1].x, sub[i].y - sub[i - 1].y);
            return len;
        };
        const step = fadeStep(path, fade);
        fadeStepForPiece = step;
        const next = step ? step.opacity : null;
        for (const sub of subPaths) {
            if (runLength(sub) >= MIN_FADE_RUN) { emit(sub); continue; }
            // A surviving sliver shorter than the stroke is thick is DROPPED, not
            // re-emitted at the band's opacity. Emitting it made a path barely
            // longer than its own round caps, which renders as a filled DISC —
            // scrub back and forth and the result is a row of translucent circles
            // at assorted opacities instead of a clean band. The neighbouring
            // runs' caps already cover the couple of units this gives up.
        }
        if (next !== null) {
            for (const sub of coveredSubPaths) {
                // Likewise a covered run too short to read as a line: leaving it
                // at full opacity would plant a solid dot in the middle of the
                // faded band.
                if (runLength(sub) >= MIN_FADE_RUN) emit(sub, next);
            }
        }
    } else {
        for (const sub of subPaths) emit(sub);
    }
    eraseStats.piecesEmitted += pieces.length;
    return pieces;
};

/** `d` for geometry that must line up with something already on the page, at
 *  full precision — see where it is used. */
const exactMultiPolygonToD = (mp: MultiPolygon): string => {
    const parts: string[] = [];
    for (const polygon of mp) {
        for (const ring of polygon) {
            const points = normalizedRingPoints(ring);
            if (points.length < 3) continue;
            parts.push(`M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`);
        }
    }
    return parts.join(' ');
};

/** The area a piece of ink paints, as a region. */
const inkRegion = (path: PathData): MultiPolygon | null => {
    const { flatCmds } = cachedFlatten(path);
    if (flatCmds.length === 0) return null;
    if (isClosedFilledPath(path)) return cachedSubject(path, flatCmds);

    // An open stroke paints a capsule per segment, the same shape the eraser
    // itself sweeps.
    const half = Math.max(0.05, (path.strokeWidth || 1) / 2);
    const parts: Geometry[] = [];
    let prev: FlatCommand | null = null;
    for (const cmd of flatCmds) {
        if (cmd.type === 'M') { prev = cmd; continue; }
        if (prev) parts.push(capsulePolygon(prev, cmd, half));
        prev = cmd;
    }
    if (parts.length === 0 && flatCmds.length === 1) parts.push(circlePolygon(flatCmds[0], half));
    if (parts.length === 0) return null;
    const merged = unionGeometryParts(parts);
    return merged ? (merged as MultiPolygon) : null;
};

/** Ink that composites with itself — same colour, same strength, same layer,
 *  no blend mode. Null for anything that must be left alone. */
const fadedInkKey = (p: PathData): string | null => {
    if (p.blendMode && p.blendMode !== 'normal') return null;
    const hasFill = !!p.fill && p.fill !== 'none';
    const hasStroke = !!p.stroke && p.stroke !== 'none' && (p.strokeWidth ?? 0) > 0;
    // Filled AND stroked paints two regions, not one.
    if (hasFill === hasStroke) return null;
    const ink = hasFill ? p.fill : p.stroke;
    return `${p.layerId ?? 'default'}|${ink}|${p.opacity}|${p.fillRule ?? 'nonzero'}`;
};

/**
 * Make the ink this pass just faded ONE layer.
 *
 * This is what "erase through stacked ink" has to mean, and no opacity value
 * can deliver it. Rub a solid black scribble and every stroke under the eraser
 * steps down together — yet where four of them crossed, four faded strokes
 * still composite darker than the two beside them. The rubbed area comes back
 * grey with every stroke that built it drawn in: the ink underneath is
 * revealed, which is the exact thing the option exists to prevent. Stepping
 * them down FURTHER (the old normalized ladder) only changes the grey; the
 * structure survives because it is in the geometry, not the opacity.
 *
 * So the overlaps are removed: walking each set of same-ink faded pieces from
 * the top down, every piece gives up whatever a piece above it already paints.
 * The result covers exactly the same area at exactly one thickness.
 *
 * It cannot change the picture. The area given up is, by construction, covered
 * by ink of the same colour at the same opacity — either that ink is what you
 * see there, or something opaque between the two hides both. Ink of a DIFFERENT
 * colour in between is not a problem for the same reason: it keeps painting
 * whatever it painted, in the same order, over one layer instead of two.
 * Nothing moves in z-order, so this works where merging whole strokes cannot —
 * black split by a white line through it flattens fine.
 *
 * Left alone: blended ink (multiply builds up ON PURPOSE) and ink that is both
 * filled and stroked.
 */
const flattenFadedInk = (
    result: PathData[],
    reach: { minX: number; minY: number; maxX: number; maxY: number },
    fade?: FadeOptions
): PathData[] => {
    if (!fade?.normalizeStack) return result;

    // Every piece of ink this rub could have left overlapping or abutting,
    // grouped by exactly what it paints — colour AND strength, so tones never
    // mix. Deliberately NOT limited to the pieces this pass produced: "apply
    // while erasing" commits one rub in chunks, so the piece that overlaps the
    // one just faded is usually the previous chunk's, and a seam down the middle
    // of the stroke is exactly the artefact being removed.
    //
    // Only FADED ink. Merging the full-opacity leftovers as well is the obvious
    // next move — a blob rubbed sixty times is 271 pieces, and every boundary is
    // a place where two independently-rasterised edges have to meet exactly on a
    // 0.1 grid — but it measures WORSE (271 hairline holes against 168), because
    // re-emitting a piece re-quantises boundaries it shares with neighbours that
    // were not re-emitted. Every rewrite of settled geometry is a fresh chance to
    // miss; the cure has to be to rewrite less, not more.
    //
    // Limited to what this rub reaches, so ink elsewhere is left alone.
    const groups = new Map<string, number[]>();
    for (let i = 0; i < result.length; i++) {
        const p = result[i];
        if ((p.opacity ?? 1) >= 1) continue;
        const bbox = cachedFlatten(p).bbox;
        if (!bbox) continue;
        if (bbox.maxX < reach.minX || bbox.minX > reach.maxX) continue;
        if (bbox.maxY < reach.minY || bbox.minY > reach.maxY) continue;
        const key = fadedInkKey(p);
        if (!key) continue;
        const group = groups.get(key);
        if (group) group.push(i); else groups.set(key, [i]);
    }

    const trimmed = new Map<number, PathData | null>();
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;

        // Pieces that can become ONE path, in z-order runs. Two faded pieces
        // that merely sit side by side still show the join: each is composited
        // separately, so the antialiased edge where they meet reads as a
        // hairline through the tone. Painting a run as a single path with
        // several subpaths has no interior edges at all.
        //
        // A run may only be collapsed onto its topmost member if nothing of
        // ANOTHER colour that overlaps it sits in between — that ink would end
        // up underneath. Same-coloured ink is no obstacle: covering it with the
        // same colour changes nothing.
        const ink = (p: PathData) => (p.fill && p.fill !== 'none' ? p.fill : p.stroke) ?? '';
        const overlaps = (
            a: { minX: number; minY: number; maxX: number; maxY: number } | null,
            b: { minX: number; minY: number; maxX: number; maxY: number } | null,
            pad = 0
        ) => !!a && !!b && a.minX - pad <= b.maxX && a.maxX + pad >= b.minX && a.minY - pad <= b.maxY && a.maxY + pad >= b.minY;

        const runs: { indices: number[]; box: { minX: number; minY: number; maxX: number; maxY: number } | null }[] = [];
        for (const i of indices) {
            const mine = cachedFlatten(result[i]).bbox;
            const run = runs[runs.length - 1];
            // Only pieces that actually meet need to become one path — a join is
            // only visible where there is a join. Ink lying apart is left as the
            // separate strokes it is.
            let joins = !!run && overlaps(mine, run.box, 0.5);
            if (joins && run) {
                const from = run.indices[run.indices.length - 1];
                for (let between = from + 1; between < i && joins; between++) {
                    const other = result[between];
                    if (ink(other) === ink(result[i])) continue;
                    joins = !overlaps(cachedFlatten(other).bbox, mine);
                }
            }
            if (joins && run) {
                run.indices.push(i);
                if (mine) run.box = run.box
                    ? {
                        minX: Math.min(run.box.minX, mine.minX), minY: Math.min(run.box.minY, mine.minY),
                        maxX: Math.max(run.box.maxX, mine.maxX), maxY: Math.max(run.box.maxY, mine.maxY)
                    }
                    : mine;
            } else {
                runs.push({ indices: [i], box: mine });
            }
        }

        // Top run keeps everything; each one below gives up what is already
        // painted above it.
        let covered: MultiPolygon | null = null;
        for (let r = runs.length - 1; r >= 0; r--) {
            const run = runs[r].indices;
            const parts: MultiPolygon[] = [];
            for (const i of run) {
                const region = inkRegion(result[i]);
                if (region && region.length) parts.push(region);
            }
            if (parts.length === 0) continue;
            let whole: MultiPolygon | null = parts[0];
            if (parts.length > 1) {
                try {
                    whole = unionGeometryParts(parts) as MultiPolygon | null;
                } catch {
                    // The engines can throw on degenerate input. Flattening is a
                    // refinement — leave the run as separate pieces rather than
                    // let it take the whole erase pass down.
                    whole = null;
                }
            }
            if (!whole || whole.length === 0) continue;

            let remainder = whole;
            if (covered && covered.length > 0) {
                try {
                    const trimmedTo = difference(whole, covered) as MultiPolygon;
                    // Trim only when there is a real overlap to remove. A
                    // hairline one is not worth cutting for: the cut has to line
                    // up with the piece above to within a fraction of a pixel,
                    // and when it misses, the white gap it leaves is far more
                    // visible than the sliver of double-darkness it was removing.
                    // (Plain fade opens no gaps at all; this trim was the only
                    // thing still opening them.)
                    const removed = multiPolygonFilledArea(whole) - multiPolygonFilledArea(trimmedTo);
                    if (removed > MIN_WORTHWHILE_TRIM) remainder = trimmedTo;
                } catch {
                    // A failed boolean leaves the run as it is: showing the
                    // overlap is far better than dropping ink.
                    remainder = whole;
                }
            }
            const changed = remainder !== whole || run.length > 1;
            if (changed) {
                const top = run[run.length - 1];
                // Emitted at FULL precision, unrounded. This shape was cut
                // against the outline of the piece above it, so it already
                // shares that outline exactly — and snapping it onto the 0.1
                // grid is what pulls it back off, leaving the hairline this
                // whole step exists to remove. (Measured: plain fade leaves no
                // gaps at all; flattening was the only thing still opening
                // them.) It is a handful of pieces per rub, so the extra
                // digits cost nothing at the document level.
                const d = remainder.length === 0 ? '' : exactMultiPolygonToD(remainder);
                const template = result[top];
                // Everything below the top member is folded into it.
                for (const i of run) if (i !== top) trimmed.set(i, null);
                trimmed.set(top, d
                    ? {
                        ...template,
                        d,
                        // Merged or trimmed, this is no longer a centreline —
                        // the area it paints is the only faithful description.
                        fill: (template.fill && template.fill !== 'none') ? template.fill : template.stroke,
                        stroke: 'none',
                        strokeWidth: 0,
                        fillRule: 'nonzero',
                        transform: undefined,
                        freehandSource: undefined,
                        clipDerived: true
                    }
                    : null);
            }
            try {
                const grown = covered ? unionGeometryParts([covered, whole]) : whole;
                if (grown) covered = grown as MultiPolygon;
            } catch { /* keep the coverage we already have */ }
        }
    }

    if (trimmed.size === 0) return result;
    const out: PathData[] = [];
    for (let i = 0; i < result.length; i++) {
        if (!trimmed.has(i)) { out.push(result[i]); continue; }
        const replacement = trimmed.get(i);
        if (replacement) out.push(replacement);
    }
    return out;
};

export function splitPathsByEraser(
    currentPaths: PathData[],
    eraserPoints: Point[],
    radius: number,
    isLayerLocked: (layerId?: string) => boolean = () => false,
    opts?: {
        /** Ids of paths the broadphase says could intersect the eraser this pass.
         *  When provided, any path whose `id` is not in the set is carried through
         *  untouched (skipped before any geometry work). Id-keyed so it survives
         *  Svelte proxy re-wrapping of split pieces. */
        candidates?: Set<string>;
        /** When provided, records the originals removed and pieces added this pass
         *  so the caller can patch its spatial index without a full rebuild. */
        sync?: { removed: PathData[]; added: PathData[] };
        /** Fade instead of cut: ink under the eraser is kept at a reduced
         *  opacity, so repeated passes wear it away like a real rubber. */
        fade?: FadeOptions;
    }
): PathData[] {
    if (eraserPoints.length === 0) return currentPaths;

    const candidates = opts?.candidates;
    const sync = opts?.sync;
    // Everything this rub could have touched — the trail's box grown by the
    // eraser. Flattening looks no further than this.
    const trailBounds = pointBounds(eraserPoints);
    const eraserReach = {
        minX: trailBounds.minX - radius, minY: trailBounds.minY - radius,
        maxX: trailBounds.maxX + radius, maxY: trailBounds.maxY + radius
    };

    /** Everything this call changed, against the array the CALLER handed in.
     *  Used when a step outside the per-path pass edited the array too, so the
     *  pass's own record describes only part of it. Identity is the key:
     *  carried-through paths are the same object on both sides. */
    const diffAgainstInput = (result: PathData[]) => {
        if (!sync) return;
        const survived = new Set(result);
        for (const p of currentPaths) if (!survived.has(p)) sync.removed.push(p);
        const original = new Set(currentPaths);
        for (const p of result) if (!original.has(p)) sync.added.push(p);
    };

    const runPass = (paths: PathData[], points: Point[], passSync?: { removed: PathData[]; added: PathData[] }) => {
        // Move-shared eraser geometry: one resample/bounds/segments (and at most one
        // getStroke, lazily) per call, reused across every path via splitOnePathByEraser.
        const ctx = buildEraserCtx(points, radius, opts?.fade);
        const out: PathData[] = [];
        for (const path of paths) {
            const pieces = splitOnePathByEraser(path, ctx, isLayerLocked, candidates, passSync);
            if (pieces.length) out.push(...pieces);
        }
        return out;
    };

    // A scrub that doubles back is several passes in one drag. Applying them in
    // sequence is what makes rubbing harder actually wear the ink down further;
    // unioned into one pass, the second sweep over a spot would change nothing.
    const fade = opts?.fade;
    if (fade?.accumulate) {
        const passes = splitTrailIntoPasses(eraserPoints, radius);
        if (passes.length > 1) {
            let paths = currentPaths;
            // Only the FIRST pass can trust the caller's candidate set: later
            // passes run against pieces with fresh ids the set cannot name.
            for (let i = 0; i < passes.length; i++) {
                const first = i === 0;
                // Each pass here IS a separate sweep, so only the first inherits
                // the caller's sweep stamp; the rest get their own, or ink faded
                // by pass 1 would be immune to passes 2..n.
                const passFade = fade;
                const ctx = buildEraserCtx(passes[i], radius, passFade);
                const out: PathData[] = [];
                for (const path of paths) {
                    const pieces = splitOnePathByEraser(path, ctx, isLayerLocked, first ? candidates : undefined);
                    if (pieces.length) out.push(...pieces);
                }
                paths = out;
            }
            // Per-pass sync would record the intermediates, which the caller must
            // never see.
            paths = flattenFadedInk(paths, eraserReach, fade);
            diffAgainstInput(paths);
            return paths;
        }
    }

    // Flattening rewrites pieces the pass had already recorded, so its own
    // running record no longer describes the outcome — diff the endpoints.
    if (fade?.normalizeStack) {
        const out = flattenFadedInk(runPass(currentPaths, eraserPoints), eraserReach, fade);
        diffAgainstInput(out);
        return out;
    }
    return runPass(currentPaths, eraserPoints, sync);
}
