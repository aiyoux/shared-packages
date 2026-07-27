/// <reference lib="webworker" />
import type { PathData } from './types.ts';
import { splitPathsByEraser, resetEraseStats, getEraseStats, setClipDiagnosticsEnabled, type EraseStats } from './eraser.ts';
import { setClipper2Module, setClipper2Enabled, isClipper2Active } from './clipping.ts';
import { buildEraseDelta, type EraseDelta } from './eraseDelta.ts';

/** Off-main-thread erase.
 *
 *  The drag-end precise pass is pure computation — no DOM, no Svelte — so it can
 *  run here and leave the UI thread free. That is the whole point: on a long
 *  stroke the pass is hundreds of ms, and running it inline froze the page.
 *  Structured-clone overhead is negligible next to it (measured 1.3ms of
 *  serialization against ~825ms of compute, 0.2%).
 *
 *  `isLayerLocked` is a closure and cannot be cloned, so the caller sends the
 *  data it closes over (locked ids + active layer + the multi-layer toggle) and
 *  the predicate is rebuilt here to mirror the store's own logic exactly. */
export type EraseRequest = {
    jobId: number;
    paths: PathData[];
    eraserPoints: { x: number; y: number }[];
    radius: number;
    lockedLayerIds: string[];
    activeLayerId: string;
    restrictToActiveLayer: boolean;
    candidates?: string[];
    /** Verbose per-piece clip diagnostics. The worker has its own module
     *  instance, so the main thread's toggle has to travel with the request. */
    clipDiagnostics?: boolean;
    /** A/B switch for the clipping engine, same reason as clipDiagnostics: this
     *  module instance is the worker's own, so the toggle rides the request. */
    useClipper2?: boolean;
};

export type EraseResponse =
    | {
        jobId: number; ok: true; paths: PathData[]; stats: EraseStats; changed: boolean;
        engine: 'clipper2' | 'martinez';
        /** Positional diff for the scoped undo entry, or null when it could not
         *  be derived (caller then stores the whole-array entry). Computed HERE
         *  because it keys off object identity, which does not survive the
         *  postMessage boundary. */
        delta: EraseDelta | null;
    }
    | { jobId: number; ok: false; error: string };

/** Load the Clipper2 wasm once, off to the side of the first erase.
 *
 *  Kept OUT of clipping.ts because the `?url` import is Vite-specific and
 *  `eraser.ts` (which pulls in clipping.ts) is imported directly by the Node
 *  test suite. Failure here is non-fatal: clipping.ts simply stays on Martinez.
 *
 *  Every erase awaits this promise, so a stroke that lands before the wasm has
 *  finished loading waits for it rather than silently taking the slow engine —
 *  the load is a one-off ~200KB fetch and instantiation. */
const clipperReady: Promise<void> = (async () => {
    try {
        const [{ default: factory }, wasmUrl] = await Promise.all([
            import('clipper2-wasm/dist/es/clipper2z.js'),
            import('clipper2-wasm/dist/es/clipper2z.wasm?url').then(m => m.default)
        ]);
        const mod = await factory({ locateFile: () => wasmUrl });
        // 6 decimal places: Clipper2 clips on scaled integers, and at 1e-6 its
        // quantisation is far below the 0.1 grid the eraser already snaps to,
        // so the engine contributes no error of its own (measured 0.00000%
        // filled-area difference vs Martinez on the real captured stroke).
        setClipper2Module(mod, 6);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ERASE] Clipper2 wasm unavailable, using Martinez:', err);
    }
})();

self.onmessage = async (event: MessageEvent<EraseRequest>) => {
    const req = event.data;
    try {
        await clipperReady;
        setClipper2Enabled(req.useClipper2 !== false);
        setClipDiagnosticsEnabled(!!req.clipDiagnostics);
        // Counters are per-pass here: one message is exactly one drag-end pass,
        // so they describe this erase alone and can be reported back for the
        // debug popover / perf log on the main thread.
        resetEraseStats();
        const locked = new Set(req.lockedLayerIds);
        const isLayerLocked = (layerId?: string) => {
            const id = layerId || 'default';
            if (locked.has(id)) return true;
            return req.restrictToActiveLayer && id !== req.activeLayerId;
        };
        // `sync.removed` collects every path the pass actually touched, so the
        // main thread can tell whether anything changed (→ whether to push an undo
        // entry) without diffing the result array.
        const sync = { removed: [] as PathData[], added: [] as PathData[] };
        const paths = splitPathsByEraser(
            req.paths,
            req.eraserPoints,
            req.radius,
            isLayerLocked,
            req.candidates ? { candidates: new Set(req.candidates), sync } : { sync }
        );
        const changed = sync.removed.length > 0;
        const res: EraseResponse = {
            jobId: req.jobId, ok: true, paths, stats: getEraseStats(),
            changed,
            engine: isClipper2Active() ? 'clipper2' : 'martinez',
            delta: changed ? buildEraseDelta(req.paths, paths, sync) : null
        };
        (self as unknown as Worker).postMessage(res);
    } catch (err) {
        // Never leave the caller hanging — it reverts to the un-erased state and
        // clears its in-flight UI on an error reply.
        const res: EraseResponse = { jobId: req.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
        (self as unknown as Worker).postMessage(res);
    }
};
