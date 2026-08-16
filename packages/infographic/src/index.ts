export {
	ARTBOARD_PRESETS,
	DEFAULT_ARTBOARD_HEIGHT,
	DEFAULT_ARTBOARD_WIDTH,
	DEFAULT_DURATION_MS,
	DEFAULT_EXPORT_BITRATE,
	DEFAULT_EXPORT_FPS,
	IGFX_FORMAT,
	IGFX_SCHEMA_VERSION,
	MARK_KINDS,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	SCENE3D_EXPORT_FPS,
	type AnyMark,
	type BindingRef,
	type Dataset,
	type DatasetColumn,
	type FieldType,
	type IgfxDocument,
	type IgfxTimeline,
	type LastExport,
	type Mark,
	type MarkKind,
	type MediaBed,
	type MotionKeyframe,
	type MotionTrack,
	type ResolvedFrame,
	type ResolvedNode,
	type Scalar,
	type Scene3dCamera,
	type Scene3dMark,
	type Scene3dObject,
	type Theme,
	type ValidationResult
} from './types.js';

export {
	createDocument,
	defaultDocument,
	defaultTimeline,
	IgfxParseError,
	parseIgfx,
	serializeIgfx,
	validate
} from './schema.js';

export { DEFAULT_FONT_FAMILY, DEFAULT_FONT_MONO, DEFAULT_PALETTE, defaultTheme } from './theme.js';

export { instantiateTemplate, listTemplates, TEMPLATE_IDS, type TemplateId, type TemplateInfo } from './templates.js';

export { resolve } from './resolve.js';

export { escapeXml, rasterize, renderSvg } from './render.js';

export {
	applyBar3dHeights,
	bakeFpsFor,
	bakeSignature,
	clearBakeCache,
	defaultScene3dMark,
	documentHasScene3d,
	ensureBaked,
	ensureDocumentBaked,
	getBakeAdapter,
	isScene3dMark,
	markWithBoundValues,
	peekBake,
	peekLastBake,
	scene3dBoundValues,
	setBakeAdapter,
	type BakedPath,
	type BakeAdapter,
	type Live3dContext
} from './bakeAdapter.js';
