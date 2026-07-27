// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { splitPathsByEraser, eraserOutlinePolygon } from '../src/eraser.ts';

// Real-scene regression from an EXACT captured erase (see the trail-capture in
// sketchStore): a hook/checkmark eraser stroke over a busy scene. The user saw a
// chunk vanish from the MIDDLE of the hook — ink the stroke visibly never
// touched. Two bugs combined:
//   1. eraserOutlinePolygon's union of the trail capsules CRASHED on the curving
//      hook ("Unable to find segment … in SweepLine tree") and fell back to the
//      raw overlapping capsules — a malformed clip that can corrupt the diff.
//      (Fixed: retry the union on grid-snapped parts → one clean polygon.)
//   2. The real over-removal: line segments surviving in the NOTCH between the
//      hook's two arms (they came out of the difference, so they're genuine
//      un-erased ink, ~18-30px²) were discarded by polygonIsTinyEraserRemnant,
//      whose area cap is radius-scaled (r²·0.08 = 46px² at r=24) and so ate real
//      survivors. (Fixed: an absolute 12px² ceiling on "dust".)
//
// Invariant: ink removed while lying OUTSIDE the eraser's true footprint
// (eraserOutlinePolygon) must be negligible. Pre-fix leaked ~62px²; fixed ~8px².

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures/erase-hook-repro.json'), 'utf8'));
const { before, eraserPoints, radius } = fx;

const parseRings = (d) => {
    const rings = []; let cur = [];
    const re = /([ML])\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)|Z/g; let m;
    while ((m = re.exec(d))) {
        if (m[0][0] === 'Z') { if (cur.length > 2) rings.push(cur); cur = []; continue; }
        if (m[1] === 'M') { if (cur.length > 2) rings.push(cur); cur = []; }
        cur.push([+m[2], +m[3]]);
    }
    if (cur.length > 2) rings.push(cur);
    return rings;
};

// point-in-multipolygon (respecting holes) for the eraser footprint
const pip = (x, y, ring) => {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi || 1e-9) + xi)) ins = !ins;
    }
    return ins;
};

test('real hook erase removes no ink outside its true footprint (notch survivors kept)', () => {
    const footprint = eraserOutlinePolygon(eraserPoints, radius);
    assert.ok(footprint && footprint.length > 0, 'eraserOutlinePolygon returned nothing');
    // The hook's capsule union must resolve to ONE clean polygon — not the dozens
    // of raw overlapping capsules the pre-fix fallback returned (one per segment).
    assert.equal(footprint.length, 1, `eraser footprint should be a single clean polygon, got ${footprint.length} (raw-parts fallback?)`);

    const inFoot = (x, y) => {
        for (const poly of footprint) {
            if (!pip(x, y, poly[0])) continue;
            if (poly.slice(1).some(h => pip(x, y, h))) continue;
            return true;
        }
        return false;
    };

    const out = splitPathsByEraser(before.map(p => ({ ...p })), eraserPoints, radius, () => false);

    // Rasterize before/after over the erase region and count removed pixels
    // outside the footprint.
    const REG = { x: 400, y: 90, w: 200, h: 170 }, SC = 4, W = REG.w * SC, H = REG.h * SC;
    // Reuse a canvas-free scanline fill.
    const raster = (ps) => {
        const g = new Uint8Array(W * H);
        for (const p of ps) {
            if (!p.d || !(p.fill && p.fill !== 'none')) continue;
            const rings = parseRings(p.d).map(r => r.map(([x, y]) => [(x - REG.x) * SC, (y - REG.y) * SC]));
            for (let py = 0; py < H; py++) {
                const yy = py + 0.5; const xs = [];
                for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const [xi, yi] = ring[i], [xj, yj] = ring[j];
                    if ((yi > yy) !== (yj > yy)) { const t = (yy - yi) / (yj - yi); xs.push({ x: xi + t * (xj - xi), w: yj > yi ? 1 : -1 }); }
                }
                xs.sort((a, b) => a.x - b.x); let wind = 0;
                for (let k = 0; k < xs.length - 1; k++) {
                    wind += xs[k].w;
                    if (wind !== 0) { const x0 = Math.max(0, Math.ceil(xs[k].x - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1].x - 0.5)); for (let px = x0; px <= x1; px++) g[py * W + px] = 1; }
                }
            }
        }
        return g;
    };
    const b = raster(before), a = raster(out);
    let removed = 0, outside = 0;
    for (let j = 0; j < W * H; j++) {
        if (!(b[j] && !a[j])) continue;
        removed++;
        const px = j % W, py = Math.floor(j / W);
        if (!inFoot(REG.x + px / SC, REG.y + py / SC)) outside++;
    }

    assert.ok(removed > 2000, `expected the hook to remove real ink, only ${removed}px`);
    const outsideUnits = outside / (SC * SC);
    assert.ok(
        outsideUnits < 25,
        `removed ${outsideUnits.toFixed(0)}px² OUTSIDE the eraser footprint — a chunk is vanishing from the notch between the hook arms (over-erase regression)`
    );
});
