export {
	ANIMATABLE_PROPS,
	ARTBOARD_PRESETS,
	BUILT_KINDS,
	DEFAULT_ARTBOARD_HEIGHT,
	DEFAULT_ARTBOARD_WIDTH,
	DEFAULT_DURATION_MS,
	DEFAULT_EXPORT_BITRATE,
	DEFAULT_EXPORT_FPS,
	IGFX_FORMAT,
	IGFX_SCHEMA_VERSION,
	IGFX_SCHEMA_VERSION_V1,
	MARK_KINDS,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	MAX_KEYS_PER_CURVE,
	MAX_OBJECTS_PER_SCENE,
	MAX_POINTS_PER_SERIES,
	MAX_SCENES,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	OBJECT_KINDS,
	PRESET_KINDS,
	SCENE3D_EXPORT_FPS,
	type AnimatableProp,
	type AnyMark,
	type BindingRef,
	type BuiltKind,
	type Dataset,
	type DatasetColumn,
	type FieldType,
	type IgfxDocument,
	type IgfxObject,
	type IgfxScene,
	type IgfxTimeline,
	type LastExport,
	type Mark,
	type MarkKind,
	type MediaBed,
	type MotionKeyframe,
	type MotionTrack,
	type ObjectKind,
	type ObjectTransform,
	type PathSpec,
	type PointSpec,
	type PresetKind,
	type PropertyCurve,
	type ResolvedFrame,
	type ResolvedNode,
	type Scalar,
	type Scene3dCamera,
	type Scene3dMark,
	type Scene3dObject,
	type SceneCamera2d,
	type SceneTimeline,
	type SceneTrack,
	type SeriesMode,
	type SeriesSpec,
	type ShapePrimitive,
	type ShapeSpec,
	type Theme,
	type ValidationResult
} from './types.js';

export {
	compositionSpanMs,
	createDocument,
	createScene,
	createTake,
	defaultDocument,
	defaultTimeline,
	effectiveArtboard,
	effectiveTheme,
	getActiveScene,
	getActiveTake,
	IgfxParseError,
	newId,
	parseIgfx,
	serializeIgfx,
	validate
} from './schema.js';

export { isV1, migrateV1ToV2 } from './migrate.js';

export { DEFAULT_FONT_FAMILY, DEFAULT_FONT_MONO, DEFAULT_PALETTE, defaultTheme } from './theme.js';

export {
	instantiateSceneTemplate,
	instantiateTemplate,
	listTemplates,
	TEMPLATE_IDS,
	type TemplateId,
	type TemplateInfo
} from './templates.js';

export { resolve, resolveScene } from './resolve.js';

export {
	applyEasing,
	objectVisible,
	sampleKeyframes,
	sampleTake,
	sampleTrack,
	trackCovers,
	type MarkMotion,
	type ObjectSample
} from './motion.js';

export {
	ancestorsOf,
	childrenOf,
	hasParentCycle,
	objectToMark,
	reparent,
	subtreeIds,
	wouldCreateCycle,
	worldTransforms,
	type WorldXform
} from './objects.js';

export { bindMark, bindObject, type BoundMark, type BoundSeries } from './bindings.js';

export { escapeXml, rasterize, renderSvg } from './render.js';

export {
	applyBar3dHeights,
	bakeFpsFor,
	bakeSignature,
	clearBakeCache,
	defaultScene3dMark,
	defaultScene3dObject,
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
