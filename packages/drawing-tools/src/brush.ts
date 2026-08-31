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
 * `inkOpacity` is the user-set strength for highlighter, and for pen when
 * translucent ink is on. Pencil still uses the grade table. Omit it (or pass
 * `undefined`) to keep each brush's default — pen stays fully opaque.
 *
 * Highlighter (and wash pen) are source-over, not multiply. Multiply against
 * already-committed opaque ink (Cs*Cd) turns the stroke black wherever it
 * crosses a pen, so it looks like it dropped under the ink the moment the
 * pointer lifts. Source-over + opacity matches the live overlay: the stroke
 * sits on top, ink still shows through. Overlapping passes still darken via
 * stacked alpha.
 */
export function brushParams(brushType: BrushType, pencilGrade: PencilGrade = 'HB', inkOpacity?: number): BrushParams {
	switch (brushType) {
		case 'pencil':
			return pencilGradeParams(normalizePencilGrade(pencilGrade));
		case 'highlighter':
			return { opacity: inkOpacity ?? 0.5, blendMode: 'normal', widthMult: 4, thinning: 0, smoothing: 0.6, streamline: 0.5 };
		default:
			return { opacity: inkOpacity ?? 1, blendMode: 'normal', widthMult: 1, thinning: 0.6, smoothing: 0.5, streamline: 0.5 };
	}
}

export function effectiveStrokeWidth(baseStrokeWidth: number, brushType: BrushType, pencilGrade: PencilGrade = 'HB') {
	return baseStrokeWidth * brushParams(brushType, pencilGrade).widthMult;
}

export function brushMaterialProps(brushType: BrushType, pencilGrade: PencilGrade = 'HB', inkOpacity?: number): Partial<PathData> {
	const { opacity, blendMode } = brushParams(brushType, pencilGrade, inkOpacity);
	const props: Partial<PathData> = {};
	if (opacity !== 1) props.opacity = opacity;
	if (blendMode !== 'normal') props.blendMode = blendMode;
	return props;
}

/**
 * Pressure-driven opacity for brushes whose nominal opacity is below 1
 * (pencil, marker, and wash pen). Light press is lighter than the nominal
 * (a reduced baseline, so there's headroom to SEE the darkening as you press
 * harder); full press reaches the nominal. Fully opaque ink (default pen)
 * stays 1 regardless of pressure.
 *
 * `p` is clamped to 0..1. The baseline floor keeps very-light pressure from going
 * fully transparent (a faint ghost of the stroke should still read).
 */
export function pressureStrokeOpacity(p: number, brushType: BrushType, pencilGrade: PencilGrade = 'HB', inkOpacity?: number): number {
	const nominal = brushParams(brushType, pencilGrade, inkOpacity).opacity;
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
	inkOpacity?: number
): PathData {
	return {
		id: generateId(),
		d,
		stroke,
		fill: 'none',
		strokeWidth: effectiveStrokeWidth(baseStrokeWidth, brushType, pencilGrade),
		layerId,
		...brushMaterialProps(brushType, pencilGrade, inkOpacity)
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
	inkOpacity?: number
): PathData {
	return {
		id: generateId(),
		d: `M ${x1} ${y1} L ${x2} ${y2}`,
		stroke,
		fill: 'none',
		strokeWidth: width,
		layerId,
		...brushMaterialProps(brushType, pencilGrade, inkOpacity)
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
	inkOpacity?: number
): PathData {
	return {
		id: generateId(),
		d,
		stroke: 'none',
		fill,
		strokeWidth: 0,
		layerId,
		...(source ? { freehandSource: source } : {}),
		...brushMaterialProps(brushType, pencilGrade, inkOpacity),
		...(opacity !== undefined ? { opacity } : {})
	};
}
