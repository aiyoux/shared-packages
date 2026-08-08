import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';

/** Boolean polygon ops for the eraser, with two interchangeable engines.
 *
 *  IN THE APP: Clipper2 compiled to WebAssembly, ~12x faster on the erase's
 *  dominant `difference` (17.4ms → 1.5ms measured on a real 2149-point captured
 *  stroke) and ~10x on the swept-outline self-union. Once the worker has
 *  installed it, it is the only engine that runs — a mid-session error does NOT
 *  quietly hand the work to the slow one (see `onEngineError`).
 *
 *  OTHERWISE: polygon-clipping (Martinez, pure JS) — the engine every erase
 *  regression test and guard threshold was tuned against. It runs wherever
 *  Clipper2 was never installed (the Node test suite, SSR, a failed wasm fetch)
 *  and when the debug popover switches engines deliberately to A/B a stroke.
 *
 *  Precision is NOT the trade here. Clipper2 clips on integer coordinates
 *  internally; ClipperD scales by `precision` decimal places, so the engine's
 *  own quantisation at precision 6 is 1e-6 — five orders of magnitude finer
 *  than the 0.1 grid this code ALREADY snaps to before clipping (roundPolygon).
 *  Measured against Martinez on the real swept region, total filled area
 *  converges: 0.0013% at 2dp, 0.00001% at 4dp, 0.00000% at 6dp.
 *
 *  This module stays free of bundler-specific imports (no `?url`, no dynamic
 *  wasm resolution) because `eraser.ts` pulls it in and the Node test suite
 *  imports `eraser.ts` directly. The worker loads the wasm and injects the
 *  module here via `setClipper2Module`; anything that never calls that — tests,
 *  SSR, a failed wasm fetch — transparently keeps using Martinez. */

type Geom = Polygon | MultiPolygon;

// Minimal structural typing of the bits of the Clipper2 wasm module we use.
type Clipper2Module = {
    ClipperD: new (precision: number) => {
        AddSubject(paths: unknown): void;
        AddClip(paths: unknown): void;
        ExecutePoly(clipType: unknown, fillRule: unknown, polyTree: unknown): boolean;
        delete(): void;
    };
    MakePathD: (flatCoords: number[]) => { view(): Float64Array; size(): number; delete(): void };
    PathsD: new () => { push_back(p: unknown): void; delete(): void };
    PolyPathD: new () => {
        count(): number;
        child(i: number): {
            polygon(): { view(): Float64Array; size(): number };
            count(): number;
            child(i: number): unknown;
        };
        delete(): void;
    };
    FillRule: { NonZero: unknown; EvenOdd: unknown; Positive: unknown; Negative: unknown };
    ClipType: { Intersection: unknown; Union: unknown; Difference: unknown; Xor: unknown };
};

let mod: Clipper2Module | null = null;
let precision = 6;
let enabled = true;

/** Install the loaded Clipper2 wasm module (called from the worker). */
export const setClipper2Module = (m: unknown, decimalPrecision = 6) => {
    mod = (m as Clipper2Module) ?? null;
    precision = decimalPrecision;
};

/** Runtime A/B switch — lets the debug popover fall back to Martinez on-device
 *  without a rebuild, so the two engines can be compared on the same stroke.
 *  This is a DELIBERATE choice by whoever flips it; it is not the automatic
 *  fallback, which is off (see `martinezFallback`). */
export const setClipper2Enabled = (on: boolean) => { enabled = on; };
export const isClipper2Active = () => !!mod && enabled;

/**
 * May a Clipper2 failure be answered by silently running Martinez instead?
 *
 * OFF. The automatic fallback kept biting: a single failed op used to hand the
 * rest of the session to an engine an order of magnitude slower, and because it
 * still produced correct-looking geometry there was nothing to see — erasing was
 * simply, permanently, sluggish. Worse, an adapter that threw on EVERY call once
 * made a validation run report "0.00000% identical" purely because it was
 * comparing Martinez against itself.
 *
 * With it off, a Clipper2 error propagates: the erase worker replies `ok: false`
 * and the main thread leaves the paths untouched. One erase visibly does nothing
 * instead of every later erase quietly costing 12x — a failure you can act on.
 *
 * The Martinez path itself is untouched and still runs wherever Clipper2 was
 * never installed, and {@link setMartinezFallbackEnabled} turns the automatic
 * route back on if a build ever needs it.
 */
let martinezFallback = false;
export const setMartinezFallbackEnabled = (on: boolean) => { martinezFallback = on; };
export const isMartinezFallbackEnabled = () => martinezFallback;

const asMulti = (g: Geom): MultiPolygon =>
    // A Polygon is Ring[]; a MultiPolygon is Polygon[]. The first element of a
    // Polygon is a Ring (array of [x,y] pairs), so probe two levels down.
    (Array.isArray(g[0]) && Array.isArray((g[0] as Ring)[0]) && typeof (g[0] as Ring)[0][0] === 'number')
        ? [g as Polygon]
        : (g as MultiPolygon);

/** MultiPolygon → PathsD, via MakePathD(flat number[]).
 *  NOTE: PathD.assign(Float64Array) exists in the typings but throws from the
 *  wasm build, so the flat-array factory is the only working bulk path in. */
const toPathsD = (m: Clipper2Module, geoms: MultiPolygon[], owned: { delete(): void }[]) => {
    const paths = new m.PathsD();
    owned.push(paths);
    for (const mp of geoms) {
        for (const poly of mp) {
            for (const ring of poly) {
                const n = ring.length;
                if (n < 3) continue;
                const flat: number[] = new Array(n * 2);
                for (let i = 0; i < n; i++) { flat[i * 2] = ring[i][0]; flat[i * 2 + 1] = ring[i][1]; }
                const p = m.MakePathD(flat);
                owned.push(p);
                paths.push_back(p);
            }
        }
    }
    return paths;
};

/** PathD → Ring.
 *
 *  STRIDE IS 3, NOT 2. This package builds Clipper2 with the optional Z
 *  coordinate ("clipper2z"), so `view()` yields x,y,z triples — a 4-point path
 *  returns a 12-element Float64Array. Reading it two-at-a-time silently
 *  interleaves z values into the coordinates and produces garbage geometry. */
const readRing = (path: { view(): Float64Array; size(): number }): Ring => {
    const view = path.view();
    const n = path.size();
    const ring: Ring = new Array(n + 1) as Ring;
    for (let i = 0; i < n; i++) ring[i] = [view[i * 3], view[i * 3 + 1]];
    // polygon-clipping emits explicitly closed rings (last point === first);
    // Clipper2 leaves them open. Close them so downstream ring walks, area sums
    // and `d` emission see exactly the shape they see from Martinez.
    ring[n] = [view[0], view[1]];
    return ring;
};

/** PolyTree → MultiPolygon. Clipper2 returns a FLAT path list from ExecutePath,
 *  which loses which ring is a hole of which outer — the grouping MultiPolygon
 *  encodes and every consumer here relies on. ExecutePoly gives the hierarchy:
 *  a node's children are outers, each outer's children are its holes, and a
 *  hole's children are outers nested inside it. */
const collectPolygons = (node: { count(): number; child(i: number): any }, out: MultiPolygon) => {
    const n = node.count();
    for (let i = 0; i < n; i++) {
        const outer = node.child(i);
        const rings: Polygon = [readRing(outer.polygon())];
        const holeCount = outer.count();
        for (let h = 0; h < holeCount; h++) rings.push(readRing(outer.child(h).polygon()));
        out.push(rings);
        // Recurse through the holes to pick up any outers nested inside them.
        for (let h = 0; h < holeCount; h++) collectPolygons(outer.child(h), out);
    }
};

/** Phase timings, so a disappointing end-to-end number can be attributed to the
 *  wasm boundary vs the clip itself rather than guessed at. */
export const clipStats = { calls: 0, convertMs: 0, execMs: 0, readMs: 0 };
export const resetClipStats = () => { clipStats.calls = 0; clipStats.convertMs = 0; clipStats.execMs = 0; clipStats.readMs = 0; };

/** Run one Clipper2 op. THROWS on engine failure — every caller already wraps
 *  this in the one try/catch that decides what a failure means, so returning a
 *  null nobody could attribute only made the failure easy to miss. */
const run = (clipType: unknown, subjects: MultiPolygon[], clips: MultiPolygon[]): MultiPolygon => {
    const m = mod!;
    const owned: { delete(): void }[] = [];
    let clipper: InstanceType<Clipper2Module['ClipperD']> | null = null;
    let tree: InstanceType<Clipper2Module['PolyPathD']> | null = null;
    try {
        clipStats.calls++;
        const t0 = performance.now();
        clipper = new m.ClipperD(precision);
        clipper.AddSubject(toPathsD(m, subjects, owned));
        if (clips.length) clipper.AddClip(toPathsD(m, clips, owned));
        tree = new m.PolyPathD();
        const t1 = performance.now();
        clipStats.convertMs += t1 - t0;
        // NonZero matches how these polygons are authored and rendered (the
        // emitted `d` is filled nonzero), and how Martinez treats them.
        // ExecutePoly answers false only on engine failure — an empty clip is a
        // true with no children — so this is an error, not "nothing to do".
        if (!clipper.ExecutePoly(clipType, m.FillRule.NonZero, tree)) {
            throw new Error('Clipper2 ExecutePoly returned false');
        }
        const t2 = performance.now();
        clipStats.execMs += t2 - t1;
        const out: MultiPolygon = [];
        collectPolygons(tree as any, out);
        clipStats.readMs += performance.now() - t2;
        return out;
    } finally {
        // Every wasm object is manually heap-allocated; leaking them would grow
        // the worker's memory on every erase.
        tree?.delete();
        clipper?.delete();
        for (let i = owned.length - 1; i >= 0; i--) { try { owned[i].delete(); } catch { /* already freed */ } }
    }
};

/** Counters for the debug popover, so a struggling engine leaves a trace even
 *  when nothing visibly breaks. */
export const clipFallbacks = { count: 0, lastError: null as unknown };
let warned = false;

/**
 * A Clipper2 op failed. Record it, say so once, and then — unless the automatic
 * Martinez route has been switched on — rethrow.
 *
 * Rethrowing is the point. Swallowing it here is what let a broken fast path
 * masquerade as a working one; the erase worker turns the throw into an
 * `ok: false` reply, which leaves the drawing exactly as it was and shows up in
 * the console instead of hiding in the frame budget.
 */
const onEngineError = (err: unknown): void => {
    clipFallbacks.count++;
    clipFallbacks.lastError = err;
    if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn(
            martinezFallback
                ? '[CLIP] Clipper2 failed, falling back to Martinez:'
                : '[CLIP] Clipper2 failed and the Martinez fallback is off — this op will not be applied:',
            err
        );
    }
    if (!martinezFallback) throw err;
};

export const union = (geom: Geom, ...geoms: Geom[]): MultiPolygon => {
    if (isClipper2Active()) {
        try {
            return run(mod!.ClipType.Union, [asMulti(geom), ...geoms.map(asMulti)], []);
        } catch (err) { onEngineError(err); }
    }
    return polygonClipping.union(geom as Polygon, ...(geoms as Polygon[]));
};

export const difference = (subject: Geom, ...clips: Geom[]): MultiPolygon => {
    if (isClipper2Active()) {
        try {
            return run(mod!.ClipType.Difference, [asMulti(subject)], clips.map(asMulti));
        } catch (err) { onEngineError(err); }
    }
    return polygonClipping.difference(subject as Polygon, ...(clips as Polygon[]));
};

/** The overlap between subject and clips — the mirror of `difference`. The fade
 *  eraser keeps this part at a reduced opacity instead of removing it. */
export const intersection = (subject: Geom, ...clips: Geom[]): MultiPolygon => {
    if (isClipper2Active()) {
        try {
            return run(mod!.ClipType.Intersection, [asMulti(subject)], clips.map(asMulti));
        } catch (err) { onEngineError(err); }
    }
    return polygonClipping.intersection(subject as Polygon, ...(clips as Polygon[]));
};
