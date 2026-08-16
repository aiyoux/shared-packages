export type TracerId = 'vtracer' | 'potrace';

export type VtracerPreset = 'bw' | 'poster' | 'photo';
export type VtracerClustering = 'color-cluster' | 'bw' | 'watershed';
export type VtracerHierarchical = 'stacked' | 'cutout';
export type VtracerFitMode = 'pixel' | 'polygon' | 'spline';

export type VtracerOptions = {
	preset?: VtracerPreset;
	clustering?: VtracerClustering;
	hierarchical?: VtracerHierarchical;
	mode?: VtracerFitMode;
	/** Discard patches smaller than this side length in px (0–128). */
	filterSpeckle?: number;
	/** Significant bits per RGB channel (1–8). */
	colorPrecision?: number;
	/** Color difference between gradient layers (0–255). */
	layerDifference?: number;
	/** Corner threshold in degrees (0–180). */
	cornerThreshold?: number;
	/** Segment length threshold in px (3.5–10). */
	lengthThreshold?: number;
	maxIterations?: number;
	/** Splice threshold in degrees (0–180). */
	spliceThreshold?: number;
	/** Curve simplification tolerance in px. 0 = off. Spline mode only. */
	simplify?: number;
	/** Decimal places in path coordinates. */
	pathPrecision?: number;
	/** Fixed palette as #rrggbb tokens. */
	palette?: string[];
	/** Auto-quantize to at most N colors. 0 = off. */
	maxColors?: number;
	/** 0 = off, 1 = quantize+cleanup, 2 = + SVG shorthands. */
	optimize?: 0 | 1 | 2;
	/** Binary fixed threshold (0–255). */
	binaryThreshold?: number;
	/** Bradley–Roth adaptive threshold for uneven scans. */
	adaptive?: boolean;
	/** Adaptive window in px; 0 = auto. */
	adaptiveWindow?: number;
	/** Adaptive sensitivity: % below local mean (default 15). */
	adaptiveT?: number;
	/** Watershed hierarchy cut (0–255). Higher = more regions. */
	watershedDetail?: number;
};

export type PotraceTurnPolicy = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type PotraceOptions = {
	/** Ignore speckles of this size (px). */
	turdsize?: number;
	/** 0 black, 1 white, 2 left, 3 right, 4 minority, 5 majority, 6 random. */
	turnpolicy?: PotraceTurnPolicy;
	/** Corner threshold (0–1.334). Lower = more corners. */
	alphamax?: number;
	/** Curve optimization on/off. */
	opticurve?: boolean;
	/** Curve optimization tolerance. */
	opttolerance?: number;
	pathonly?: boolean;
	extractcolors?: boolean;
	posterizelevel?: number;
	/** 0 simple, 1 interpolation. */
	posterizationalgorithm?: 0 | 1;
};

export type TracerInfo = {
	id: TracerId;
	label: string;
	description: string;
};

export const TRACER_CATALOG: readonly TracerInfo[] = [
	{
		id: 'vtracer',
		label: 'VTracer 1.0',
		description:
			'Color and B&W tracing with spline fit, curve simplification, cutout, and watershed. MIT/Apache WASM.'
	},
	{
		id: 'potrace',
		label: 'Potrace',
		description:
			'Classic B&W (or posterized color) silhouettes. GPL-2.0 WASM used by SVGcode.'
	}
] as const;

export const DEFAULT_VTRACER: Required<
	Omit<VtracerOptions, 'preset' | 'palette' | 'maxColors'>
> & {
	preset: VtracerPreset;
	palette: string;
	maxColors: number;
} = {
	preset: 'poster',
	clustering: 'color-cluster',
	hierarchical: 'stacked',
	mode: 'spline',
	filterSpeckle: 4,
	colorPrecision: 8,
	layerDifference: 16,
	cornerThreshold: 60,
	lengthThreshold: 4,
	maxIterations: 10,
	spliceThreshold: 45,
	simplify: 1.5,
	pathPrecision: 2,
	palette: '',
	maxColors: 0,
	optimize: 1,
	binaryThreshold: 128,
	adaptive: false,
	adaptiveWindow: 0,
	adaptiveT: 15,
	watershedDetail: 128
};

export const VTRACER_PRESETS: Record<
	VtracerPreset,
	Partial<typeof DEFAULT_VTRACER>
> = {
	bw: {
		preset: 'bw',
		clustering: 'bw',
		hierarchical: 'stacked',
		mode: 'spline',
		filterSpeckle: 4,
		colorPrecision: 6,
		layerDifference: 16,
		cornerThreshold: 60,
		lengthThreshold: 4,
		spliceThreshold: 45,
		simplify: 1.5
	},
	poster: {
		preset: 'poster',
		clustering: 'color-cluster',
		hierarchical: 'stacked',
		mode: 'spline',
		filterSpeckle: 4,
		colorPrecision: 8,
		layerDifference: 16,
		cornerThreshold: 60,
		lengthThreshold: 4,
		spliceThreshold: 45,
		simplify: 1.5
	},
	photo: {
		preset: 'photo',
		clustering: 'color-cluster',
		hierarchical: 'stacked',
		mode: 'spline',
		filterSpeckle: 10,
		colorPrecision: 8,
		layerDifference: 48,
		cornerThreshold: 180,
		lengthThreshold: 4,
		spliceThreshold: 45,
		simplify: 1.5
	}
};

export const DEFAULT_POTRACE: Required<PotraceOptions> = {
	turdsize: 2,
	turnpolicy: 4,
	alphamax: 1,
	opticurve: true,
	opttolerance: 0.2,
	pathonly: false,
	extractcolors: true,
	posterizelevel: 2,
	posterizationalgorithm: 0
};

export type VectorizeInput = {
	data: ImageData;
	width: number;
	height: number;
};

export type VectorizedImage = {
	name: string;
	svg: string;
	data: Uint8Array;
	width: number;
	height: number;
	sourceBytes: number;
	sourceWidth: number;
	sourceHeight: number;
	tracer: TracerId;
};

export function parsePalette(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => (t.startsWith('#') ? t : `#${t}`));
}

export function suggestSvgName(sourceName: string): string {
	const base = sourceName.replace(/\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i, '') || 'image';
	return `${base}.svg`;
}
