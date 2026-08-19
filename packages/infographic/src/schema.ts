import { isV1, migrateV1ToV2 } from './migrate.js';
import { defaultTheme, mergeTheme } from './theme.js';
import {
	ANIMATABLE_PROPS,
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
	MAX_KEYS_PER_CURVE,
	MAX_OBJECTS_PER_SCENE,
	MAX_POINTS_PER_SERIES,
	MAX_SCENES,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	OBJECT_KINDS,
	PRESET_KINDS,
	type AnimatableProp,
	type AnyMark,
	type BindingRef,
	type Dataset,
	type DatasetColumn,
	type FieldType,
	type IgfxDocument,
	type IgfxObject,
	type IgfxScene,
	type IgfxTimeline,
	type LastExport,
	type Mark,
	type MediaBed,
	type MotionKeyframe,
	type MotionTrack,
	type MarkKind,
	type ObjectKind,
	type ObjectTransform,
	type PresetKind,
	type PathSpec,
	type PointSpec,
	type PropertyCurve,
	type Scalar,
	type Scene3dCamera,
	type Scene3dMark,
	type Scene3dObject,
	type SceneCamera2d,
	type SceneTimeline,
	type SceneTrack,
	type SeriesSpec,
	type ShapeSpec,
	type Theme,
	type ValidationResult
} from './types.js';

export class IgfxParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IgfxParseError';
	}
}

export function newId(prefix: string): string {
	const uuid =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${uuid}`;
}

export function defaultTimeline(durationMs = DEFAULT_DURATION_MS): IgfxTimeline {
	return {
		durationMs,
		posterMs: durationMs,
		tracks: []
	};
}

export function createTake(name = 'Take 1', durationMs = DEFAULT_DURATION_MS): SceneTimeline {
	return { id: newId('take'), name, durationMs, posterMs: durationMs, tracks: [] };
}

export function createScene(name = 'Scene'): IgfxScene {
	const take = createTake('Take 1');
	return {
		id: newId('scene'),
		name,
		objects: [],
		timelines: [take],
		activeTimelineId: take.id
	};
}

export function createDocument(name = 'Untitled'): IgfxDocument {
	const scene = createScene('Scene');
	return {
		format: IGFX_FORMAT,
		schemaVersion: IGFX_SCHEMA_VERSION,
		name,
		artboard: { width: DEFAULT_ARTBOARD_WIDTH, height: DEFAULT_ARTBOARD_HEIGHT },
		theme: defaultTheme(),
		datasets: [],
		scalars: [],
		scenes: [scene],
		activeSceneId: scene.id
	};
}

export function defaultDocument(): IgfxDocument {
	return createDocument();
}

export function getActiveScene(doc: IgfxDocument): IgfxScene {
	return doc.scenes.find((s) => s.id === doc.activeSceneId) ?? doc.scenes[0] ?? createScene('Scene');
}

export function getActiveTake(scene: IgfxScene): SceneTimeline {
	return (
		scene.timelines.find((t) => t.id === scene.activeTimelineId) ??
		scene.timelines[0] ??
		createTake()
	);
}

export function effectiveArtboard(
	doc: IgfxDocument,
	scene: IgfxScene
): { width: number; height: number } {
	return scene.artboard ?? doc.artboard;
}

export function effectiveTheme(doc: IgfxDocument, scene: IgfxScene): Theme {
	const base = doc.theme;
	const o = scene.themeOverride;
	if (!o) return base;
	return {
		...base,
		...o,
		palette: o.palette && o.palette.length > 0 ? o.palette : base.palette
	};
}

export function compositionSpanMs(doc: IgfxDocument): number {
	const scene = getActiveScene(doc);
	const take = getActiveTake(scene);
	return Math.max(take.durationMs, scene.mediaBed?.durationMs ?? 0);
}

const PRESET_KIND_SET = new Set<string>(PRESET_KINDS);

function isPresetKind(kind: ObjectKind): kind is PresetKind {
	return PRESET_KIND_SET.has(kind);
}

function objectToMark(obj: IgfxObject): AnyMark | null {
	if (!isPresetKind(obj.kind)) return null;
	const layout = {
		x: obj.transform.x,
		y: obj.transform.y,
		w: obj.transform.w,
		h: obj.transform.h
	};
	if (obj.kind === 'scene3d') {
		const mark: Scene3dMark = {
			id: obj.id,
			kind: 'scene3d',
			layout,
			scene: obj.scene ?? {
				objects: [],
				camera: { position: [2, 2, 2], target: [0, 0, 0], fov: 50 }
			},
			bindings: {}
		};
		if (obj.bindings && isRecord(obj.bindings.values) && typeof obj.bindings.values.ref === 'string') {
			mark.bindings.values = { ref: obj.bindings.values.ref };
		}
		if (obj.style) mark.style = obj.style;
		return mark;
	}
	const mark: Mark = {
		id: obj.id,
		kind: obj.kind as MarkKind,
		layout,
		bindings: obj.bindings ?? {}
	};
	if (obj.style) mark.style = obj.style;
	return mark;
}

/**
 * Temporary read adapter until resolve walks the object tree.
 * Active scene + take only. Not a write API — `layout` is a detached copy of `transform`.
 */
export function v1View(doc: IgfxDocument): {
	marks: AnyMark[];
	timeline: IgfxTimeline;
	mediaBed?: MediaBed;
} {
	const scene = getActiveScene(doc);
	const take = getActiveTake(scene);
	const marks: AnyMark[] = [];
	for (const obj of scene.objects) {
		const mark = objectToMark(obj);
		if (mark) marks.push(mark);
	}
	const tracks: MotionTrack[] = [];
	for (const track of take.tracks) {
		for (const curve of track.curves) {
			tracks.push({
				id: curve.id,
				target: `mark:${track.objectId}.${curve.prop}`,
				keyframes: curve.keyframes
			});
		}
	}
	const out: { marks: AnyMark[]; timeline: IgfxTimeline; mediaBed?: MediaBed } = {
		marks,
		timeline: {
			durationMs: take.durationMs,
			posterMs: take.posterMs,
			tracks
		}
	};
	if (scene.mediaBed) out.mediaBed = scene.mediaBed;
	return out;
}

export function serializeIgfx(doc: IgfxDocument): string {
	const body: Record<string, unknown> = {
		format: IGFX_FORMAT,
		schemaVersion: IGFX_SCHEMA_VERSION,
		name: doc.name,
		artboard: doc.artboard,
		theme: doc.theme,
		datasets: doc.datasets,
		scalars: doc.scalars,
		scenes: doc.scenes,
		activeSceneId: doc.activeSceneId
	};
	if (doc.lastExport) body.lastExport = doc.lastExport;
	return JSON.stringify(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFinite(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

const FIELD_TYPES = new Set<FieldType>(['number', 'string', 'time']);
const SCALAR_TYPES = new Set<FieldType | 'boolean'>(['number', 'string', 'time', 'boolean']);
const EASINGS = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
const MARK_KIND_SET = new Set<string>(MARK_KINDS);
const OBJECT_KIND_SET = new Set<string>(OBJECT_KINDS);
const ANIMATABLE_SET = new Set<string>(ANIMATABLE_PROPS);
const SCENE3D_PRIMITIVES = new Set(['box', 'sphere', 'cylinder', 'bar3d']);

function parseColumn(raw: unknown): DatasetColumn | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	const type = FIELD_TYPES.has(raw.type as FieldType) ? (raw.type as FieldType) : 'string';
	return {
		id: raw.id,
		label: asString(raw.label, raw.id),
		type
	};
}

function parseRow(raw: unknown): Record<string, string | number | null> | null {
	if (!isRecord(raw)) return null;
	const row: Record<string, string | number | null> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === null || typeof value === 'string' || typeof value === 'number') {
			row[key] = value;
		}
	}
	return row;
}

function parseDataset(raw: unknown): Dataset | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	const columns = (Array.isArray(raw.columns) ? raw.columns : [])
		.map(parseColumn)
		.filter((c): c is DatasetColumn => !!c)
		.slice(0, MAX_DATASET_COLUMNS);
	const colIds = new Set(columns.map((c) => c.id));
	const rows = (Array.isArray(raw.rows) ? raw.rows : [])
		.map(parseRow)
		.filter((r): r is Record<string, string | number | null> => !!r)
		.slice(0, MAX_DATASET_ROWS)
		.map((row) => {
			const next: Record<string, string | number | null> = {};
			for (const id of colIds) next[id] = row[id] ?? null;
			return next;
		});
	return {
		id: raw.id,
		label: asString(raw.label, raw.id),
		columns,
		rows
	};
}

function parseScalar(raw: unknown): Scalar | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	const type = SCALAR_TYPES.has(raw.type as FieldType | 'boolean')
		? (raw.type as FieldType | 'boolean')
		: 'string';
	let value: string | number | boolean | null = null;
	if (
		raw.value === null ||
		typeof raw.value === 'string' ||
		typeof raw.value === 'number' ||
		typeof raw.value === 'boolean'
	) {
		value = raw.value;
	}
	return {
		id: raw.id,
		label: asString(raw.label, raw.id),
		type,
		value
	};
}

function parseBindingValue(raw: unknown): BindingRef | string | number | undefined {
	if (typeof raw === 'string' || typeof raw === 'number') return raw;
	if (isRecord(raw) && typeof raw.ref === 'string') return { ref: raw.ref };
	return undefined;
}

function parseVec3(raw: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(raw) || raw.length < 3) return fallback;
	return [asFinite(raw[0], fallback[0]), asFinite(raw[1], fallback[1]), asFinite(raw[2], fallback[2])];
}

function parseScene3dObject(raw: unknown): Scene3dObject | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (!SCENE3D_PRIMITIVES.has(raw.primitive as string)) return null;
	const obj: Scene3dObject = {
		id: raw.id,
		primitive: raw.primitive as Scene3dObject['primitive'],
		position: parseVec3(raw.position, [0, 0, 0]),
		rotation: parseVec3(raw.rotation, [0, 0, 0]),
		scale: parseVec3(raw.scale, [1, 1, 1])
	};
	if (typeof raw.color === 'string') obj.color = raw.color;
	return obj;
}

function parseScenePayload(raw: unknown): Scene3dMark['scene'] {
	const sceneRaw = isRecord(raw) ? raw : {};
	const camRaw = isRecord(sceneRaw.camera) ? sceneRaw.camera : {};
	const camera: Scene3dCamera = {
		position: parseVec3(camRaw.position, [2, 2, 2]),
		target: parseVec3(camRaw.target, [0, 0, 0]),
		fov: asFinite(camRaw.fov, 50)
	};
	const objects = (Array.isArray(sceneRaw.objects) ? sceneRaw.objects : [])
		.map(parseScene3dObject)
		.filter((o): o is Scene3dObject => !!o);
	return { objects, camera };
}

function parseStyle(raw: unknown): Record<string, string | number | boolean> | undefined {
	if (!isRecord(raw)) return undefined;
	const style: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			style[key] = value;
		}
	}
	return Object.keys(style).length > 0 ? style : undefined;
}

function parseBindings(raw: unknown): Record<string, BindingRef | string | number> | undefined {
	if (!isRecord(raw)) return undefined;
	const bindings: Record<string, BindingRef | string | number> = {};
	for (const [key, value] of Object.entries(raw)) {
		const parsed = parseBindingValue(value);
		if (parsed !== undefined) bindings[key] = parsed;
	}
	return Object.keys(bindings).length > 0 ? bindings : undefined;
}

function parseTransform(raw: unknown, fallback: ObjectTransform): ObjectTransform {
	const r = isRecord(raw) ? raw : {};
	return {
		x: asFinite(r.x, fallback.x),
		y: asFinite(r.y, fallback.y),
		w: asFinite(r.w, fallback.w),
		h: asFinite(r.h, fallback.h),
		rotation: asFinite(r.rotation, fallback.rotation),
		opacity: asFinite(r.opacity, fallback.opacity)
	};
}

const DEFAULT_TRANSFORM: ObjectTransform = {
	x: 0,
	y: 0,
	w: 100,
	h: 100,
	rotation: 0,
	opacity: 1
};

const POINT_TRANSFORM: ObjectTransform = {
	x: 0,
	y: 0,
	w: 16,
	h: 16,
	rotation: 0,
	opacity: 1
};

function parseShape(raw: unknown): ShapeSpec | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.primitive !== 'rect' && raw.primitive !== 'ellipse' && raw.primitive !== 'line') {
		return undefined;
	}
	return { primitive: raw.primitive };
}

function parsePath(raw: unknown): PathSpec | undefined {
	if (!isRecord(raw) || typeof raw.d !== 'string') return undefined;
	const spec: PathSpec = { d: raw.d };
	if (typeof raw.closed === 'boolean') spec.closed = raw.closed;
	return spec;
}

function parseSeries(raw: unknown): SeriesSpec | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.mode === 'bars' || raw.mode === 'line' || raw.mode === 'scatter') {
		return { mode: raw.mode };
	}
	return { mode: 'bars' };
}

function parsePointSpec(raw: unknown): PointSpec | undefined {
	if (!isRecord(raw)) return undefined;
	const spec: PointSpec = {
		x: asFinite(raw.x, 0),
		y: asFinite(raw.y, 0)
	};
	if (typeof raw.value === 'number' && Number.isFinite(raw.value)) spec.value = raw.value;
	if (typeof raw.label === 'string') spec.label = raw.label;
	return spec;
}

function parseObject(raw: unknown): IgfxObject | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (!OBJECT_KIND_SET.has(raw.kind as string)) return null;
	const kind = raw.kind as ObjectKind;
	const fallback = kind === 'point' ? POINT_TRANSFORM : DEFAULT_TRANSFORM;
	const obj: IgfxObject = {
		id: raw.id,
		name: asString(raw.name, raw.id) || raw.id,
		parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null,
		kind,
		visible: raw.visible !== false,
		transform: parseTransform(raw.transform, fallback)
	};
	if (raw.locked === true) obj.locked = true;
	const bindings = parseBindings(raw.bindings);
	if (bindings) obj.bindings = bindings;
	const style = parseStyle(raw.style);
	if (style) obj.style = style;
	if (kind === 'scene3d') obj.scene = parseScenePayload(raw.scene);
	if (kind === 'shape') {
		const shape = parseShape(raw.shape);
		if (shape) obj.shape = shape;
	}
	if (kind === 'path') {
		const path = parsePath(raw.path);
		if (path) obj.path = path;
	}
	if (kind === 'series') {
		obj.series = parseSeries(raw.series) ?? { mode: 'bars' };
	}
	if (kind === 'point') {
		obj.point = parsePointSpec(raw.point) ?? { x: 0, y: 0 };
	}
	return obj;
}

function parseKeyframe(raw: unknown): MotionKeyframe | null {
	if (!isRecord(raw)) return null;
	const tMs = asFinite(raw.tMs, NaN);
	const value = asFinite(raw.value, NaN);
	if (!Number.isFinite(tMs) || !Number.isFinite(value)) return null;
	const key: MotionKeyframe = { tMs, value };
	if (typeof raw.easing === 'string' && EASINGS.has(raw.easing)) {
		key.easing = raw.easing as MotionKeyframe['easing'];
	}
	return key;
}

function parsePropertyCurve(raw: unknown): PropertyCurve | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (typeof raw.prop !== 'string' || !ANIMATABLE_SET.has(raw.prop)) return null;
	const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : [])
		.map(parseKeyframe)
		.filter((k): k is MotionKeyframe => !!k)
		.slice(0, MAX_KEYS_PER_CURVE);
	return { id: raw.id, prop: raw.prop as AnimatableProp, keyframes };
}

function parseSceneTrack(raw: unknown): SceneTrack | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (typeof raw.objectId !== 'string' || !raw.objectId) return null;
	const curves = (Array.isArray(raw.curves) ? raw.curves : [])
		.map(parsePropertyCurve)
		.filter((c): c is PropertyCurve => !!c);
	return {
		id: raw.id,
		objectId: raw.objectId,
		startMs: asFinite(raw.startMs, 0),
		durationMs: Math.max(0, asFinite(raw.durationMs, 0)),
		curves
	};
}

function parseTake(raw: unknown): SceneTimeline | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	const durationMs = Math.max(0, asFinite(raw.durationMs, DEFAULT_DURATION_MS));
	const posterMs = asFinite(raw.posterMs, durationMs);
	const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
		.map(parseSceneTrack)
		.filter((t): t is SceneTrack => !!t)
		.slice(0, MAX_TRACKS_PER_TAKE);
	return {
		id: raw.id,
		name: asString(raw.name, 'Take 1') || 'Take 1',
		durationMs,
		posterMs,
		tracks
	};
}

function parseCamera(raw: unknown): SceneCamera2d | undefined {
	if (!isRecord(raw)) return undefined;
	const zoom = asFinite(raw.zoom, 1);
	return {
		x: asFinite(raw.x, 0),
		y: asFinite(raw.y, 0),
		zoom: Math.min(8, Math.max(0.1, zoom))
	};
}

function parseThemeOverride(raw: unknown): Partial<Theme> | undefined {
	if (!isRecord(raw)) return undefined;
	const o: Partial<Theme> = {};
	if (Array.isArray(raw.palette)) {
		const palette = raw.palette.filter((c): c is string => typeof c === 'string' && c.length > 0);
		if (palette.length > 0) o.palette = palette;
	}
	for (const key of ['background', 'surface', 'text', 'muted', 'grid', 'fontFamily', 'fontMono'] as const) {
		if (typeof raw[key] === 'string') o[key] = raw[key] as string;
	}
	if (typeof raw.radius === 'number' && Number.isFinite(raw.radius)) o.radius = raw.radius;
	return Object.keys(o).length > 0 ? o : undefined;
}

function parseMediaBed(raw: unknown): MediaBed | undefined {
	if (!isRecord(raw) || typeof raw.nodeId !== 'string' || !raw.nodeId) return undefined;
	return {
		nodeId: raw.nodeId,
		offsetMs: asFinite(raw.offsetMs, 0),
		durationMs: asFinite(raw.durationMs, 0)
	};
}

function parseLastExport(raw: unknown): LastExport | undefined {
	if (!isRecord(raw)) return undefined;
	const out: LastExport = {
		fps: asFinite(raw.fps, DEFAULT_EXPORT_FPS),
		bitrate: asString(raw.bitrate, DEFAULT_EXPORT_BITRATE) || DEFAULT_EXPORT_BITRATE
	};
	if (typeof raw.svgNodeId === 'string') out.svgNodeId = raw.svgNodeId;
	if (typeof raw.mp4NodeId === 'string') out.mp4NodeId = raw.mp4NodeId;
	if (typeof raw.width === 'number' && Number.isFinite(raw.width)) out.width = raw.width;
	if (typeof raw.height === 'number' && Number.isFinite(raw.height)) out.height = raw.height;
	return out;
}

function stripOrphanPoints(objects: IgfxObject[]): IgfxObject[] {
	const byId = new Map(objects.map((o) => [o.id, o]));
	const seriesCount = new Map<string, number>();
	const kept: IgfxObject[] = [];
	for (const obj of objects) {
		if (obj.kind === 'point') {
			const parent = obj.parentId ? byId.get(obj.parentId) : undefined;
			if (!parent || parent.kind !== 'series') continue;
			const n = seriesCount.get(parent.id) ?? 0;
			if (n >= MAX_POINTS_PER_SERIES) continue;
			seriesCount.set(parent.id, n + 1);
		}
		kept.push(obj);
	}
	return kept;
}

function parseScene(
	raw: unknown,
	collectionArtboard: { width: number; height: number }
): IgfxScene | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	const objects = stripOrphanPoints(
		(Array.isArray(raw.objects) ? raw.objects : [])
			.map(parseObject)
			.filter((o): o is IgfxObject => !!o)
	).slice(0, MAX_OBJECTS_PER_SCENE);
	let timelines = (Array.isArray(raw.timelines) ? raw.timelines : [])
		.map(parseTake)
		.filter((t): t is SceneTimeline => !!t)
		.slice(0, MAX_TAKES_PER_SCENE);
	if (timelines.length === 0) timelines = [createTake('Take 1')];
	let activeTimelineId = asString(raw.activeTimelineId, '');
	if (!timelines.some((t) => t.id === activeTimelineId)) activeTimelineId = timelines[0].id;
	const scene: IgfxScene = {
		id: raw.id,
		name: asString(raw.name, 'Scene') || 'Scene',
		objects,
		timelines,
		activeTimelineId
	};
	if (isRecord(raw.artboard)) {
		if (raw.artboard.width !== undefined || raw.artboard.height !== undefined) {
			scene.artboard = {
				width: Math.max(1, asFinite(raw.artboard.width, collectionArtboard.width)),
				height: Math.max(1, asFinite(raw.artboard.height, collectionArtboard.height))
			};
		}
	}
	const camera = parseCamera(raw.camera);
	if (camera) scene.camera = camera;
	const themeOverride = parseThemeOverride(raw.themeOverride);
	if (themeOverride) scene.themeOverride = themeOverride;
	const mediaBed = parseMediaBed(raw.mediaBed);
	if (mediaBed) scene.mediaBed = mediaBed;
	return scene;
}

export function parseIgfx(raw: unknown): IgfxDocument {
	if (!isRecord(raw)) throw new IgfxParseError('Expected an object');
	if (raw.format !== IGFX_FORMAT) {
		throw new IgfxParseError(`Expected format "${IGFX_FORMAT}", got ${JSON.stringify(raw.format)}`);
	}
	const migrated = isV1(raw) ? migrateV1ToV2(raw) : raw;
	const artboardRaw = isRecord(migrated.artboard) ? migrated.artboard : {};
	const width = Math.max(1, asFinite(artboardRaw.width, DEFAULT_ARTBOARD_WIDTH));
	const height = Math.max(1, asFinite(artboardRaw.height, DEFAULT_ARTBOARD_HEIGHT));

	const datasets = (Array.isArray(migrated.datasets) ? migrated.datasets : [])
		.map(parseDataset)
		.filter((d): d is Dataset => !!d);
	const scalars = (Array.isArray(migrated.scalars) ? migrated.scalars : [])
		.map(parseScalar)
		.filter((s): s is Scalar => !!s);

	let scenes = (Array.isArray(migrated.scenes) ? migrated.scenes : [])
		.map((s) => parseScene(s, { width, height }))
		.filter((s): s is IgfxScene => !!s)
		.slice(0, MAX_SCENES);
	if (scenes.length === 0) scenes = [createScene('Scene')];
	let activeSceneId = asString(migrated.activeSceneId, '');
	if (!scenes.some((s) => s.id === activeSceneId)) activeSceneId = scenes[0].id;

	const doc: IgfxDocument = {
		format: IGFX_FORMAT,
		schemaVersion: IGFX_SCHEMA_VERSION,
		name: asString(migrated.name, 'Untitled') || 'Untitled',
		artboard: { width, height },
		theme: mergeTheme(migrated.theme),
		datasets,
		scalars,
		scenes,
		activeSceneId
	};
	const lastExport = parseLastExport(migrated.lastExport);
	if (lastExport) doc.lastExport = lastExport;
	return doc;
}

function uniqueIds(ids: string[], label: string, errors: string[]): void {
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) errors.push(`Duplicate ${label} id "${id}"`);
		seen.add(id);
	}
}

function parentCycle(objects: IgfxObject[], obj: IgfxObject, byId: Map<string, IgfxObject>): boolean {
	const seen = new Set<string>();
	let cur: IgfxObject | undefined = obj;
	while (cur) {
		if (seen.has(cur.id)) return true;
		seen.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return false;
}

function checkBindings(
	ownerId: string,
	bindings: Record<string, BindingRef | string | number> | undefined,
	doc: IgfxDocument,
	datasetIds: Set<string>,
	scalarIds: Set<string>,
	warnings: string[]
): void {
	if (!bindings) return;
	for (const [key, value] of Object.entries(bindings)) {
		if (!isRecord(value) || typeof value.ref !== 'string') continue;
		const datasetMatch = /^dataset:([^.]+)\.(.+)$/.exec(value.ref);
		const scalarMatch = /^scalar:(.+)$/.exec(value.ref);
		if (datasetMatch) {
			const [, dsId, col] = datasetMatch;
			const ds = doc.datasets.find((d) => d.id === dsId);
			if (!datasetIds.has(dsId) || !ds) {
				warnings.push(`Object "${ownerId}" binding ${key} missing dataset "${dsId}"`);
			} else if (!ds.columns.some((c) => c.id === col)) {
				warnings.push(`Object "${ownerId}" binding ${key} missing column "${col}"`);
			}
		} else if (scalarMatch) {
			if (!scalarIds.has(scalarMatch[1])) {
				warnings.push(`Object "${ownerId}" binding ${key} missing scalar "${scalarMatch[1]}"`);
			}
		} else {
			warnings.push(`Object "${ownerId}" binding ${key} has unrecognized ref "${value.ref}"`);
		}
	}
}

export function validate(doc: IgfxDocument): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (doc.format !== IGFX_FORMAT) {
		errors.push(`Expected format "${IGFX_FORMAT}"`);
	}
	if (typeof doc.schemaVersion !== 'number' || !Number.isFinite(doc.schemaVersion)) {
		errors.push('schemaVersion must be a number');
	}
	if (!doc.artboard || doc.artboard.width <= 0 || doc.artboard.height <= 0) {
		errors.push('artboard width and height must be positive');
	}
	if (doc.scenes.length > MAX_SCENES) {
		errors.push(`scene cap ${MAX_SCENES}`);
	}
	uniqueIds(
		doc.datasets.map((d) => d.id),
		'dataset',
		errors
	);
	uniqueIds(
		doc.scalars.map((s) => s.id),
		'scalar',
		errors
	);
	uniqueIds(
		doc.scenes.map((s) => s.id),
		'scene',
		errors
	);
	if (!doc.scenes.some((s) => s.id === doc.activeSceneId)) {
		errors.push(`activeSceneId "${doc.activeSceneId}" does not resolve`);
	}
	for (const ds of doc.datasets) {
		if (ds.rows.length > MAX_DATASET_ROWS) {
			errors.push(`Dataset "${ds.id}" exceeds ${MAX_DATASET_ROWS} row cap (${ds.rows.length})`);
		}
		if (ds.columns.length > MAX_DATASET_COLUMNS) {
			errors.push(`Dataset "${ds.id}" exceeds ${MAX_DATASET_COLUMNS} column cap (${ds.columns.length})`);
		}
	}
	const datasetIds = new Set(doc.datasets.map((d) => d.id));
	const scalarIds = new Set(doc.scalars.map((s) => s.id));
	for (const scene of doc.scenes) {
		if (scene.objects.length > MAX_OBJECTS_PER_SCENE) {
			errors.push(`object cap ${MAX_OBJECTS_PER_SCENE}`);
		}
		if (scene.timelines.length > MAX_TAKES_PER_SCENE) {
			errors.push(`take cap ${MAX_TAKES_PER_SCENE}`);
		}
		uniqueIds(
			scene.objects.map((o) => o.id),
			'object',
			errors
		);
		uniqueIds(
			scene.timelines.map((t) => t.id),
			'take',
			errors
		);
		if (!scene.timelines.some((t) => t.id === scene.activeTimelineId)) {
			errors.push(`activeTimelineId "${scene.activeTimelineId}" does not resolve`);
		}
		const byId = new Map(scene.objects.map((o) => [o.id, o]));
		const objectIds = new Set(byId.keys());
		for (const obj of scene.objects) {
			if (obj.parentId) {
				if (!objectIds.has(obj.parentId)) {
					errors.push(`Object "${obj.id}" parentId "${obj.parentId}" is not in the scene`);
				} else if (parentCycle(scene.objects, obj, byId)) {
					errors.push(`Object "${obj.id}" parentId cycle`);
				}
			}
			if (obj.kind === 'point') {
				const parent = obj.parentId ? byId.get(obj.parentId) : undefined;
				if (!parent || parent.kind !== 'series') {
					errors.push(`Point "${obj.id}" parent must be a series`);
				}
			}
			if (obj.kind !== 'scene3d' && obj.kind !== 'group' && obj.kind !== 'shape' && obj.kind !== 'path' && obj.kind !== 'series' && obj.kind !== 'point' && !MARK_KIND_SET.has(obj.kind)) {
				warnings.push(`Unknown object kind "${obj.kind}" on "${obj.id}"`);
			}
			checkBindings(obj.id, obj.bindings, doc, datasetIds, scalarIds, warnings);
			if (obj.kind === 'legend' || obj.kind === 'axis') {
				const forMark =
					(typeof obj.bindings?.forMark === 'string' && obj.bindings.forMark) ||
					(typeof obj.style?.forMark === 'string' && obj.style.forMark) ||
					undefined;
				if (forMark && !objectIds.has(forMark)) {
					warnings.push(`Object "${obj.id}" forMark "${forMark}" does not exist`);
				}
			}
		}
		for (const series of scene.objects.filter((o) => o.kind === 'series')) {
			const n = scene.objects.filter((o) => o.kind === 'point' && o.parentId === series.id).length;
			if (n > MAX_POINTS_PER_SERIES) {
				errors.push(`point cap ${MAX_POINTS_PER_SERIES}`);
			}
		}
		for (const take of scene.timelines) {
			if (!Number.isFinite(take.durationMs) || take.durationMs < 0) {
				errors.push('timeline.durationMs must be a non-negative number');
			}
			if (take.posterMs < 0 || take.posterMs > take.durationMs) {
				warnings.push('timeline.posterMs is outside [0, durationMs]');
			}
			if (take.tracks.length > MAX_TRACKS_PER_TAKE) {
				errors.push(`track cap ${MAX_TRACKS_PER_TAKE}`);
			}
			uniqueIds(
				take.tracks.map((t) => t.id),
				'track',
				errors
			);
			for (const track of take.tracks) {
				if (!objectIds.has(track.objectId)) {
					warnings.push(`Track "${track.id}" objectId "${track.objectId}" is not in the scene`);
				}
				for (const curve of track.curves) {
					if (curve.keyframes.length > MAX_KEYS_PER_CURVE) {
						errors.push(`key cap ${MAX_KEYS_PER_CURVE}`);
					}
				}
			}
		}
	}
	return { ok: errors.length === 0, errors, warnings };
}
