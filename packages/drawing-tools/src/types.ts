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