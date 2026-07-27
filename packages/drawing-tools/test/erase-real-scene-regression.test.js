// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { splitPathsByEraser } from '../src/eraser.ts';

// Highest-fidelity erase regression: REAL production paths from a saved sketch
// that actually exhibited the "some lines get eaten" bug, replayed against the
// REAL eraser trail recovered by fitting the saved before/after states (IoU
// 0.93). Unlike the synthetic unit tests, this exercises the exact geometry
// that failed in the wild.
//
// The invariant under test — the single property every erase bug in this area
// violated in one way or another — is: ERASING MUST NOT REMOVE INK THE ERASER
// NEVER TOUCHED. Concretely, no ink lying outside the eraser footprint (more
// than `radius` from the trail) may disappear from the result.
//
// The specific bug this scene pins: a thin clipDerived line (id 558bd0e8, area
// ~412) cut by a wide eraser (radius 22) left surviving remainders of only
// ~27-39px² reaching ~33-36px from the trail — clearly outside the 22px
// footprint, unmistakably real un-erased ink — that polygonIsTinyEraserRemnant
// wrongly discarded as "dust" because its area threshold scales with eraser
// radius. Old code leaked ~780px² of such collateral here; the fix leaks ~22px²
// (sub-pixel edge rounding).

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures/erase-thin-line-scene.json'), 'utf8'));
const { paths, trail, radius, region } = fixture;

// --- Minimal nonzero-fill scanline rasterizer over the fixture region. ---
// Node has no canvas; this fills each path's rings on a grid so we can measure
// ink removed vs the eraser footprint at the pixel level (the same measurement
// used to verify the fix live in the browser).
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

const SCALE = 4;
const W = Math.ceil((region.maxX - region.minX) * SCALE);
const H = Math.ceil((region.maxY - region.minY) * SCALE);

const rasterize = (ps) => {
    const grid = new Uint8Array(W * H);
    for (const p of ps) {
        if (!p.d || !(p.fill && p.fill !== 'none')) continue;
        const rings = parseRings(p.d).map(r => r.map(([x, y]) => [(x - region.minX) * SCALE, (y - region.minY) * SCALE]));
        for (let py = 0; py < H; py++) {
            const yy = py + 0.5;
            const xs = [];
            for (const ring of rings) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const [xi, yi] = ring[i], [xj, yj] = ring[j];
                    if ((yi > yy) !== (yj > yy)) { const t = (yy - yi) / (yj - yi); xs.push({ x: xi + t * (xj - xi), w: yj > yi ? 1 : -1 }); }
                }
            }
            xs.sort((a, b) => a.x - b.x);
            let wind = 0;
            for (let k = 0; k < xs.length - 1; k++) {
                wind += xs[k].w;
                if (wind !== 0) {
                    const x0 = Math.max(0, Math.ceil(xs[k].x - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1].x - 0.5));
                    for (let px = x0; px <= x1; px++) grid[py * W + px] = 1;
                }
            }
        }
    }
    return grid;
};

const distToTrail = (x, y) => {
    let min = Infinity;
    for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let t = l2 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const px = a.x + t * dx, py = a.y + t * dy; const d = (x - px) ** 2 + (y - py) ** 2; if (d < min) min = d;
    }
    return Math.sqrt(min);
};

test('real saved scene: a wide eraser cutting thin lines removes NO ink beyond its footprint', () => {
    const before = rasterize(paths);
    const out = splitPathsByEraser(paths.map(p => ({ ...p })), trail, radius, () => false);
    const after = rasterize(out);

    let removedTotal = 0, collateralPx = 0;
    for (let j = 0; j < W * H; j++) {
        if (before[j] && !after[j]) {
            removedTotal++;
            const px = j % W, py = Math.floor(j / W);
            const ux = region.minX + px / SCALE, uy = region.minY + py / SCALE;
            if (distToTrail(ux, uy) > radius + 1.5) collateralPx++;
        }
    }

    // The eraser did remove a substantial amount of ink (it genuinely swept
    // through the scene) — guard against a no-op that would make the collateral
    // check vacuous.
    assert.ok(removedTotal > 5000, `expected the eraser to remove real ink, only removed ${removedTotal}px`);

    // Collateral: ink removed while lying OUTSIDE the eraser footprint. The fix
    // leaves ~22px (sub-pixel edge rounding on cut boundaries); the pre-fix
    // tinyRemnant bug leaked ~780px here. A threshold of 100px (6.25px² at
    // SCALE=4) cleanly separates the two.
    const collateralUnits = collateralPx / (SCALE * SCALE);
    assert.ok(
        collateralPx < 100,
        `erased ${collateralPx}px (${collateralUnits.toFixed(1)}px²) of ink OUTSIDE the eraser footprint — ` +
        `thin-line remainders are being eaten (regression of the tinyRemnant footprint-margin fix)`
    );
});

test('real saved scene: the thin line 558bd0e8 keeps its far remainder past the eraser', () => {
    // Path 558bd0e8 is the specific thin line whose left remainders (x≈928-942,
    // ~34px from the trail, well past the 22px footprint) were discarded as
    // dust. Assert its ink survives out there.
    const p = paths.find(pp => pp.id.startsWith('558bd0e8'));
    assert.ok(p, 'fixture is missing the 558bd0e8 thin line');

    const out = splitPathsByEraser([{ ...p }], trail, radius, () => false);

    // Point-in-path over all emitted pieces (nonzero-agnostic even/odd probe).
    const inkAt = (px, py) => out.some(o => {
        let inside = false;
        for (const ring of parseRings(o.d)) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const [xi, yi] = ring[i], [xj, yj] = ring[j];
                if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi || 1e-9) + xi)) inside = !inside;
            }
        }
        return inside;
    });

    // Interior points of the three surviving far-left remainders (ring
    // centroids at ~(935,270), (935,278), (935,284) — all 26-28px from the
    // trail, past the 22px footprint). Require ink at all three: the pre-fix
    // code discarded them as dust, leaving these spots empty.
    assert.ok(inkAt(935, 270), 'the far remainder of 558bd0e8 near y=270 was eaten as dust');
    assert.ok(inkAt(935, 278), 'the far remainder of 558bd0e8 near y=278 was eaten as dust');
    assert.ok(inkAt(935, 284), 'the far remainder of 558bd0e8 near y=284 was eaten as dust');
});
