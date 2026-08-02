import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dilateMask, floodRegion, traceRegionRings, maskRingToCanvas } from '../src/bucketRaster.ts';
import { ringSignedArea, ringsToMultiPolygon, simplifyRing, multiPolygonToPathD } from '../src/rings.ts';
import type { Ring } from 'polygon-clipping';

/** Build a mask from an ASCII picture. '#' is a barrier, anything else is open.
 *  Rows must all be the same length. */
function mask(rows: string[]): { data: Uint8Array; width: number; height: number } {
    const width = rows[0].length;
    const height = rows.length;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        assert.equal(rows[y].length, width, `row ${y} has the wrong length`);
        for (let x = 0; x < width; x++) {
            if (rows[y][x] === '#') data[y * width + x] = 1;
        }
    }
    return { data, width, height };
}

function render(region: Uint8Array, width: number, height: number): string[] {
    const out: string[] = [];
    for (let y = 0; y < height; y++) {
        let row = '';
        for (let x = 0; x < width; x++) row += region[y * width + x] ? '*' : '.';
        out.push(row);
    }
    return out;
}

describe('floodRegion', () => {
    it('fills the inside of a closed box and stops at the wall', () => {
        const m = mask([
            '#######',
            '#.....#',
            '#..#..#',
            '#.....#',
            '#######'
        ]);
        const r = floodRegion(m.data, m.width, m.height, 1, 1, 1e6);
        assert.equal(r.aborted, false);
        // 15 interior cells minus the one island stroke.
        assert.equal(r.count, 14);
        assert.deepEqual(render(r.region, m.width, m.height), [
            '.......',
            '.*****.',
            '.**.**.',
            '.*****.',
            '.......'
        ]);
    });

    it('escapes through a one-pixel gap', () => {
        const m = mask([
            '#######',
            '#.....#',
            '#.....#',
            '###.###',
            '.......'
        ]);
        const r = floodRegion(m.data, m.width, m.height, 1, 1, 1e6);
        // Interior (10) + the gap (1) + the whole open row below (7).
        assert.equal(r.count, 18);
    });

    it('reports abort rather than filling past the pixel budget', () => {
        const m = mask([
            '.......',
            '.......',
            '.......'
        ]);
        const r = floodRegion(m.data, m.width, m.height, 3, 1, 5);
        assert.equal(r.aborted, true);
    });

    it('returns nothing when the seed is on a barrier', () => {
        const m = mask(['###', '###']);
        const r = floodRegion(m.data, m.width, m.height, 1, 1, 1e6);
        assert.equal(r.count, 0);
    });
});

describe('dilateMask', () => {
    it('grows a single pixel into its 4-neighbourhood on the first pass', () => {
        const m = mask([
            '.....',
            '.....',
            '..#..',
            '.....',
            '.....'
        ]);
        const out = dilateMask(m.data, m.width, m.height, 1);
        assert.deepEqual(render(out, m.width, m.height), [
            '.....',
            '..*..',
            '.***.',
            '..*..',
            '.....'
        ]);
    });

    it('leaves the input mask untouched', () => {
        const m = mask(['.....', '..#..', '.....']);
        const before = Array.from(m.data);
        dilateMask(m.data, m.width, m.height, 2);
        assert.deepEqual(Array.from(m.data), before);
    });

    it('closes a one-pixel gap in a wall', () => {
        const m = mask([
            '#######',
            '#.....#',
            '#.....#',
            '###.###',
            '.......'
        ]);
        const closed = dilateMask(m.data, m.width, m.height, 1);
        const r = floodRegion(closed, m.width, m.height, 3, 2, 1e6);
        // With the gap bridged the flood can no longer reach the bottom row.
        assert.equal(r.aborted, false);
        for (let x = 0; x < m.width; x++) {
            assert.equal(r.region[4 * m.width + x], 0, `bottom row pixel ${x} leaked`);
        }
    });
});

describe('traceRegionRings', () => {
    it('traces a single square as one ring with the outer winding', () => {
        const m = mask(['...', '.#.', '...']);
        const rings = traceRegionRings(m.data, m.width, m.height);
        assert.equal(rings.length, 1);
        // 4 corners plus the repeated closing point.
        assert.equal(rings[0].length, 5);
        assert.ok(ringSignedArea(rings[0]) > 0, 'outer ring should have positive area');
    });

    it('emits a hole ring wound opposite the outer', () => {
        const m = mask([
            '#####',
            '#####',
            '##.##',
            '#####',
            '#####'
        ]);
        const rings = traceRegionRings(m.data, m.width, m.height);
        assert.equal(rings.length, 2);
        const areas = rings.map(ringSignedArea).sort((a, b) => b - a);
        assert.ok(areas[0] > 0, 'outer positive');
        assert.ok(areas[1] < 0, 'hole negative');
        assert.equal(Math.abs(areas[0]), 25);
        assert.equal(Math.abs(areas[1]), 1);
    });

    it('separates two holes that pinch at a corner instead of welding them', () => {
        // The classic ambiguity: at the shared corner two edges arrive and two
        // leave. Pairing them wrongly produces one figure-eight ring.
        const m = mask([
            '####',
            '#.##',
            '##.#',
            '####'
        ]);
        const rings = traceRegionRings(m.data, m.width, m.height);
        assert.equal(rings.length, 3, 'one outer plus two distinct holes');
        const holes = rings.filter(r => ringSignedArea(r) < 0);
        assert.equal(holes.length, 2);
        for (const h of holes) assert.equal(Math.abs(ringSignedArea(h)), 1);
    });

    it('groups the traced rings into one polygon with a hole', () => {
        const m = mask([
            '#####',
            '#####',
            '##.##',
            '#####',
            '#####'
        ]);
        const mp = ringsToMultiPolygon(traceRegionRings(m.data, m.width, m.height));
        assert.equal(mp.length, 1, 'one outer');
        assert.equal(mp[0].length, 2, 'with one hole attached');
        assert.ok(ringSignedArea(mp[0][0]) > 0);
        assert.ok(ringSignedArea(mp[0][1]) < 0);
    });

    it('traces two disconnected blobs as two separate polygons', () => {
        const m = mask([
            '#..#',
            '....',
            '#..#'
        ]);
        const mp = ringsToMultiPolygon(traceRegionRings(m.data, m.width, m.height));
        assert.equal(mp.length, 4);
        for (const poly of mp) assert.equal(poly.length, 1);
    });
});

describe('simplifyRing', () => {
    it('collapses a staircase-free straight run to its corners', () => {
        const ring: Ring = [];
        for (let x = 0; x <= 10; x++) ring.push([x, 0]);
        for (let y = 1; y <= 10; y++) ring.push([10, y]);
        for (let x = 9; x >= 0; x--) ring.push([x, 10]);
        for (let y = 9; y >= 1; y--) ring.push([0, y]);
        ring.push([0, 0]);
        const out = simplifyRing(ring, 0.5);
        // Four corners plus the closing repeat.
        assert.equal(out.length, 5);
        assert.equal(Math.abs(ringSignedArea(out)), 100);
    });

    it('keeps a shape that would degenerate below a triangle', () => {
        const ring: Ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
        const out = simplifyRing(ring, 1000);
        assert.ok(out.length >= 4);
    });

    it('is independent of which vertex the trace started on', () => {
        const base: Ring = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [0, 8], [0, 0]];
        const rotated: Ring = [[8, 4], [8, 8], [0, 8], [0, 0], [4, 0], [8, 0], [8, 4]];
        const a = simplifyRing(base, 0.5);
        const b = simplifyRing(rotated, 0.5);
        assert.equal(a.length, b.length);
        assert.equal(Math.abs(ringSignedArea(a)), Math.abs(ringSignedArea(b)));
    });
});

describe('mask → canvas conversion', () => {
    it('divides mask pixel coordinates by the scale', () => {
        const ring: Ring = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
        const out = maskRingToCanvas(ring, 2);
        assert.deepEqual(out, [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]);
    });

    it('emits nonzero-fillable path data with the closing point dropped', () => {
        const m = mask([
            '#####',
            '#####',
            '##.##',
            '#####',
            '#####'
        ]);
        const mp = ringsToMultiPolygon(traceRegionRings(m.data, m.width, m.height));
        const d = multiPolygonToPathD(mp);
        assert.equal((d.match(/M/g) || []).length, 2, 'one subpath per ring');
        assert.equal((d.match(/Z/g) || []).length, 2);
        assert.ok(!/NaN|Infinity/.test(d));
    });
});
