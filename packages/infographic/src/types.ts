export const IGFX_FORMAT = 'igfx' as const;
export const IGFX_SCHEMA_VERSION = 1;

export const DEFAULT_ARTBOARD_WIDTH = 1920;
export const DEFAULT_ARTBOARD_HEIGHT = 1080;
export const DEFAULT_DURATION_MS = 8000;
export const DEFAULT_EXPORT_FPS = 30;
export const DEFAULT_EXPORT_BITRATE = '1M';

/** v1 hard cap; UI refuses paste above this. */
export const MAX_DATASET_ROWS = 500;
export const MAX_DATASET_COLUMNS = 20;

export const ARTBOARD_PRESETS = [
	{ id: 'hd', width: 1920, height: 1080, label: 'Full HD' },
	{ id: 'square', width: 1080, height: 1080, label: 'Square' },
	{ id: 'portrait', width: 1080, height: 1350, label: 'Portrait' }
] as const;

export type FieldType = 'number' | 'string' | 'time';

export interface DatasetColumn {
	id: string;
	label: string;
	type: FieldType;
}

export interface Dataset {
	id: string;
	label: string;
	columns: DatasetColumn[];
	rows: Record<string, string | number | null>[];
}

export interface Scalar {
	id: string;
	label: string;
	type: FieldType | 'boolean';
	value: string | number | boolean | null;
}

export interface BindingRef {
	/** `dataset:<id>.<column>` or `scalar:<id>` */
	ref: string;
}

export type Theme = {
	palette: string[];
	background: string;
	surface: string;
	text: string;
	muted: string;
	grid: string;
	/** `string`. v1 default / only allowed value: system stack (no webfonts). */
	fontFamily: string;
	fontMono: string;
	radius: number;
};

export type MarkKind = 'bar' | 'line' | 'stat' | 'text' | 'legend' | 'axis';

export const MARK_KINDS: readonly MarkKind[] = ['bar', 'line', 'stat', 'text', 'legend', 'axis'];

export interface Mark {
	id: string;
	kind: MarkKind;
	layout: { x: number; y: number; w: number; h: number };
	bindings: Record<string, BindingRef | string | number>;
	style?: Record<string, string | number | boolean>;
}

export interface MotionKeyframe {
	tMs: number;
	value: number;
	easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}

export interface MotionTrack {
	id: string;
	/** `mark:<id>.<prop>` e.g. `mark:bars.progress`, `mark:title.opacity` */
	target: string;
	keyframes: MotionKeyframe[];
}

export interface IgfxTimeline {
	durationMs: number;
	posterMs: number;
	tracks: MotionTrack[];
}

/** Footage under the graphic. VFS video node. Optional. */
export interface MediaBed {
	nodeId: string;
	offsetMs: number;
	durationMs: number;
}

export interface LastExport {
	svgNodeId?: string;
	mp4NodeId?: string;
	fps: number;
	bitrate: string;
	width?: number;
	height?: number;
}

export interface IgfxDocument {
	format: typeof IGFX_FORMAT;
	schemaVersion: number;
	name: string;
	artboard: { width: number; height: number };
	theme: Theme;
	datasets: Dataset[];
	scalars: Scalar[];
	marks: Mark[];
	timeline: IgfxTimeline;
	mediaBed?: MediaBed;
	lastExport?: LastExport;
}

export interface ResolvedNode {
	id: string;
	tag: 'g' | 'rect' | 'path' | 'text' | 'line' | 'circle' | 'clipPath';
	attrs: Record<string, string>;
	text?: string;
	children?: ResolvedNode[];
}

export interface ResolvedFrame {
	width: number;
	height: number;
	background: string;
	nodes: ResolvedNode[];
	warnings: string[];
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	warnings: string[];
}
