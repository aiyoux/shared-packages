// @ts-nocheck
// Requires --experimental-test-module-mocks (see package.json's "test" script).
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

test('a Martinez difference that silently omits a genuinely untouched disjoint region is caught, not trusted', async () => {
    // Real repro: user-saved production data showed a thin freehand stroke
    // where a fragment near the eraser survived every per-piece guard (the
    // split returned a non-empty result and returned immediately), while a
    // second, entirely untouched, disjoint region of the SAME stroke was
    // absent from polygon-clipping's own raw difference output — no
    // fragment left behind for any per-piece guard to inspect (that's what
    // subjectHasOmittedSurvivor exists to catch, but it used to only run
    // when the WHOLE result was empty). Forcing the exact Martinez
    // numerical trigger on demand isn't practical, so this simulates the
    // failure directly: wrap the real `difference` to drop any output
    // polygon far from the eraser, mimicking the omission, and verifies the
    // guard rejects the corrupted result rather than silently trusting it.
    const real = await import('polygon-clipping');
    mock.module('polygon-clipping', {
        exports: {
            default: {
                ...real.default,
                difference: (...args) => {
                    const result = real.default.difference(...args);
                    return result.filter(poly => {
                        const ring = poly[0];
                        if (!ring) return true;
                        // Drop any polygon whose vertices are all far to the right —
                        // simulates Martinez omitting the untouched far region.
                        return !ring.every(([x]) => x > 400);
                    });
                }
            }
        }
    });

    const { splitPathsByEraser } = await import('../src/eraser.ts?mockedDifference=1');

    const near = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
    const far = 'M 500 500 L 600 500 L 600 600 L 500 600 Z';
    const path = { d: `${near} ${far}`, fill: '#000', stroke: 'none', strokeWidth: 0, clipDerived: true };

    // Eraser only ever touches the near square.
    const out = splitPathsByEraser([path], [{ x: 50, y: 50 }], 20, () => false);

    assert.ok(
        out.some(o => pathContains(o.d, 550, 550)),
        'the untouched far region vanished — an omitted-Martinez-output survivor was silently trusted'
    );
});
