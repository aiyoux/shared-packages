/// <reference lib="webworker" />
import type { PathData } from './types.ts';
import { splitPathsByEraser, resetEraseStats, getEraseStats, setClipDiagnosticsEnabled, type EraseStats, type FadeOptions } from './eraser.ts';
import { setClipper2Module, setClipper2Enabled, isClipper2Active } from './clipping.ts';
import { buildEraseDelta, type EraseDelta } from './eraseDelta.ts';

/** Off-main-thread erase.
 *
 *  The drag-end precise pass is pure computation — no DOM, no Svelte — so it can
 *  run here and leave the UI thread free. That is the whole point: on a long
 *  stroke the pass is hundreds of ms, and running it inline froze the page.
 *  Structured-clone overhead is negligible next to a drag-END pass (measured
 *  1.3ms of serialization against ~825ms of compute, 0.2%). It is NOT negligible
 *  for "apply while erasing", where the compute per increment is a couple of ms
 *  and the document is sent — and sent back — every time. Profiled on 800
 *  paths: ~1020ms of a single drag inside clone/structuredClone, which was
 *  essentially the whole cost of the drag.
 *
 *  So a rub can open a SESSION. The document is handed over once, the worker
 *  keeps the working copy for the length of the rub, and each pass carries only
 *  the trail and comes back as a positional diff. A pass whose diff could not be
 *  derived falls back to the full array, so the caller is never left without a
 *  way to apply the result.
 *
 *  `isLayerLocked` is a closure and cannot be cloned, so the caller sends the
 *  data it closes over (locked ids + active layer + the multi-layer toggle) and
 *  the predicate is rebuilt here to mirror the store's own logic exactly. */
export type EraseRequest = {
    jobId: number;
    /** The rub this pass belongs to. Passes that share one carry the document
     *  only on the first message; later ones use the worker's copy. Absent for
     *  a one-shot pass, which behaves exactly as before. */
    sessionId?: number;
    /** Drop the session's working copy. Carries no work and gets no reply —
     *  sent once the rub's passes have all drained. */
    closeSession?: boolean;
    /** Omitted on a continuing session pass: the worker already has it. */
    paths?: PathData[];
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
    /** Set by the fade eraser: ink under the eraser is dimmed rather than cut. */
    fade?: FadeOptions;
};

export type EraseResponse =
    | {
        jobId: number; ok: true;
        /** Present for a one-shot pass, and for the pass that closes a session.
         *  Omitted mid-session — apply `delta` instead. */
        paths?: PathData[];
        stats: EraseStats; changed: boolean;
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

/** Working copy per open rub. One entry at a time in practice; keyed so a
 *  stale pass from an abandoned rub cannot write into a live one. */
const sessions = new Map<number, PathData[]>();

self.onmessage = async (event: MessageEvent<EraseRequest>) => {
    const req = event.data;
    // A close carries no work and expects no reply.
    if (req.closeSession) {
        if (req.sessionId != null) sessions.delete(req.sessionId);
        return;
    }
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
        // A continuing session pass brings no paths; use the copy this worker
        // has been keeping. A session whose copy is missing (a stray pass after
        // it closed) is not recoverable here — fail loudly rather than erase
        // against the wrong document.
        const before = req.paths ?? (req.sessionId != null ? sessions.get(req.sessionId) : undefined);
        if (!before) throw new Error('erase pass has no paths and no open session');
        if (req.sessionId != null && req.paths) sessions.set(req.sessionId, req.paths);
        const paths = splitPathsByEraser(
            before,
            req.eraserPoints,
            req.radius,
            isLayerLocked,
            req.candidates
                ? { candidates: new Set(req.candidates), sync, fade: req.fade }
                : { sync, fade: req.fade }
        );
        const changed = sync.removed.length > 0;
        const delta = changed ? buildEraseDelta(before, paths, sync) : null;
        const inSession = req.sessionId != null;
        if (inSession) sessions.set(req.sessionId!, paths);
        // Mid-session the diff is enough, and it is the whole point — shipping
        // the array back every increment costs as much as sending it out. With
        // no diff to send there is nothing to apply, so hand over the array.
        const sendPaths = !inSession || !delta;
        const res: EraseResponse = {
            jobId: req.jobId, ok: true,
            ...(sendPaths ? { paths } : {}),
            stats: getEraseStats(),
            changed,
            engine: isClipper2Active() ? 'clipper2' : 'martinez',
            delta
        };
        (self as unknown as Worker).postMessage(res);
    } catch (err) {
        // Never leave the caller hanging — it reverts to the un-erased state and
        // clears its in-flight UI on an error reply.
        const res: EraseResponse = { jobId: req.jobId, ok: false, error: err instanceof Error ? err.message : String(err) };
        (self as unknown as Worker).postMessage(res);
    }
};
