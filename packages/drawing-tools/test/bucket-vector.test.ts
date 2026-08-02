import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPathToSubpaths, applyPathTransform } from '../src/flatten.ts';
import { strokeOutlineRing, strokeToRegion, inflateMultiPolygon } from '../src/offset.ts';
import { vectorBucketFill, pathToBarrierRegion, findEnclosingHole, safeUnionBarriers } from '../src/bucketVector.ts';
import { multiPolygonArea, ringSignedArea, pointInRing, snapMultiPolygon } from '../src/rings.ts';
import type { PathData } from '../src/types.ts';
import type { Ring } from 'polygon-clipping';

const base: PathData = { d: '', stroke: 'none', fill: 'none', strokeWidth: 0, layerId: 'default' };

/** A closed square outline drawn as a centreline stroke. */
function strokedSquare(x: number, y: number, size: number, width: number): PathData {
    return {
        ...base,
        d: `M ${x} ${y} L ${x + size} ${y} L ${x + size} ${y + size} L ${x} ${y + size} Z`,
        stroke: '#000',
        strokeWidth: width
    };
}

describe('flattenPathToSubpaths', () => {
    it('splits on a mid-path moveto', () => {
        const sub = flattenPathToSubpaths('M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20');
        assert.equal(sub.length, 2);
        assert.equal(sub[0].closed, true);
        assert.equal(sub[1].closed, false);
        assert.deepEqual(sub[1].points, [[20, 20], [30, 20]]);
    });

    it('handles relative commands and the H/V shorthands', () => {
        const sub = flattenPathToSubpaths('M 10 10 h 10 v 10 l -10 0 z');
        assert.equal(sub.length, 1);
        assert.equal(sub[0].closed, true);
        assert.deepEqual(sub[0].points, [[10, 10], [20, 10], [20, 20], [10, 20]]);
    });

    it('flattens a cubic to within the requested tolerance', () => {
        // A half-circle-ish arc; every sampled point should sit near the curve.
        const sub = flattenPathToSubpaths('M 0 0 C 0 10 10 10 10 0', 0.05);
        const pts = sub[0].points;
        assert.ok(pts.length > 8, `expected a fine flattening, got ${pts.length} points`);
        assert.deepEqual(pts[0], [0, 0]);
        assert.deepEqual(pts[pts.length - 1], [10, 0]);
        // The cubic's apex is at t=0.5 → y = 7.5.
        const maxY = Math.max(...pts.map(p => p[1]));
        assert.ok(Math.abs(maxY - 7.5) < 0.1, `apex was ${maxY}`);
    });

    it('spends fewer points on a looser tolerance', () => {
        const fine = flattenPathToSubpaths('M 0 0 C 0 40 40 40 40 0', 0.05)[0].points.length;
        const coarse = flattenPathToSubpaths('M 0 0 C 0 40 40 40 40 0', 2)[0].points.length;
        assert.ok(coarse < fine, `${coarse} should be fewer than ${fine}`);
    });

    it('reflects the control point for the S shorthand', () => {
        const withShorthand = flattenPathToSubpaths('M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0', 0.1);
        const explicit = flattenPathToSubpaths('M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0', 0.1);
        assert.deepEqual(withShorthand[0].points, explicit[0].points);
    });

    it('applies translate and scale from a transform', () => {
        const out = applyPathTransform([[1, 2], [3, 4]] as Ring, 'translate(10, 20) scale(2)');
        assert.deepEqual(out, [[12, 24], [16, 28]]);
    });
});

describe('strokeOutlineRing', () => {
    // Arcs are approximated by INSCRIBED chords, so every rounded area comes out
    // slightly under the analytic value — never over. These assertions pin both
    // the direction and the size of that deficit rather than papering over it
    // with a loose window.
    const inscribedWithin = (actual: number, exact: number, budget: number, what: string) => {
        assert.ok(actual <= exact + 1e-6, `${what}: ${actual} should not exceed the exact ${exact}`);
        assert.ok(actual > exact - budget, `${what}: ${actual} is further than ${budget} under ${exact}`);
    };

    it('wraps a straight segment in a capsule of the right area', () => {
        const ring = strokeOutlineRing([[0, 0], [10, 0]] as Ring, 2);
        assert.ok(ring);
        // Rectangle (10 × 4) plus two half-discs of radius 2 → 40 + 4π.
        inscribedWithin(Math.abs(ringSignedArea(ring!)), 40 + Math.PI * 4, 1.5, 'capsule');
    });

    it('turns a lone point into a disc', () => {
        const ring = strokeOutlineRing([[5, 5]] as Ring, 3);
        assert.ok(ring);
        inscribedWithin(Math.abs(ringSignedArea(ring!)), Math.PI * 9, 2.5, 'disc');
    });

    it('spends more arc points on a larger radius', () => {
        const small = strokeOutlineRing([[0, 0], [10, 0]] as Ring, 1)!.length;
        const large = strokeOutlineRing([[0, 0], [10, 0]] as Ring, 20)!.length;
        assert.ok(large > small, `${large} should exceed ${small}`);
    });

    it('caps bulge past the ends rather than folding back', () => {
        const ring = strokeOutlineRing([[0, 0], [10, 0]] as Ring, 2)!;
        const maxX = Math.max(...ring.map(p => p[0]));
        const minX = Math.min(...ring.map(p => p[0]));
        assert.ok(maxX > 11.9, `end cap should reach x≈12, got ${maxX}`);
        assert.ok(minX < -1.9, `start cap should reach x≈-2, got ${minX}`);
    });

    it('resolves a hairpin turn into a single sane region', () => {
        // Turning back on itself makes the raw outline self-intersect; the union
        // inside strokeToRegion is what cleans it up.
        const region = strokeToRegion([[0, 0], [10, 0], [0, 0.5]] as Ring, 4);
        assert.ok(region.length >= 1);
        const area = multiPolygonArea(region);
        // Two overlapping capsules — well under twice one capsule's area.
        assert.ok(area > 40 && area < 100, `area was ${area}`);
    });
});

describe('inflateMultiPolygon', () => {
    it('grows a square by the delta on every side, with rounded corners', () => {
        const square = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] as any;
        const out = inflateMultiPolygon(square, 2);
        const area = multiPolygonArea(out);
        // 14×14 minus the four corner squares, plus the quarter-discs: 196 - 16 + 4π.
        const expected = 196 - 16 + Math.PI * 4;
        assert.ok(Math.abs(area - expected) < 2, `area ${area} vs expected ${expected}`);
    });

    it('shrinks a hole while growing the outer ring', () => {
        const withHole = [[
            [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]],
            [[15, 15], [15, 25], [25, 25], [25, 15], [15, 15]]
        ]] as any;
        const before = multiPolygonArea(withHole);
        const out = inflateMultiPolygon(withHole, 2);
        const after = multiPolygonArea(out);
        assert.ok(after > before, 'outer should grow');
        // The hole must have shrunk, not vanished.
        const holeRings = out.flatMap((poly: any) => poly.slice(1));
        assert.ok(holeRings.length > 0, 'hole should survive');
        const holeArea = Math.abs(ringSignedArea(holeRings[0]));
        assert.ok(holeArea < 100 && holeArea > 20, `hole area was ${holeArea}`);
    });

    it('is a no-op for a zero delta', () => {
        const square = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] as any;
        assert.equal(inflateMultiPolygon(square, 0), square);
    });
});

describe('pathToBarrierRegion', () => {
    it('uses the outline directly for a filled path', () => {
        const p: PathData = { ...base, d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', fill: '#000' };
        const parts = pathToBarrierRegion(p, 0.3);
        assert.equal(parts.length, 1);
        assert.ok(Math.abs(multiPolygonArea(parts[0]) - 100) < 0.01);
    });

    it('keeps a filled shape\'s counter as a hole', () => {
        const p: PathData = {
            ...base,
            fill: '#000',
            d: 'M 0 0 L 40 0 L 40 40 L 0 40 Z M 10 10 L 10 30 L 30 30 L 30 10 Z'
        };
        const parts = pathToBarrierRegion(p, 0.3);
        assert.equal(parts.length, 1);
        // 1600 minus the 400 counter.
        assert.ok(Math.abs(multiPolygonArea(parts[0]) - 1200) < 0.01);
    });

    it('outlines a centreline stroke into the region it covers', () => {
        const p: PathData = { ...base, d: 'M 0 0 L 20 0', stroke: '#000', strokeWidth: 4 };
        const parts = pathToBarrierRegion(p, 0.3);
        assert.equal(parts.length, 1);
        const area = multiPolygonArea(parts[0]);
        // 20 × 4 body plus two round caps of radius 2, the caps inscribed.
        const exact = 80 + Math.PI * 4;
        assert.ok(area <= exact + 1e-6 && area > exact - 1.5, `area was ${area}`);
    });

    it('contributes both regions when a path is filled AND stroked', () => {
        const p: PathData = {
            ...base, d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', fill: '#000', stroke: '#000', strokeWidth: 2
        };
        assert.equal(pathToBarrierRegion(p, 0.3).length, 2);
    });
});

describe('vectorBucketFill', () => {
    const canvas = { width: 400, height: 400 };

    it('fills the inside of a closed stroked square', () => {
        const out = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 4)],
            x: 150, y: 150, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, true);
        if (!out.ok) return;
        // A 100-unit square drawn as a 4-wide centreline stroke covers 2 units
        // either side of the line, so the enclosed void is 96 × 96.
        assert.ok(Math.abs(out.stats.area - 9216) < 1, `area was ${out.stats.area}`);
        assert.ok(out.d.startsWith('M '));
        assert.equal(out.stats.engine, 'vector');
    });

    it('reports a leak when the outline has a gap and no gap closing', () => {
        const open: PathData = {
            ...base,
            // Same square, but the last edge stops short — a 12-unit hole.
            d: 'M 100 100 L 200 100 L 200 200 L 100 200 L 100 112',
            stroke: '#000',
            strokeWidth: 4
        };
        const out = vectorBucketFill({
            barriers: [open], x: 150, y: 150, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, false);
        if (out.ok) return;
        assert.equal(out.reason, 'leaked');
    });

    it('closes that same gap when gapClose covers it', () => {
        const open: PathData = {
            ...base,
            d: 'M 100 100 L 200 100 L 200 200 L 100 200 L 100 112',
            stroke: '#000',
            strokeWidth: 4
        };
        const out = vectorBucketFill({
            barriers: [open], x: 150, y: 150, ...canvas,
            options: { gapClose: 10, expand: 0 }
        });
        assert.equal(out.ok, true, out.ok ? '' : (out as any).message);
        if (!out.ok) return;
        assert.ok(out.stats.area > 8000, `area was ${out.stats.area}`);
        assert.ok(out.stats.area < 11000, `area was ${out.stats.area}`);
    });

    it('cuts an island stroke out of the filled region', () => {
        const island: PathData = {
            ...base, d: 'M 140 140 L 160 140 L 160 160 L 140 160 Z', fill: '#000'
        };
        const out = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 4), island],
            x: 120, y: 120, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, true);
        if (!out.ok) return;
        // The 20×20 island must be missing from the 96×96 interior.
        assert.ok(Math.abs(out.stats.area - (9216 - 400)) < 1, `area was ${out.stats.area}`);
        assert.ok(out.stats.ringCount >= 2, 'island should appear as a hole');
    });

    it('refuses when the seed is on ink', () => {
        const out = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 10)],
            x: 100, y: 150, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, false);
        if (out.ok) return;
        assert.equal(out.reason, 'on-ink');
    });

    it('expands the region so the fill tucks under the stroke', () => {
        const tight = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 4)], x: 150, y: 150, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        const tucked = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 4)], x: 150, y: 150, ...canvas,
            options: { gapClose: 0, expand: 2 }
        });
        assert.equal(tight.ok && tucked.ok, true);
        if (!tight.ok || !tucked.ok) return;
        assert.ok(tucked.stats.area > tight.stats.area, 'expanded fill should be larger');
        // The stroke spans x = 98..102; untucked the fill starts at 102, and
        // expanding by 2 should carry it to the centreline without spilling out
        // the far side.
        assert.ok(Math.abs(tight.box.minX - 102) < 0.01, `untucked minX was ${tight.box.minX}`);
        assert.ok(
            tucked.box.minX < 100.01 && tucked.box.minX > 98,
            `tucked minX was ${tucked.box.minX}`
        );
    });

    it('finds the region without unioning the whole canvas', () => {
        // A far-away stroke that the expanding window should never need to load.
        const distant: PathData = { ...base, d: 'M 5 380 L 380 385', stroke: '#000', strokeWidth: 3 };
        const out = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 60, 4), distant],
            x: 130, y: 130, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, true);
        if (!out.ok) return;
        assert.equal(out.stats.barrierCount, 1, 'only the enclosing square should be loaded');
    });

    it('emits winding that fills correctly under nonzero', () => {
        const island: PathData = {
            ...base, d: 'M 140 140 L 160 140 L 160 160 L 140 160 Z', fill: '#000'
        };
        const out = vectorBucketFill({
            barriers: [strokedSquare(100, 100, 100, 4), island],
            x: 120, y: 120, ...canvas,
            options: { gapClose: 0, expand: 0 }
        });
        assert.equal(out.ok, true);
        if (!out.ok) return;
        assert.equal(out.region.length, 1);
        assert.ok(ringSignedArea(out.region[0][0]) > 0, 'outer ring positive');
        for (let i = 1; i < out.region[0].length; i++) {
            assert.ok(ringSignedArea(out.region[0][i]) < 0, `hole ${i} should be negative`);
        }
    });
});

describe('snapMultiPolygon', () => {
    it('rounds coordinates onto the grid', () => {
        const mp = [[[[0.04, 1.06], [10.111, 0], [10, 10], [0, 10], [0.04, 1.06]]]] as any;
        const out = snapMultiPolygon(mp, 0.1);
        assert.deepEqual(out[0][0][0], [0, 1.1]);
        assert.deepEqual(out[0][0][1], [10.1, 0]);
    });

    it('moves nothing by more than half a grid step', () => {
        const mp = [[[[1.234567, 9.87654], [20.5, 3.14159], [7, 7], [1.234567, 9.87654]]]] as any;
        const out = snapMultiPolygon(mp, 0.1);
        for (let i = 0; i < mp[0][0].length; i++) {
            assert.ok(Math.abs(out[0][0][i][0] - mp[0][0][i][0]) <= 0.05 + 1e-9);
            assert.ok(Math.abs(out[0][0][i][1] - mp[0][0][i][1]) <= 0.05 + 1e-9);
        }
    });
});

describe('safeUnionBarriers', () => {
    it('unions well-behaved input with nothing dropped', () => {
        const a = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] as any;
        const b = [[[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]]] as any;
        const out = safeUnionBarriers([a, b]);
        assert.ok(out);
        assert.equal(out!.dropped, 0);
        assert.equal(out!.approximated, 0);
        // Two 100-unit squares overlapping in a 5×5 corner.
        assert.ok(Math.abs(multiPolygonArea(out!.geometry) - 175) < 0.01);
    });

    it('returns null for no input', () => {
        assert.equal(safeUnionBarriers([]), null);
    });

    it('keeps every disjoint region', () => {
        const parts = [];
        for (let i = 0; i < 60; i++) {
            const x = i * 20;
            parts.push([[[[x, 0], [x + 10, 0], [x + 10, 10], [x, 10], [x, 0]]]] as any);
        }
        const out = safeUnionBarriers(parts);
        assert.ok(out);
        assert.equal(out!.dropped, 0);
        assert.equal(out!.geometry.length, 60);
        assert.ok(Math.abs(multiPolygonArea(out!.geometry) - 6000) < 0.01);
    });

    it('substitutes a bounding box rather than losing an unprocessable region', () => {
        // The substitute must be a SUPERSET of the region it replaces — that is
        // what makes the degradation safe, because a larger barrier can only
        // shrink the fill, never let it escape.
        const jagged = [[[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]]] as any;
        const out = safeUnionBarriers([jagged]);
        assert.ok(out);
        const area = multiPolygonArea(out!.geometry);
        if (out!.approximated > 0) {
            // Replaced: must cover the full 10×10 box.
            assert.ok(Math.abs(area - 100) < 0.01, `bbox substitute area was ${area}`);
        } else {
            // Processed normally: the L-shape's own 64 units.
            assert.ok(Math.abs(area - 64) < 0.01, `area was ${area}`);
        }
    });
});

describe('findEnclosingHole', () => {
    it('picks the hole the point is actually inside', () => {
        const mp = [[
            [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
            [[10, 10], [10, 30], [30, 30], [30, 10], [10, 10]],
            [[60, 60], [60, 90], [90, 90], [90, 60], [60, 60]]
        ]] as any;
        const hole = findEnclosingHole(mp, 70, 70);
        assert.ok(hole);
        assert.ok(pointInRing(70, 70, hole!));
        assert.ok(!pointInRing(20, 20, hole!));
    });

    it('returns null on ink', () => {
        const mp = [[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]] as any;
        assert.equal(findEnclosingHole(mp, 50, 50), null);
    });
});
