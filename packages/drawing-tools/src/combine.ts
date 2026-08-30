import type { MultiPolygon, Ring } from 'polygon-clipping';
import type { PathData } from './types.ts';
import { generateId } from './id.ts';
import { flattenPathData } from './flatten.ts';
import { strokeToRegion } from './offset.ts';
import { safeUnionBarriers } from './bucketVector.ts';
import { multiPolygonBox, ringsToMultiPolygon, type Box, boxesIntersect } from './rings.ts';

/**
 * Flatten overlapping ink into single shapes.
 *
 * A sketch built from many overlapping strokes carries a lot of geometry nobody
 * can see: wherever strokes stack, the ones underneath are completely hidden by
 * the ones on top, yet they are still there — still split by the eraser, still
 * rendered, still saved. Worse for the fade eraser, whose whole job is to thin
 * ink out: fading the top stroke just REVEALS the buried one, so a stack never
 * looks erased, it looks peeled.
 *
 * Combining replaces a run of stacked strokes with the union of the area they
 * cover: one filled shape, pixel-identical, with nothing hidden underneath.
 *
 * WHAT IT WILL NOT TOUCH, and why it must not:
 *
 *   - Translucent ink. Two overlapping strokes at 50% composite darker where
 *     they cross; one union of the same area does not. Merging would change the
 *     picture.
 *   - Blend modes. `multiply` is chosen precisely so overlaps build up — that
 *     is the point of pencil and marker.
 *   - Ink that is both filled AND stroked, which needs two regions, not one.
 *   - Anything separated in z-order by OVERLAPPING ink of another colour.
 *     Merging across that would hoist the lower stroke above the one covering
 *     it. Only runs that are safe to collapse in place are collapsed.
 */

export interface CombineOptions {
    /** Flattening tolerance for curves, in user units. */
    tolerance?: number;
}

export interface CombineResult {
    paths: PathData[];
    /** Originals that were folded into a combined shape. */
    absorbed: number;
    /** Combined shapes emitted in their place. */
    produced: number;
    /** Paths deliberately left alone (translucent, blended, or unsafe to move). */
    untouched: number;
}

/** Ink is only interchangeable if it paints the same colour the same way. */
function combineKey(p: PathData): string | null {
    if ((p.opacity ?? 1) !== 1) return null;
    if (p.blendMode && p.blendMode !== 'normal') return null;

    const hasFill = !!p.fill && p.fill !== 'none';
    const hasStroke = !!p.stroke && p.stroke !== 'none' && (p.strokeWidth ?? 0) > 0;
    // Filled AND stroked needs two regions; that is a different feature.
    if (hasFill && hasStroke) return null;
    if (!hasFill && !hasStroke) return null;

    const ink = hasFill ? p.fill : p.stroke;
    return `${p.layerId ?? 'default'}|${hasFill ? 'fill' : 'stroke'}|${ink}|${p.fillRule ?? 'nonzero'}`;
}

/** The area a path actually covers, as a region. */
function pathRegion(p: PathData, tolerance: number): MultiPolygon {
    const subpaths = flattenPathData(p, tolerance);
    const hasFill = !!p.fill && p.fill !== 'none';

    if (hasFill) {
        // Every subpath is a ring of ONE filled shape, so they have to be
        // resolved TOGETHER. A ring nested inside another is that shape's hole,
        // not a second solid blob: treating each ring as its own polygon and
        // unioning them paints the hole in, so anything ring-shaped — a circle
        // that was already combined once, a stroke the eraser punched a gap in,
        // a bucket fill around an island — came back a solid disc.
        return ringsToMultiPolygon(subpaths.filter(sub => sub.points.length > 2).map(sub => sub.points as Ring));
    }

    const parts: MultiPolygon[] = [];
    for (const sub of subpaths) {
        if (sub.points.length < 2) continue;
        const region = strokeToRegion(sub.points as Ring, p.strokeWidth || 1, sub.closed, tolerance);
        if (region.length) parts.push(region);
    }

    if (parts.length === 0) return [];
    if (parts.length === 1) return parts[0];
    const merged = safeUnionBarriers(parts);
    return merged && merged.dropped === 0 ? merged.geometry : parts.flat() as MultiPolygon;
}

function regionToPathD(region: MultiPolygon): string {
    const out: string[] = [];
    for (const polygon of region) {
        for (const ring of polygon) {
            if (ring.length < 3) continue;
            out.push(`M ${ring.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`);
        }
    }
    return out.join(' ');
}

/**
 * Collapse each run of stacked, same-ink strokes into one filled shape.
 *
 * Runs are contiguous in z-order, extended over intervening paths only when
 * those do not OVERLAP the run — so the visible stacking order is preserved
 * exactly and the result is pixel-identical.
 */
export function combineStrokes(paths: PathData[], opts: CombineOptions = {}): CombineResult {
    const tolerance = opts.tolerance ?? 0.25;

    // Group indices by ink, but only while nothing overlapping and differently
    // inked sits between them.
    const groups: { key: string; indices: number[]; box: Box | null }[] = [];
    const regions = new Map<number, MultiPolygon>();
    const boxes = new Map<number, Box | null>();

    for (let i = 0; i < paths.length; i++) {
        const key = combineKey(paths[i]);
        if (!key) continue;
        const region = pathRegion(paths[i], tolerance);
        if (region.length === 0) continue;
        regions.set(i, region);
        boxes.set(i, multiPolygonBox(region));
    }

    for (let i = 0; i < paths.length; i++) {
        if (!regions.has(i)) continue;
        const key = combineKey(paths[i])!;
        const box = boxes.get(i) ?? null;
        // Join the most recent compatible run, but only if no path between it
        // and here paints over the area they share.
        let joined = false;
        for (let g = groups.length - 1; g >= 0; g--) {
            const group = groups[g];
            if (group.key !== key) continue;
            const last = group.indices[group.indices.length - 1];
            let blocked = false;
            for (let between = last + 1; between < i && !blocked; between++) {
                if (regions.has(between) && combineKey(paths[between]) === key) continue;
                const otherBox = boxes.get(between) ?? null;
                // An unmeasured path in between could be anything: assume it
                // overlaps rather than risk reordering it.
                blocked = !otherBox || !box || boxesIntersect(otherBox, box);
            }
            if (!blocked) {
                group.indices.push(i);
                group.box = group.box && box
                    ? {
                        minX: Math.min(group.box.minX, box.minX), minY: Math.min(group.box.minY, box.minY),
                        maxX: Math.max(group.box.maxX, box.maxX), maxY: Math.max(group.box.maxY, box.maxY)
                    }
                    : (group.box ?? box);
                joined = true;
            }
            break;
        }
        if (!joined) groups.push({ key, indices: [i], box });
    }

    const replacement = new Map<number, PathData[]>();
    const dropped = new Set<number>();
    let absorbed = 0;
    let produced = 0;

    for (const group of groups) {
        if (group.indices.length < 2) continue;
        const parts = group.indices.map(i => regions.get(i)!);
        const merged = safeUnionBarriers(parts);
        // A dropped region means ink went missing — leave the group as it was.
        if (!merged || merged.dropped > 0) continue;
        const d = regionToPathD(merged.geometry);
        if (!d) continue;

        const template = paths[group.indices[group.indices.length - 1]];
        const hasFill = !!template.fill && template.fill !== 'none';
        const combined: PathData = {
            ...template,
            id: generateId(),
            d,
            fill: hasFill ? template.fill : template.stroke,
            stroke: 'none',
            strokeWidth: 0,
            fillRule: 'nonzero',
            transform: undefined,
            freehandSource: undefined,
            clipDerived: true
        };
        // The combined shape takes the position of the topmost member, so it
        // still sits above everything it used to sit above.
        replacement.set(group.indices[group.indices.length - 1], [combined]);
        for (const i of group.indices.slice(0, -1)) dropped.add(i);
        absorbed += group.indices.length;
        produced += 1;
    }

    const out: PathData[] = [];
    for (let i = 0; i < paths.length; i++) {
        if (dropped.has(i)) continue;
        const swap = replacement.get(i);
        if (swap) out.push(...swap);
        else out.push(paths[i]);
    }

    return { paths: out, absorbed, produced, untouched: paths.length - absorbed };
}
