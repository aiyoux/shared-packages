// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPathsByEraser, sourceStrokeToD, getLastClipDiag } from '../src/eraser.ts';
import { parsePath } from '../src/path.ts';

// Regression: thin "spaghetti" freehand strokes under a thick stroke must erase
// on the FIRST pass. The spuriousFar guard used a radius-scaled "tiny" area
// threshold, so under a wide eraser BOTH legit halves of a thin stroke counted
// as tiny artifacts, the all-artifacts bail kept the stroke whole, and the thin
// lines only erased on a later pass.

const freehand = (points, size) => {
    const source = {
        points: points.map(([x, y]) => [x, y, 0.5]),
        options: { size, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false }
    };
    return { d: sourceStrokeToD(source), stroke: 'none', fill: '#000', strokeWidth: 0, freehandSource: source };
};

const wavy = (yBase, amp, phase, n = 60) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const x = i * (200 / n);
        pts.push([x, yBase + amp * Math.sin(x / 18 + phase)]);
    }
    return pts;
};

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

const eraser = [{ x: 100, y: 30 }, { x: 100, y: 170 }];
const radius = 20; // wide eraser (store: strokeWidth*4/2)

test('thin strokes under a thick stroke erase on the first pass', () => {
    const paths = [
        freehand(wavy(90, 12, 0), 3),
        freehand(wavy(100, 10, 1.4), 3),
        freehand(wavy(110, 14, 2.8), 3),
        freehand([[0, 100], [50, 100], [100, 100], [150, 100], [200, 100]], 24)
    ];
    const probes = [
        [100, 90 + 12 * Math.sin(100 / 18 + 0)],
        [100, 100 + 10 * Math.sin(100 / 18 + 1.4)],
        [100, 110 + 14 * Math.sin(100 / 18 + 2.8)],
        [100, 100]
    ];

    const out = splitPathsByEraser(paths, eraser, radius, () => false);

    for (let i = 0; i < paths.length; i++) {
        const [px, py] = probes[i];
        assert.ok(
            !out.some(o => pathContains(o.d, px, py)),
            `stroke ${i} still has ink at the eraser crossing (${px.toFixed(0)},${py.toFixed(0)}) after one pass`
        );
        assert.ok(
            !out.some(o => o.d === paths[i].d),
            `stroke ${i} was carried through unchanged (bailed out of the erase)`
        );
    }
});

test('split pieces are marked clipDerived so later erases keep the freehand guards', () => {
    const thick = freehand([[0, 100], [50, 100], [100, 100], [150, 100], [200, 100]], 24);
    const out = splitPathsByEraser([thick], eraser, radius, () => false);
    assert.ok(out.length >= 2, 'expected the stroke to split into pieces');
    for (const piece of out) {
        assert.equal(piece.clipDerived, true, 'piece should carry clipDerived');
        assert.equal(piece.freehandSource, undefined, 'piece should not carry freehandSource');
    }
});

test('repeated passes over already-split pieces never increase total ink area', () => {
    // Re-erasing pieces (freehandSource stripped) previously ran WITHOUT the
    // freehand artifact guards, so a corrupted polygon-clipping difference
    // (dropped holes) could emit a spurious solid — ink area growing after an
    // erase. clipDerived keeps the guards on for pieces; this walks a dense
    // self-overlapping scribble with many crossing passes and asserts the
    // invariant that erasing can only remove ink.
    const scribble = [];
    for (let i = 0; i <= 240; i++) {
        const t = i / 240;
        const x = 100 + 90 * Math.cos(t * Math.PI * 10) * (1 - t * 0.5);
        const y = 100 + 80 * Math.sin(t * Math.PI * 14) * (1 - t * 0.3);
        scribble.push([x, y]);
    }
    let paths = [
        freehand(scribble, 3),
        freehand([[20, 100], [100, 95], [180, 105]], 30)
    ];

    const inkArea = (ps) => {
        let total = 0;
        for (const p of ps) {
            const rings = [];
            let cur = [];
            for (const c of parsePath(p.d)) {
                const t = c.type.toUpperCase();
                if (t === 'M') { if (cur.length > 2) rings.push(cur); cur = [[c.args[0], c.args[1]]]; }
                else if (t === 'L') cur.push([c.args[0], c.args[1]]);
                else if (t === 'Z') { if (cur.length > 2) rings.push(cur); cur = []; }
            }
            if (cur.length > 2) rings.push(cur);
            // signed sum: holes (opposite winding) subtract
            for (const ring of rings) {
                let a = 0;
                for (let j = 0; j < ring.length; j++) {
                    const [x1, y1] = ring[j];
                    const [x2, y2] = ring[(j + 1) % ring.length];
                    a += x1 * y2 - x2 * y1;
                }
                total += a / 2;
            }
        }
        return Math.abs(total);
    };

    const passes = [
        [{ x: 60, y: 20 }, { x: 70, y: 180 }],
        [{ x: 20, y: 90 }, { x: 180, y: 110 }],
        [{ x: 140, y: 20 }, { x: 130, y: 180 }],
        [{ x: 20, y: 140 }, { x: 180, y: 60 }],
        [{ x: 100, y: 20 }, { x: 100, y: 180 }]
    ];
    let prevArea = inkArea(paths);
    for (const [from, to] of passes) {
        // Each pass is itself split into several sub-calls to splitPathsByEraser
        // (rather than one call per pass) purely to stress the primitive with
        // more, smaller passes over the same already-split pieces.
        const step = Math.max(2, radius / 3);
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        let last = from;
        for (let d = step; d <= dist; d += step) {
            const t = d / dist;
            const pt = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
            paths = splitPathsByEraser(paths, [last, pt], radius, () => false);
            last = pt;
        }
        const area = inkArea(paths);
        assert.ok(
            area <= prevArea * 1.02 + 1,
            `ink area grew after an erase pass: ${Math.round(prevArea)} -> ${Math.round(area)}`
        );
        prevArea = area;
    }
});

test('a single full-fidelity pass over a dense scribble leaves no un-erased bits', () => {
    // Mirrors the new store design: one erasePathsWithPoints call per drag,
    // fed the COMPLETE trail (every interpolated pointer sample, no decimation,
    // no incremental multi-move fragmentation). A fast swipe is exactly this —
    // many trail points collapsed into one splitPathsByEraser call — so this is
    // the regression test for "erasing fast leaves bits behind".
    const scribble = [];
    for (let i = 0; i <= 240; i++) {
        const t = i / 240;
        const x = 100 + 90 * Math.cos(t * Math.PI * 10) * (1 - t * 0.5);
        const y = 100 + 80 * Math.sin(t * Math.PI * 14) * (1 - t * 0.3);
        scribble.push([x, y]);
    }
    const paths = [
        freehand(scribble, 3),
        freehand([[20, 100], [100, 95], [180, 105]], 30)
    ];

    // A dense, full-fidelity trail (many samples — no decimation) crossing the
    // whole scribble in one continuous fast swipe.
    const trail = [];
    for (let x = 0; x <= 200; x += 2) trail.push({ x, y: 100 + 10 * Math.sin(x / 12) });

    const out = splitPathsByEraser(paths, trail, 20, () => false);

    let remnants = 0;
    for (let x = 10; x <= 190; x += 4) {
        const y = 100 + 10 * Math.sin(x / 12);
        if (out.some(o => pathContains(o.d, x, y))) remnants++;
    }
    assert.equal(remnants, 0, `${remnants} probe points along the swept trail still have ink after one pass`);
});

test('a piece erased down to a negligible remainder is dropped, not reverted to full size', () => {
    // Regression for "erasing over an already-erased area makes lines reappear":
    // a clipDerived piece whose eraser sweep doesn't touch literally every
    // vertex (eraserCoversSubject false — here the far tip sticks out past the
    // capsule) but whose difference legitimately empties it down to a
    // sub-threshold remainder (which cleanupTinyRemnants correctly discards)
    // was being reverted to its FULL pristine size instead of erased. That
    // piece would sit there, invisible only because other (now-removed) ink
    // was drawn over it — "reappearing" once that ink got erased away later.
    const sliver = { d: 'M 0 0 L 2 0 L 2 60 L 0 60 Z', fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };
    const out = splitPathsByEraser([sliver], [{ x: 1, y: 5 }, { x: 1, y: 50 }], 8, () => false);
    const diag = getLastClipDiag();
    assert.equal(out.length, 0, `expected the near-fully-erased sliver to be dropped, got ${out.length} piece(s)`);
    assert.equal(diag?.bailReason, 'negligibleResult', `expected the negligibleResult path, got ${diag?.bailReason}`);
});

test('a real ~35-40% surviving remainder is kept, not treated as dust or reverted', () => {
    // Exact signature from a live repro: a 2x50 sliver (subjectArea ~100),
    // eraser touches only its top ~60% (y:5-6, radius 24 reaches roughly
    // y:-19..30), legitimately leaving the untouched tail (y:30-50, ~40px²) —
    // a REAL surviving fragment, not a crumb. It was previously misclassified
    // two different ways in two different bugs:
    //   - polygonIsTinyEraserRemnant used an absolute r²·0.08 "tiny" threshold
    //     with no relation to how big the subject was, so ~40px² (well over a
    //     third of this 100px² subject) still counted as trimmable dust and
    //     got discarded outright — this test's OWN earlier version asserted
    //     that as the "fix", which was itself wrong: capping the threshold at
    //     subjectArea·0.25 (matching polygonIsSpuriousFarPiece) means an area
    //     this large relative to its subject is no longer "tiny" at all.
    //   - separately, an empty result from that wrong discard could ALSO get
    //     reverted to the pristine FULL 100px² size instead of erasing —
    //     "lines reappear when erasing over an already-erased region".
    // Correct behavior is neither "drop it" nor "revert to full size": the
    // real ~35-40px² remainder must survive as its own piece.
    const sliver = { d: 'M 0 0 L 2 0 L 2 50 L 0 50 Z', fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };
    const out = splitPathsByEraser([sliver], [{ x: 1, y: 5 }, { x: 1, y: 6 }], 24, () => false);
    const diag = getLastClipDiag();
    assert.equal(out.length, 1,
        `expected the real surviving tail to be kept as its own piece, got ${out.length} piece(s) (bail=${diag?.bailReason})`);
    assert.ok(pathContains(out[0].d, 1, 45), 'the untouched tail (y≈45) should be part of the surviving piece');
    assert.ok(!pathContains(out[0].d, 1, 10), 'the touched region (y≈10) should not still have ink');
});

test('a thin line cut by a WIDE eraser keeps the remainders that reach past the footprint', () => {
    // Real repro (recovered from saved before/after production data by fitting
    // the actual eraser trail, IoU 0.93): a thin clipDerived line (area ~412)
    // cut by a wide eraser (radius 22) left three surviving remainders of only
    // ~27-39px² that reached ~33-36px from the trail — clearly OUTSIDE the 22px
    // eraser footprint, so unmistakably real un-erased ink — yet they were
    // discarded as "tinyRemnant" dust and vanished ("some lines get eaten").
    //
    // The cause: polygonIsTinyEraserRemnant's area cap scales with eraser
    // RADIUS (r²·0.08 ≈ 39 for r=22), so a thin line's genuine remainders fall
    // under it, and its old "≥50% of vertices near the eraser" check trips for
    // any thin sliver whose cut end (the difference's eraser-following arc)
    // hugs the eraser. The fix keys off how far the piece REACHES past the
    // footprint instead: dust lies entirely within it; a real remainder pokes
    // out.
    const thinLine = { d: 'M 10 49 L 90 49 L 90 51 L 10 51 Z', fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };
    // Wide vertical eraser through the middle (x≈50), radius 24 → removes the
    // x:26-74 band, leaving thin remainders x:10-26 and x:74-90 (~32px² each)
    // whose far ends (x=10, x=90) sit ~40px from the trail, well past the 24px
    // footprint.
    const out = splitPathsByEraser([thinLine], [{ x: 50, y: 10 }, { x: 50, y: 90 }], 24, () => false);

    assert.ok(out.some(o => pathContains(o.d, 13, 50)), 'the left remainder (x≈13, past the footprint) was eaten as dust');
    assert.ok(out.some(o => pathContains(o.d, 87, 50)), 'the right remainder (x≈87, past the footprint) was eaten as dust');
    assert.ok(!out.some(o => pathContains(o.d, 50, 50)), 'the erased middle band still has ink');
});

test('both halves of a cleanly-cut stroke survive (no silent half-loss)', () => {
    // One straight thick stroke, one eraser pass through the middle. The
    // vertex-inside-subject quorum in polygonIsValidResult used a strict
    // point-in-polygon test on boundary-exact vertices, which could reject a
    // REAL half of the stroke as an artifact — half the line silently vanished.
    const thick = freehand([[0, 100], [50, 100], [100, 100], [150, 100], [200, 100]], 24);
    const out = splitPathsByEraser([thick], eraser, radius, () => false);

    assert.ok(out.some(o => pathContains(o.d, 30, 100)), 'left half of the stroke was lost');
    assert.ok(out.some(o => pathContains(o.d, 170, 100)), 'right half of the stroke was lost');
    assert.ok(!out.some(o => pathContains(o.d, 100, 100)), 'the erased middle still has ink');
});

test('a disconnected separate mark within the same stroke survives erasing elsewhere', () => {
    // Real repro: "tiny bits getting removed even though the eraser never
    // touched it, near where I just erased". A single PathData's `d` can
    // legitimately contain multiple disconnected solid rings (a self-crossing
    // scribble with a separated loop, or any multi-subpath freehand/
    // clipDerived stroke) — NOT nested holes, genuinely separate ink.
    //
    // flatPathToFillGeometry's "authoritative reconstruction" used to call
    // `union(rings)` — passing the whole Ring[] as ONE argument, which
    // polygon-clipping happily accepts with the WRONG interpretation:
    // rings[0] becomes the sole outer and every other ring becomes a "hole" of
    // it. A hole that doesn't spatially overlap its outer is a no-op, so the
    // second ring's entire area silently vanished from the SUBJECT — before
    // the eraser was even considered.
    const bigBlob = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    const separateDot = 'M 295 295 L 305 295 L 305 305 L 295 305 Z';
    const path = { d: `${bigBlob} ${separateDot}`, fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };

    // Eraser only touches the big blob, nowhere near the separate dot.
    const out = splitPathsByEraser([path], [{ x: 50, y: -20 }, { x: 50, y: 120 }], 24, () => false);

    assert.ok(out.some(o => pathContains(o.d, 300, 300)), 'the untouched separate mark was lost');
    assert.ok(out.some(o => pathContains(o.d, 10, 50)), 'left remainder of the touched blob was lost');
    assert.ok(out.some(o => pathContains(o.d, 90, 50)), 'right remainder of the touched blob was lost');
    assert.ok(!out.some(o => pathContains(o.d, 50, 50)), 'the erased middle of the blob still has ink');
});

test('a real nested hole in a self-crossing outline is preserved through the same reconstruction', () => {
    // Companion to the test above: the SAME reconstruction must still keep a
    // TRUE nested hole (a real gap the ink wraps around) empty — treating
    // every ring as an independent solid (the naive fix for the bug above)
    // unions a nested hole INTO its outer, filling the gap in solid.
    const outerSquare = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    // Opposite winding, nested inside the outer — a real hole.
    const innerHole = 'M 40 40 L 40 60 L 60 60 L 60 40 Z';
    const path = { d: `${outerSquare} ${innerHole}`, fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };

    // Erase a notch on the far side from the hole.
    const out = splitPathsByEraser([path], [{ x: 5, y: 5 }, { x: 5, y: 5 }], 3, () => false);

    assert.ok(!out.some(o => pathContains(o.d, 50, 50)), 'the real hole got filled in solid');
    assert.ok(out.some(o => pathContains(o.d, 80, 80)), 'the rest of the outer square was lost');
});

test('erasing the middle of a thin line with a sharp far corner is NOT reverted by the omitted-survivor guard', () => {
    // Real repro (path 9a904e85 from saved production data): a thin clipDerived
    // line with a SHARP far-left corner, cut through the middle by a wide
    // vertical eraser. The subjectHasOmittedSurvivor safeguard — which reverts
    // the whole erase when a far subject region looks absent from the kept
    // pieces — FALSE-POSITIVED here: the far corner (696.6,220.1) is preserved
    // and sits exactly ON the result boundary, but at a narrow convex angle all
    // nine of the guard's fill-jitter samples land on/outside the two edges, so
    // the corner read as "omitted" and the eraser reverted the cut entirely —
    // an UNDER-erase (the eraser visibly passes through the line, yet the line
    // stays whole). The fix also accepts a vertex lying ON a kept edge.
    const thinLine = {
        d: 'M 696.6 220.1 L 734.3 221.2 L 800.7 223.0 L 839.7 223.7 L 838.1 226.4 ' +
           'L 800.6 225.7 L 734.3 223.8 L 701.8 222.9 L 701.4 222.7 L 701.2 222.5 ' +
           'L 699.8 221.7 L 698.5 220.9 L 698.2 220.8 L 697.9 220.6 Z',
        fill: '#000000', stroke: 'none', strokeWidth: 0, clipDerived: true
    };
    // Wide vertical eraser (radius 24) down the middle of the line (x≈772).
    const trail = [];
    for (let k = 0; k <= 12; k++) { const t = k / 12; trail.push({ x: 779 + (760 - 779) * t, y: 140 + (430 - 140) * t }); }
    const out = splitPathsByEraser([thinLine], trail, 24, () => false);

    // The line must actually be CUT, not carried through whole.
    assert.ok(!out.some(o => o.d === thinLine.d), 'the erase was reverted — the thin line was kept whole (under-erase)');
    assert.ok(!out.some(o => pathContains(o.d, 772, 223)), 'the eraser passed through x≈772 but ink remains there');
    // Both far ends (including the sharp far-left corner) must survive.
    assert.ok(out.some(o => pathContains(o.d, 710, 222)), 'the far-left remainder (sharp corner) was lost');
    assert.ok(out.some(o => pathContains(o.d, 820, 225)), 'the far-right remainder was lost');
});
