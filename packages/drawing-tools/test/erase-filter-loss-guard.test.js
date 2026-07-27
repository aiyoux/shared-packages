// @ts-nocheck
// Requires --experimental-test-module-mocks (see package.json's "test" script).
// Regression test for the filter-introduced survivor loss bug: polygon-clipping
// emits a valid disconnected survivor, but the per-piece filter loop
// (polygonIsValidResult) incorrectly discards it. The omitted-survivor
// safeguard must now catch this because it checks the post-filter keptPolygons
// instead of the raw polygon-clipping output.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath } from '../src/path.ts';

// Point-in-path over the emitted M/L/Z outline (evenodd is fine for probing).
const pathContains = (d, px, py) => {
    const rings = [];
    let cur = [];
    for (const c of parsePath(d)) {
        const t = c.type.toUpperCase();
        if (t === 'M') { if (cur.length > 2) rings.push(cur); cur = [[c.args[0], c.args[1]]]; }
        else if (t === 'L') cur.push([c.args[0], c.args[1]]);
        else if (t === 'Z') { if (cur.length > 2) rings.push(cur); cur = []; }
    }
    if (cur.length > 2) rings.push(cur);
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi || 1e-9) + xi)) inside = !inside;
        }
    }
    return inside;
};

test('a valid disconnected survivor discarded by the per-piece filter is caught, not silently lost', async () => {
    // Simulates the filter-introduced loss scenario: polygon-clipping's
    // difference() returns two pieces — a small valid near-eraser piece and a
    // large corrupted polygon covering the far region. The large polygon
    // passes polygonWithinSubject (overlaps subject bounds) but fails
    // polygonIsValidResult's eraser-containment check (an eraser centerline
    // point lands inside its solid, because the polygon is so large it spans
    // from the near region to the far region). The safeguard must detect that
    // the far subject region is absent from the kept pieces and bail,
    // preserving the original path.
    //
    // Before the fix: subjectHasOmittedSurvivor checked raw `polygons` — the
    // large polygon was present there, so the far subject vertex appeared
    // "not omitted" → the near piece was returned alone → far region lost.
    //
    // After the fix: subjectHasOmittedSurvivor checks keptPolygons — the
    // large polygon was filtered out → far subject vertex is absent → bail →
    // original path preserved.

    const real = await import('polygon-clipping');
    mock.module('polygon-clipping', {
        exports: {
            default: {
                ...real.default,
                difference: () => {
                    // Return two polygons:
                    // 1. A valid small near-eraser piece (left edge of near square)
                    //    — will pass all filters and be kept.
                    // 2. A huge polygon spanning (0,0)-(600,600) — covers the far
                    //    region but ALSO contains the eraser point (50,50) in its
                    //    solid, so polygonIsValidResult's eraser-containment check
                    //    rejects it. This simulates a polygon-clipping boundary
                    //    reshuffle on a self-overlapping freehand stroke where the
                    //    output polygon's geometry encloses eraser waypoints.
                    return [
                        // Near piece: left strip of the near square, untouched by
                        // eraser at (50,50) r=20. Vertices inside subject poly 1.
                        [[[0, 0], [25, 0], [25, 100], [0, 100], [0, 0]]],
                        // Corrupt far piece: huge polygon spanning everything.
                        // Contains eraser point (50,50) → fails eraser-containment.
                        // But also contains far subject vertex (550,550) → raw
                        // safeguard would see it as "not omitted."
                        [[[0, 0], [600, 0], [600, 600], [0, 600], [0, 0]]]
                    ];
                }
            }
        }
    });

    const { splitPathsByEraser } = await import('../src/eraser.ts?mockedDifference=filterLoss');

    const near = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    const far = 'M 500 500 L 600 500 L 600 600 L 500 600 Z';
    const path = { d: `${near} ${far}`, fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };

    // Eraser only ever touches the near square.
    const out = splitPathsByEraser([path], [{ x: 50, y: 50 }], 20, () => false);

    assert.ok(
        out.some(o => pathContains(o.d, 550, 550)),
        'the untouched far region vanished — a filter-discarded survivor was not caught by the post-filter safeguard'
    );
});
