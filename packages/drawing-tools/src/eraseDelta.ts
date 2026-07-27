import type { PathData } from './types';

/** Positional erase diff — the undo payload for a split-erase pass.
 *
 *  An erase entry used to store the affected page's ENTIRE paths array. Measured
 *  on a real session that was ~142KB per erase against a 130KB scene, so the
 *  undo history grew to 16x the size of the drawing itself and was rewritten to
 *  IndexedDB on every autosave. This stores only the paths the pass actually
 *  touched, the way the 'stroke' entry stores only the appended paths (~1.5KB).
 *
 *  `splitPathsByEraser` rebuilds the array in input order — untouched paths are
 *  carried through by IDENTITY, and a touched path is replaced in place by its
 *  pieces. So recording each removed original's index in the before-array and
 *  each added piece's index in the after-array describes the change completely
 *  and reversibly.
 *
 *  IDENTITY, NOT ID, is the key: the translate-strip case emits `{...path,
 *  transform: undefined}`, a NEW object carrying the SAME id, so an id-based
 *  diff would classify it as unchanged and silently lose the edit. */
export type EraseDelta = {
    beforeLen: number;
    afterLen: number;
    /** Removed originals, `i` indexing the BEFORE array. */
    removed: { i: number; p: PathData }[];
    /** Added pieces, `i` indexing the AFTER array. */
    added: { i: number; p: PathData }[];
};

/** Build the diff from a pass's input, output and `sync` collector.
 *
 *  Must run where the arrays still hold the ORIGINAL object references (inside
 *  the worker, or inline in the sync fallback) — identity is the key, and it
 *  does not survive a postMessage boundary against a separately-sent array.
 *
 *  Returns null if anything fails to line up, so the caller can fall back to the
 *  whole-array entry rather than persist a diff that would rebuild incorrectly. */
export const buildEraseDelta = (
    before: PathData[],
    after: PathData[],
    sync: { removed: PathData[]; added: PathData[] }
): EraseDelta | null => {
    const beforeIdx = new Map<PathData, number>();
    for (let i = 0; i < before.length; i++) beforeIdx.set(before[i], i);
    const afterIdx = new Map<PathData, number>();
    for (let i = 0; i < after.length; i++) afterIdx.set(after[i], i);

    const removed: { i: number; p: PathData }[] = [];
    const seenRemoved = new Set<number>();
    for (const p of sync.removed) {
        const i = beforeIdx.get(p);
        if (i === undefined || seenRemoved.has(i)) return null;
        seenRemoved.add(i);
        removed.push({ i, p });
    }
    const added: { i: number; p: PathData }[] = [];
    const seenAdded = new Set<number>();
    for (const p of sync.added) {
        const i = afterIdx.get(p);
        if (i === undefined || seenAdded.has(i)) return null;
        seenAdded.add(i);
        added.push({ i, p });
    }
    // The paths neither removed nor added are the untouched carry-throughs, and
    // both sides must agree on how many there are. A mismatch means the diff
    // does not describe this change (e.g. an object appeared twice) — bail.
    if (before.length - removed.length !== after.length - added.length) return null;
    return { beforeLen: before.length, afterLen: after.length, removed, added };
};

/** Rebuild the array on the other side of a diff: drop the entries at `dropAt`
 *  (indices into `current`), then place `insertAt` at their recorded indices and
 *  fill the gaps, in order, with what remains.
 *
 *  Returns null if the diff does not fit `current`, so callers can leave state
 *  untouched instead of applying a corrupt rebuild. */
export const rebuildFromEraseDelta = (
    current: PathData[],
    targetLen: number,
    dropAt: { i: number }[],
    insertAt: { i: number; p: PathData }[]
): PathData[] | null => {
    const drop = new Set<number>();
    for (const d of dropAt) drop.add(d.i);
    const kept: PathData[] = [];
    for (let i = 0; i < current.length; i++) if (!drop.has(i)) kept.push(current[i]);

    const out = new Array<PathData | undefined>(targetLen);
    for (const { i, p } of insertAt) {
        if (i < 0 || i >= targetLen || out[i] !== undefined) return null;
        out[i] = p;
    }
    let k = 0;
    for (let i = 0; i < targetLen; i++) if (out[i] === undefined) out[i] = kept[k++];
    if (k !== kept.length) return null;
    return out as PathData[];
};
