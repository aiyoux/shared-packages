// 2D drawing types shared between svg-sketcher and web_social_games.
//
// Factored out of svg-sketcher's src/lib/types/scene.ts — the 3D/caricature
// types (SceneObject, CameraState, TempBakeItem, PrimitiveType, …) stay in
// svg-sketcher; only the 2D drawing model and the polygon structural types
// used by the clip/erase pipeline live here.

/** A single eraser stroke's vector outline. */
export interface EraserPath {
    id: string;
    d: string;
    strokeWidth: number;
    /**
     * How much of the ink under this stroke it takes away, 0..1. Omitted means
     * all of it — the plain area eraser.
     *
     * A partial value is what makes a FADE erase possible without touching the
     * ink: the stroke is stored as it was drawn and the ink underneath keeps its
     * geometry, so rubbing the same spot again simply lays down another stroke
     * and the two multiply. Cutting the ink instead — splitting every path the
     * eraser crosses, pass after pass — is what shattered a much-erased area
     * into hairline pieces.
     */
    alpha?: number;
}

export interface LayerData {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity?: number;
    eraserPaths?: EraserPath[];
}

export interface ImportedImage {
    id: string;
    src: string; // Base64 data URL
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
    layerId?: string;
    /** Radians. Optional so older saves still load. */
    rotation?: number;
}

export interface PathData {
    /** Stable identity for spatial-index bookkeeping (erase grid). Assigned at
     * creation and to every split piece; ensured on load. Omitted by very old
     * saves — the erase grid assigns one lazily. Not part of the SVG output. */
    id?: string;
    d: string;
    stroke: string;
    fill: string;
    strokeWidth: number;
    fillRule?: 'nonzero' | 'evenodd';
    freehandSource?: {
        points: [number, number, number][];
        options: {
            size: number;
            thinning: number;
            smoothing: number;
            streamline: number;
            simulatePressure?: boolean;
        };
    };
    /** Set on pieces emitted by the clip-erase split. Their `d` is clip
     * output (normalized winding: holes opposite the outer), so later erases
     * can rebuild the fill geometry with `union` (idempotent for clip output)
     * and apply the freehand-grade artifact guards — without this, a piece
     * loses `freehandSource` on its first split and every later erase ran
     * unguarded, letting corrupted difference results (dropped holes →
     * spurious solid fills) into the drawing. */
    clipDerived?: boolean;
    /**
     * This piece is ink a fade eraser dimmed — not merely ink that happens to
     * be translucent.
     *
     * The stack flattener needs to tell those apart and cannot do it from
     * opacity: a highlighter is BORN below 1, so "opacity < 1" swept untouched
     * highlighter into the flatten and collapsed it together with ink that had
     * actually been rubbed, changing bands the eraser never went near.
     */
    faded?: boolean;
    /**
     * Which fade sweep last dimmed this ink.
     *
     * Fading is not idempotent, and consecutive chunks of one rub overlap —
     * each sweeps a radius past its own ends — so a chunked straight rub would
     * otherwise dim the same ink two or three times at every seam. Ink stamped
     * with the sweep in progress is left alone, which is what lets fade commit
     * on the same responsive travel cadence as cutting instead of waiting for
     * the pointer to reverse.
     *
     * A reversal starts a new sweep and a new stamp, so scrubbing back over ink
     * still compounds — see `FadeOptions.accumulate`.
     */
    fadeSweepId?: number;
    /**
     * This piece already stands in for a whole pile of ink, not one layer of it.
     *
     * Flattening de-overlaps same-ink faded pieces so a rubbed patch is covered
     * exactly once. That is invisible for OPAQUE ink — one black layer looks
     * like four — but translucent ink composites, so four highlighter passes at
     * 0.34 read as 0.81, and covering the patch once at 0.34 throws the depth
     * away. The survivor therefore carries the pile's opacity rather than its
     * own, and this marks it as having done so: a later rub must not fold the
     * same depth in a second time.
     */
    fadeFlattened?: boolean;
    /**
     * The id of the stroke this piece descends from, carried through every
     * fade and split.
     *
     * Flattening needs to know how DEEP the ink under the rub is, and the
     * count of overlapping pieces does not say: two chunks of one rub overlap
     * at their seam without the ink being two layers deep. Pieces that trace
     * back to the same stroke are one thickness however many they are, so
     * counting distinct origins is what separates a genuine pile from a seam.
     */
    fadeOrigin?: string;
    transform?: string;
    bakeGroupId?: string;
    layerId?: string;
    /** 0..1, omitted when fully opaque. */
    opacity?: number;
    /** CSS mix-blend-mode, omitted when 'normal' (e.g. 'multiply' for highlighter). */
    blendMode?: string;
    clipRect?: { x: number, y: number, width: number, height: number };
}

// The polygon structural types the clip/erase pipeline operates on
// (`Ring`, `Polygon`, `MultiPolygon`) come from `polygon-clipping` — the
// Martinez engine used as the fallback in `clipping.ts`. Re-exported here so
// consumers can import the drawing model and the geometry types from one place.
export type { Ring, Polygon, MultiPolygon } from 'polygon-clipping';