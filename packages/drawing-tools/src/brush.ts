import type { PathData } from './types.ts';
import { generateId } from './id.ts';

export type BrushType = 'pen' | 'pencil' | 'highlighter';
export type PencilGrade = '2H' | 'H' | 'HB' | 'B' | '2B' | '4B';

export interface BrushParams {
	opacity: number;
	blendMode: 'normal' | 'multiply';
	widthMult: number;
	thinning: number;
	smoothing: number;
	streamline: number;
}

export const PENCIL_GRADES: readonly PencilGrade[] = ['2H', 'H', 'HB', 'B', '2B', '4B'];

const PENCIL_GRADE_PARAMS: Record<PencilGrade, BrushParams> = {
	'2H': { opacity: 0.2, blendMode: 'multiply', widthMult: 0.72, thinning: 0.2, smoothing: 0.32, streamline: 0.26 },
	H: { opacity: 0.26, blendMode: 'multiply', widthMult: 0.78, thinning: 0.25, smoothing: 0.34, streamline: 0.3 },
	HB: { opacity: 0.34, blendMode: 'multiply', widthMult: 0.84, thinning: 0.3, smoothing: 0.35, streamline: 0.33 },
	B: { opacity: 0.44, blendMode: 'multiply', widthMult: 0.9, thinning: 0.34, smoothing: 0.36, streamline: 0.34 },
	'2B': { opacity: 0.55, blendMode: 'multiply', widthMult: 0.96, thinning: 0.38, smoothing: 0.38, streamline: 0.36 },
	'4B': { opacity: 0.68, blendMode: 'multiply', widthMult: 1.04, thinning: 0.42, smoothing: 0.4, streamline: 0.38 }
};

export function normalizePencilGrade(grade: unknown): PencilGrade {
	return PENCIL_GRADES.includes(grade as PencilGrade) ? grade as PencilGrade : 'HB';
}

export function pencilGradeParams(grade: PencilGrade): BrushParams {
	return PENCIL_GRADE_PARAMS[grade];
}

/**
 * `highlighterOpacity` overrides the highlighter's nominal opacity (default
 * 0.5 — bumped up from the original 0.35, which read as too faint) with a
 * user-configured strength. Ignored for every other brush type.
 */
export function brushParams(brushType: BrushType, pencilGrade: PencilGrade = 'HB', highlighterOpacity?: number): BrushParams {
	switch (brushType) {
		case 'pencil':
			return pencilGradeParams(normalizePencilGrade(pencilGrade));
		case 'highlighter':
			// Source-over, not multiply. Multiply against already-committed opaque
			// ink (Cs*Cd) turns the marker black wherever it crosses a pen, so the
			// stroke looks like it dropped under the ink the moment the pointer
			// lifts. The live preview is an SVG overlay composited on top of the
			// raster canvases, so mix-blend-mode never sees those pixels and the
			// marker stays on top while drawing. Source-over + opacity matches
			// that lift: highlighter sits on top, ink still shows through.
			// Overlapping marker strokes still darken via stacked alpha (and
			// markerBuildUp splits scribbles into separate paths).
			return { opacity: highlighterOpacity ?? 0.5, blendMode: 'normal', widthMult: 4, thinning: 0, smoothing: 0.6, streamline: 0.5 };
		default:
			return { opacity: 1, blendMode: 'normal', widthMult: 1, thinning: 0.6, smoothing: 0.5, streamline: 0.5 };
	}
}

export function effectiveStrokeWidth(baseStrokeWidth: number, brushType: BrushType, pencilGrade: PencilGrade = 'HB') {
	return baseStrokeWidth * brushParams(brushType, pencilGrade).widthMult;
}

export function brushMaterialProps(brushType: BrushType, pencilGrade: PencilGrade = 'HB', highlighterOpacity?: number): Partial<PathData> {
	const { opacity, blendMode } = brushParams(brushType, pencilGrade, highlighterOpacity);
	const props: Partial<PathData> = {};
	if (opacity !== 1) props.opacity = opacity;
	if (blendMode !== 'normal') props.blendMode = blendMode;
	return props;
}

/**
 * Pressure-driven opacity for the translucent brushes (pencil & marker) in
 * pressure mode. Light press is intentionally lighter than the brush's nominal
 * opacity (a reduced baseline, so there's headroom to SEE the darkening as you
 * press harder); full press reaches the nominal opacity (the darkness you get
 * today without pressure). Pen is opaque (opacity 1) regardless of pressure, so
 * this is only meaningful for pencil/marker — callers gate on brush type.
 *
 * `p` is clamped to 0..1. The baseline floor keeps very-light pressure from going
 * fully transparent (a faint ghost of the stroke should still read).
 */
export function pressureStrokeOpacity(p: number, brushType: BrushType, pencilGrade: PencilGrade = 'HB', highlighterOpacity?: number): number {
	const nominal = brushParams(brushType, pencilGrade, highlighterOpacity).opacity;
	// Pen (and any fully-opaque brush) stays opaque regardless of pressure — only
	// the multiply-blend brushes (pencil/marker) get the reduced-baseline ramp.
	if (nominal >= 1) return 1;
	const min = Math.max(0.1, nominal * 0.35);
	return min + (nominal - min) * Math.max(0, Math.min(1, p));
}

export function buildBasicStrokePath(
	d: string,
	stroke: string,
	baseStrokeWidth: number,
	layerId: string,
	brushType: BrushType,
	pencilGrade: PencilGrade = 'HB',
	highlighterOpacity?: number
): PathData {
	return {
		id: generateId(),
		d,
		stroke,
		fill: 'none',
		strokeWidth: effectiveStrokeWidth(baseStrokeWidth, brushType, pencilGrade),
		layerId,
		...brushMaterialProps(brushType, pencilGrade, highlighterOpacity)
	};
}

export function buildStrokeSegmentPath(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	width: number,
	stroke: string,
	layerId: string,
	brushType: BrushType,
	pencilGrade: PencilGrade = 'HB',
	highlighterOpacity?: number
): PathData {
	return {
		id: generateId(),
		d: `M ${x1} ${y1} L ${x2} ${y2}`,
		stroke,
		fill: 'none',
		strokeWidth: width,
		layerId,
		...brushMaterialProps(brushType, pencilGrade, highlighterOpacity)
	};
}

export function buildFreehandStrokePath(
	d: string,
	fill: string,
	layerId: string,
	brushType: BrushType,
	source?: PathData['freehandSource'],
	pencilGrade: PencilGrade = 'HB',
	opacity?: number,
	highlighterOpacity?: number
): PathData {
	return {
		id: generateId(),
		d,
		stroke: 'none',
		fill,
		strokeWidth: 0,
		layerId,
		...(source ? { freehandSource: source } : {}),
		...brushMaterialProps(brushType, pencilGrade, highlighterOpacity),
		...(opacity !== undefined ? { opacity } : {})
	};
}
