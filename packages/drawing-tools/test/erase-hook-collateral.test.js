// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { splitPathsByEraser } from '../src/eraser.ts';

// Real-scene regression built from EXACT captured eraser strokes (see the
// trail-capture in sketchStore): the full real "Before B" canvas plus the six
// hook/U eraser passes, in order. The interesting pass is the LAST, applied to
// the state the earlier five left — the compounding depends on how prior passes
// split paths across the WHOLE document, so the full scene is required.
//
// Two invariants for that final pass, each catching a bug fixed this session:
//   1. It must ACTUALLY ERASE its footprint. With the pre-fix code the
//      subjectHasOmittedSurvivor guard false-positived on the sharp corners of
//      the compounded clipDerived pieces and reverted the whole pass — the hook
//      removed almost nothing (~63px instead of ~9400px), a stark under-erase
//      (the eraser visibly passes through yet the ink stays). The edge-proximity
//      fix (a subject vertex ON a kept edge counts as preserved) resolves it.
//   2. It must NOT OVER-REMOVE: ink removed outside its OWN footprint (measured
//      against the last trail alone, since the region overlaps earlier
//      footprints) must be negligible — the tinyRemnant footprint-margin fix.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(join(__dirname, 'fixtures/erase-hook-bigchunk-scene.json'), 'utf8'));
const { paths, trails } = fixture;

// --- nonzero-fill scanline rasterizer over a region (Node has no canvas) ---
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

const REGION = { x: 380, y: 90, w: 240, h: 300 };
const SCALE = 3;
const W = REGION.w * SCALE, H = REGION.h * SCALE;

const rasterize = (ps) => {
    const grid = new Uint8Array(W * H);
    for (const p of ps) {
        if (!p.d || !(p.fill && p.fill !== 'none')) continue;
        const rings = parseRings(p.d).map(r => r.map(([x, y]) => [(x - REGION.x) * SCALE, (y - REGION.y) * SCALE]));
        for (let py = 0; py < H; py++) {
            const yy = py + 0.5; const xs = [];
            for (const ring of rings) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const [xi, yi] = ring[i], [xj, yj] = ring[j];
                    if ((yi > yy) !== (yj > yy)) { const t = (yy - yi) / (yj - yi); xs.push({ x: xi + t * (xj - xi), w: yj > yi ? 1 : -1 }); }
                }
            }
            xs.sort((a, b) => a.x - b.x); let wind = 0;
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

const distToTrail = (t, x, y) => {
    let min = Infinity;
    const pts = t.eraserPoints;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        let u = l2 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
        const px = a.x + u * dx, py = a.y + u * dy; const d = (x - px) ** 2 + (y - py) ** 2; if (d < min) min = d;
    }
    return Math.sqrt(min);
};

test('real scene: a hook erase on a compounded state erases its footprint and removes no chunk outside it', () => {
    // Run the first five passes to reach the compounded state, then isolate the
    // SIXTH (final) pass and check both invariants above against its own trail.
    let state = paths.map(p => ({ ...p }));
    for (let i = 0; i < trails.length - 1; i++) {
        state = splitPathsByEraser(state, trails[i].eraserPoints, trails[i].radius, () => false);
    }
    const beforeLast = rasterize(state);

    const last = trails[trails.length - 1];
    const afterLast = rasterize(splitPathsByEraser(state, last.eraserPoints, last.radius, () => false));

    let removed = 0, collateral = 0;
    for (let j = 0; j < W * H; j++) {
        if (!(beforeLast[j] && !afterLast[j])) continue;
        removed++;
        const px = j % W, py = Math.floor(j / W);
        const ux = REGION.x + px / SCALE, uy = REGION.y + py / SCALE;
        if (distToTrail(last, ux, uy) > last.radius + 4) collateral++;
    }

    // Invariant 1 — the pass must actually erase. Pre-fix it reverted to ~63px
    // (omittedSurvivor false-positive); fixed it removes ~9400px. 3000 separates.
    assert.ok(removed > 3000, `the final hook barely erased (${removed}px) — the pass was reverted (under-erase regression)`);

    // Invariant 2 — no over-removal outside its own footprint. ~25px of edge
    // rounding is expected; a big chunk would be hundreds+. 500 separates.
    const collateralUnits = collateral / (SCALE * SCALE);
    assert.ok(
        collateral < 500,
        `the final hook removed ${collateral}px (${collateralUnits.toFixed(0)} units²) OUTSIDE its own footprint — ` +
        `a chunk is being removed beyond the erase zone (over-erase regression)`
    );
});
