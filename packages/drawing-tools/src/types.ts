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

export type LayerKind = 'vector' | 'raster' | 'svg' | 'pdf';

/** Native SVG primitives stored on an `kind: 'svg'` layer. Not PathData ink. */
export type SvgLineElement = {
    type: 'line';
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    stroke: string;
    strokeWidth: number;
    opacity?: number;
};

export type SvgPathElement = {
    type: 'path';
    id: string;
    d: string;
    stroke: string;
    fill: string;
    strokeWidth: number;
    fillRule?: 'nonzero' | 'evenodd';
    opacity?: number;
};

export type SvgElement = SvgLineElement | SvgPathElement;

export type PdfTransform = { x: number; y: number; rotation?: number; sx?: number; sy?: number };

export type PdfTextElement = {
    type: 'text';
    id: string;
    str: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    fontSize: number;
    d: string;
    transform?: PdfTransform;
    opacity?: number;
};
export type PdfImageElement = {
    type: 'image';
    id: string;
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
    transform?: PdfTransform;
    opacity?: number;
};
export type PdfPathElement = {
    type: 'path';
    id: string;
    d: string;
    fill: string;
    stroke: string;
    strokeWidth: number;
    fillRule?: 'nonzero' | 'evenodd';
    transform?: PdfTransform;
    opacity?: number;
};
export type PdfGroupElement = {
    type: 'group';
    id: string;
    children: PdfElement[];
    transform?: PdfTransform;
    opacity?: number;
};
export type PdfRasterChip = {
    type: 'chip';
    id: string;
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
    transform?: PdfTransform;
};
export type PdfElement =
    | PdfTextElement
    | PdfImageElement
    | PdfPathElement
    | PdfGroupElement
    | PdfRasterChip;

export interface LayerData {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity?: number;
    eraserPaths?: EraserPath[];
    /**
     * Ink model for this layer. Missing on older saves — treat as `'vector'`.
     * Raster layers persist a page-aspect bitmap (`rasterSrc` + pixel size).
     * SVG layers persist native elements (`svgElements`).
     * PDF layers persist interpreted page elements (`pdfElements`).
     * There is no convert-either-way.
     */
    kind?: LayerKind;
    /** Pixel columns of a raster plate. Ignored on vector layers. */
    rasterWidth?: number;
    /** Pixel rows of a raster plate. Aspect-locked to the page. */
    rasterHeight?: number;
    /** PNG/WebP data URL of the raster plate. Ignored on vector layers. */
    rasterSrc?: string;
    /** Native SVG elements. Ignored on vector/raster layers. */
    svgElements?: SvgElement[];
    /** Interpreted PDF page elements. Ignored on vector/raster/svg layers. */
    pdfElements?: PdfElement[];
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
     * The id of the ORIGINAL stroke this piece was cut from, carried down
     * every split so a stroke's pieces stay identifiable as one another's
     * siblings however many passes have cut them.
     *
     * Seeded at the first split (`parent.fadeOrigin ?? parent.id`) and
     * inherited thereafter. Siblings at one strength are a PARTITION of that
     * original — disjoint by construction — which is what makes it safe to put
     * them back in a single path element; see `mergeFadedSiblings`.
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