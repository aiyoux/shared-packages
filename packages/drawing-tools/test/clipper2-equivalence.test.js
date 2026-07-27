// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import Clipper2Factory from 'clipper2-wasm/dist/umd/clipper2z.js';
import { splitPathsByEraser } from '../src/eraser.ts';
import {
    setClipper2Module, setClipper2Enabled, isClipper2Active,
    clipFallbacks, clipStats, resetClipStats, union, difference
} from '../src/clipping.ts';

// Clipper2 (wasm) must be a drop-in for polygon-clipping (Martinez) in the erase
// pipeline. Two things went wrong when this was first written and BOTH produced
// a passing-looking result, so they are pinned here:
//
//  1. Every wasm call threw and the adapter silently fell back to Martinez, so
//     an "identical output" check was really comparing Martinez to itself.
//  2. `PathD.view()` returns x,y,Z TRIPLES (this package builds Clipper2 with
//     the optional Z coordinate). Reading it with stride 2 interleaves z into
//     the coordinates and yields garbage.
//
// Hence: assert the fast path actually executed (0 fallbacks, >0 clip calls)
// BEFORE trusting any equivalence assertion.

const mod = await Clipper2Factory();

test('clipper2 adapter: fast path executes and does not silently fall back', () => {
    setClipper2Module(mod, 6);
    setClipper2Enabled(true);
    assert.equal(isClipper2Active(), true, 'clipper2 should be active once the module is injected');

    resetClipStats();
    const before = clipFallbacks.count;
    const square = [[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]];
    const hole = [[[[25, 25], [75, 25], [75, 75], [25, 75], [25, 25]]]];
    const res = difference(square, hole);

    assert.equal(clipFallbacks.count, before, `clipper2 fell back to Martinez: ${clipFallbacks.lastError}`);
    assert.ok(clipStats.calls > 0, 'no clip calls were recorded — the wasm path did not run');
    // A square minus a centred square is one polygon with one hole.
    assert.equal(res.length, 1, 'expected exactly one output polygon');
    assert.equal(res[0].length, 2, 'expected an outer ring plus one hole');
});

test('clipper2 adapter: PathD.view() is x,y,z triples (stride 3)', () => {
    // Assert the CONTRACT directly. A bbox check is not enough: reading a square
    // with stride 2 happens to yield the same bbox, so it passes while the
    // geometry is scrambled. This pins the actual invariant the reader relies on.
    const p = mod.MakePathD([1, 2, 3, 4, 5, 6]);
    assert.equal(p.size(), 3, 'three points went in');
    assert.equal(p.view().length, p.size() * 3, 'view() must be 3 values per point (x,y,z)');
    assert.deepEqual(Array.from(p.view()), [1, 2, 0, 3, 4, 0, 5, 6, 0]);
});

test('clipper2 adapter: rings come back as the exact input vertices', () => {
    setClipper2Module(mod, 6);
    setClipper2Enabled(true);
    const square = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]];
    const ring = union(square)[0][0];
    // Compare as a set of vertices, so ring start-point/orientation is free but
    // a stride misread (which invents points like [0,10]→[0,0]) is caught.
    const got = ring.slice(0, -1).map(([x, y]) => `${x},${y}`).sort();
    assert.deepEqual(got, ['0,0', '0,10', '10,0', '10,10']);
    assert.deepEqual(ring[0], ring[ring.length - 1], 'ring must be explicitly closed');
});

test('clipper2 matches martinez on a real erase pass (filled area within 0.01%)', () => {
    const before = [
        { id: 'a', d: 'M 20 100 L 300 100 L 300 130 L 20 130 Z', fill: '#000', freehandSource: null },
        { id: 'b', d: 'M 50 40 L 70 40 L 70 260 L 50 260 Z', fill: '#000', freehandSource: null }
    ];
    const trail = [];
    for (let i = 0; i <= 60; i++) trail.push({ x: 40 + i * 4, y: 90 + Math.sin(i / 6) * 45 });
    const radius = 18;

    setClipper2Module(mod, 6);

    setClipper2Enabled(false);
    const mart = splitPathsByEraser(before, trail, radius, () => false, undefined);

    setClipper2Enabled(true);
    resetClipStats();
    const fb = clipFallbacks.count;
    const c2 = splitPathsByEraser(before, trail, radius, () => false, undefined);

    assert.equal(clipFallbacks.count, fb, `clipper2 fell back: ${clipFallbacks.lastError}`);
    assert.ok(clipStats.calls > 0, 'clipper2 path did not run — equivalence check would be vacuous');

    // Compare total filled area of the emitted pieces (engine-independent, and
    // insensitive to harmless differences in ring start point or ordering).
    const ringArea = (r) => {
        let a = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
        return Math.abs(a / 2);
    };
    const areaOf = (paths) => {
        let total = 0;
        for (const p of paths) {
            let cur = [];
            const re = /([ML])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)|Z/gi;
            let m;
            while ((m = re.exec(p.d))) {
                if (m[0][0].toUpperCase() === 'Z') { if (cur.length > 2) total += ringArea(cur); cur = []; continue; }
                if (m[1].toUpperCase() === 'M') { if (cur.length > 2) total += ringArea(cur); cur = []; }
                cur.push([+m[2], +m[3]]);
            }
            if (cur.length > 2) total += ringArea(cur);
        }
        return total;
    };

    const aM = areaOf(mart), aC = areaOf(c2);
    assert.ok(aM > 0, 'martinez produced no filled area — the fixture did not erase anything');
    const diff = Math.abs(aC - aM) / aM;
    assert.ok(diff < 0.0001, `filled area diverged by ${(diff * 100).toFixed(4)}% (martinez ${aM.toFixed(2)}, clipper2 ${aC.toFixed(2)})`);

    // Leave the module in the default state for any later test file.
    setClipper2Enabled(true);
});
