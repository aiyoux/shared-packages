import type { Ring } from 'polygon-clipping';
import type { PathData } from './types.ts';
import { ARGS_PER_COMMAND, parsePath, sampleArc } from './path.ts';

/** SVG `d` → polylines.
 *
 *  The vector bucket engine works on polygons, so every curve in a path has to
 *  become points first. `raster.ts` already flattens implicitly (Path2D does it
 *  in the browser) and `arcAwarePathBounds` already walks commands for bounds —
 *  this is the third consumer of that walk and the only one that needs the
 *  actual geometry, so it lives on its own rather than being bolted onto either.
 *
 *  Subpaths come back separately: a path with an `M` in the middle is two rings,
 *  and collapsing them into one would weld a letter's counter to its outline. */

const TRANSLATE_RE = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/;
const SCALE_RE = /scale\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/;

export interface FlattenedSubpath {
    points: Ring;
    /** Whether the subpath ended with a `Z`. Open subpaths are strokes to be
     *  outlined; closed ones are already regions. */
    closed: boolean;
}

/** Segment count for a cubic at a given flatness tolerance.
 *
 *  Bound: subdividing into n equal-parameter pieces leaves an error of at most
 *  (3/4)·n⁻²·max(|P0-2P1+P2|, |P1-2P2+P3|). Solving for the tolerance gives the
 *  count directly, so a gentle curve costs 2 points and a tight one costs what
 *  it needs — far better than a fixed count, which is simultaneously too coarse
 *  on baked 3D geometry and too fine on the thousands of tiny beziers a
 *  freehand outline is made of. */
function cubicSegments(
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number, tolerance: number
): number {
    const ax = x0 - 2 * x1 + x2, ay = y0 - 2 * y1 + y2;
    const bx = x1 - 2 * x2 + x3, by = y1 - 2 * y2 + y3;
    const m = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    if (m <= 0) return 1;
    return Math.min(256, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / Math.max(tolerance, 1e-6)))));
}

function quadSegments(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, tolerance: number
): number {
    const m = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2);
    if (m <= 0) return 1;
    return Math.min(256, Math.max(1, Math.ceil(Math.sqrt(m / (8 * Math.max(tolerance, 1e-6))))));
}

/**
 * Flatten a path `d` into subpaths of points.
 *
 * `tolerance` is the maximum deviation, in the path's own units, that a
 * flattened curve may have from the true curve.
 */
export function flattenPathToSubpaths(d: string, tolerance = 0.25): FlattenedSubpath[] {
    const out: FlattenedSubpath[] = [];
    let current: Ring = [];
    let curX = 0, curY = 0, startX = 0, startY = 0;
    // Reflected control point for the S/T shorthands. Reset to the current point
    // whenever the previous command wasn't the matching curve type, per spec.
    let lastCubicCtrlX = 0, lastCubicCtrlY = 0;
    let lastQuadCtrlX = 0, lastQuadCtrlY = 0;
    let prevType = '';

    const push = (x: number, y: number) => {
        // Repeated points are worthless to every consumer (they contribute zero
        // area and confuse the offsetter's direction maths).
        const n = current.length;
        if (n > 0 && current[n - 1][0] === x && current[n - 1][1] === y) return;
        current.push([x, y]);
    };

    const finish = (closed: boolean) => {
        if (current.length >= 2) out.push({ points: current, closed });
        current = [];
    };

    for (const cmd of parsePath(d)) {
        const type = cmd.type.toUpperCase();
        const rel = cmd.type !== type;
        const stride = ARGS_PER_COMMAND[type];
        if (stride === undefined) continue;

        if (type === 'Z') {
            finish(true);
            curX = startX;
            curY = startY;
            prevType = type;
            continue;
        }

        // A command with too few args to form one repetition is malformed; skip
        // rather than reading undefined into the geometry.
        if (cmd.args.length < stride) { prevType = type; continue; }

        for (let i = 0; i + stride <= cmd.args.length; i += stride) {
            const a = cmd.args;
            switch (type) {
                case 'M': {
                    const nx = rel ? curX + a[i] : a[i];
                    const ny = rel ? curY + a[i + 1] : a[i + 1];
                    // Only the first pair of an `M` run is a move; the rest are
                    // implicit lineto, so the subpath breaks exactly once.
                    if (i === 0) {
                        finish(false);
                        startX = nx; startY = ny;
                        curX = nx; curY = ny;
                        push(nx, ny);
                    } else {
                        curX = nx; curY = ny;
                        push(nx, ny);
                    }
                    break;
                }
                case 'L': {
                    curX = rel ? curX + a[i] : a[i];
                    curY = rel ? curY + a[i + 1] : a[i + 1];
                    push(curX, curY);
                    break;
                }
                case 'H': {
                    curX = rel ? curX + a[i] : a[i];
                    push(curX, curY);
                    break;
                }
                case 'V': {
                    curY = rel ? curY + a[i] : a[i];
                    push(curX, curY);
                    break;
                }
                case 'C':
                case 'S': {
                    let c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number;
                    if (type === 'C') {
                        c1x = rel ? curX + a[i] : a[i];
                        c1y = rel ? curY + a[i + 1] : a[i + 1];
                        c2x = rel ? curX + a[i + 2] : a[i + 2];
                        c2y = rel ? curY + a[i + 3] : a[i + 3];
                        ex = rel ? curX + a[i + 4] : a[i + 4];
                        ey = rel ? curY + a[i + 5] : a[i + 5];
                    } else {
                        const smooth = prevType === 'C' || prevType === 'S';
                        c1x = smooth ? 2 * curX - lastCubicCtrlX : curX;
                        c1y = smooth ? 2 * curY - lastCubicCtrlY : curY;
                        c2x = rel ? curX + a[i] : a[i];
                        c2y = rel ? curY + a[i + 1] : a[i + 1];
                        ex = rel ? curX + a[i + 2] : a[i + 2];
                        ey = rel ? curY + a[i + 3] : a[i + 3];
                    }
                    const n = cubicSegments(curX, curY, c1x, c1y, c2x, c2y, ex, ey, tolerance);
                    for (let k = 1; k <= n; k++) {
                        const t = k / n, mt = 1 - t;
                        const w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
                        push(
                            w0 * curX + w1 * c1x + w2 * c2x + w3 * ex,
                            w0 * curY + w1 * c1y + w2 * c2y + w3 * ey
                        );
                    }
                    lastCubicCtrlX = c2x; lastCubicCtrlY = c2y;
                    curX = ex; curY = ey;
                    break;
                }
                case 'Q':
                case 'T': {
                    let cx: number, cy: number, ex: number, ey: number;
                    if (type === 'Q') {
                        cx = rel ? curX + a[i] : a[i];
                        cy = rel ? curY + a[i + 1] : a[i + 1];
                        ex = rel ? curX + a[i + 2] : a[i + 2];
                        ey = rel ? curY + a[i + 3] : a[i + 3];
                    } else {
                        const smooth = prevType === 'Q' || prevType === 'T';
                        cx = smooth ? 2 * curX - lastQuadCtrlX : curX;
                        cy = smooth ? 2 * curY - lastQuadCtrlY : curY;
                        ex = rel ? curX + a[i] : a[i];
                        ey = rel ? curY + a[i + 1] : a[i + 1];
                    }
                    const n = quadSegments(curX, curY, cx, cy, ex, ey, tolerance);
                    for (let k = 1; k <= n; k++) {
                        const t = k / n, mt = 1 - t;
                        push(
                            mt * mt * curX + 2 * mt * t * cx + t * t * ex,
                            mt * mt * curY + 2 * mt * t * cy + t * t * ey
                        );
                    }
                    lastQuadCtrlX = cx; lastQuadCtrlY = cy;
                    curX = ex; curY = ey;
                    break;
                }
                case 'A': {
                    const ex = rel ? curX + a[i + 5] : a[i + 5];
                    const ey = rel ? curY + a[i + 6] : a[i + 6];
                    for (const pt of sampleArc(curX, curY, a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], ex, ey)) {
                        push(pt.x, pt.y);
                    }
                    curX = ex; curY = ey;
                    break;
                }
            }
        }
        prevType = type;
    }

    finish(false);
    return out;
}

/** Apply a PathData's `transform` to already-flattened points.
 *
 *  Only translate() and scale() are recognised — the same subset `raster.ts`
 *  honours, and the same subset the app actually writes (bake groups and
 *  imported geometry). Anything else is ignored rather than guessed at, which
 *  matches how those paths already render. */
export function applyPathTransform(points: Ring, transform?: string): Ring {
    if (!transform) return points;
    let tx = 0, ty = 0, sx = 1, sy = 1;
    const t = TRANSLATE_RE.exec(transform);
    if (t) { tx = parseFloat(t[1]); ty = parseFloat(t[2]); }
    const s = SCALE_RE.exec(transform);
    if (s) { sx = parseFloat(s[1]); sy = s[2] !== undefined ? parseFloat(s[2]) : sx; }
    if (tx === 0 && ty === 0 && sx === 1 && sy === 1) return points;
    // SVG applies transform="translate(..) scale(..)" right-to-left: scale first.
    return points.map(([x, y]) => [x * sx + tx, y * sy + ty]) as Ring;
}

/** Flatten a PathData into world-space subpaths, transform included. */
export function flattenPathData(p: PathData, tolerance = 0.25): FlattenedSubpath[] {
    const subpaths = flattenPathToSubpaths(p.d, tolerance);
    if (!p.transform) return subpaths;
    return subpaths.map(sp => ({ points: applyPathTransform(sp.points, p.transform), closed: sp.closed }));
}
