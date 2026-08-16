import { defaultTheme, mergeTheme } from './theme.js';
import {
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
	type Scalar,
	type ValidationResult
} from './types.js';

export class IgfxParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IgfxParseError';
	}
}

export function defaultTimeline(durationMs = DEFAULT_DURATION_MS): IgfxTimeline {
	return {
		durationMs,
		posterMs: durationMs,
		tracks: []
	};
}

export function createDocument(name = 'Untitled'): IgfxDocument {
	return {
		format: IGFX_FORMAT,
		schemaVersion: IGFX_SCHEMA_VERSION,
		name,
		artboard: { width: DEFAULT_ARTBOARD_WIDTH, height: DEFAULT_ARTBOARD_HEIGHT },
		theme: defaultTheme(),
		datasets: [],
		scalars: [],
		marks: [],
		timeline: defaultTimeline()
	};
}

export function defaultDocument(): IgfxDocument {
	return createDocument();
}

export function serializeIgfx(doc: IgfxDocument): string {
	return JSON.stringify(doc);
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

function parseMark(raw: unknown): Mark | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (!MARK_KIND_SET.has(raw.kind as string)) return null;
	const layoutRaw = isRecord(raw.layout) ? raw.layout : {};
	const bindingsRaw = isRecord(raw.bindings) ? raw.bindings : {};
	const bindings: Record<string, BindingRef | string | number> = {};
	for (const [key, value] of Object.entries(bindingsRaw)) {
		const parsed = parseBindingValue(value);
		if (parsed !== undefined) bindings[key] = parsed;
	}
	let style: Record<string, string | number | boolean> | undefined;
	if (isRecord(raw.style)) {
		style = {};
		for (const [key, value] of Object.entries(raw.style)) {
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				style[key] = value;
			}
		}
	}
	return {
		id: raw.id,
		kind: raw.kind as MarkKind,
		layout: {
			x: asFinite(layoutRaw.x, 0),
			y: asFinite(layoutRaw.y, 0),
			w: asFinite(layoutRaw.w, 100),
			h: asFinite(layoutRaw.h, 100)
		},
		bindings,
		...(style ? { style } : {})
	};
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

function parseTrack(raw: unknown): MotionTrack | null {
	if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
	if (typeof raw.target !== 'string' || !raw.target) return null;
	const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : [])
		.map(parseKeyframe)
		.filter((k): k is MotionKeyframe => !!k);
	return { id: raw.id, target: raw.target, keyframes };
}

function parseTimeline(raw: unknown): IgfxTimeline {
	if (!isRecord(raw)) return defaultTimeline();
	const durationMs = Math.max(0, asFinite(raw.durationMs, DEFAULT_DURATION_MS));
	const posterMs = asFinite(raw.posterMs, durationMs);
	const tracks = (Array.isArray(raw.tracks) ? raw.tracks : [])
		.map(parseTrack)
		.filter((t): t is MotionTrack => !!t);
	return { durationMs, posterMs, tracks };
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

/** Older schemaVersions have no migrations yet. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
	return raw;
}

export function parseIgfx(raw: unknown): IgfxDocument {
	if (!isRecord(raw)) throw new IgfxParseError('Expected an object');
	if (raw.format !== IGFX_FORMAT) {
		throw new IgfxParseError(`Expected format "${IGFX_FORMAT}", got ${JSON.stringify(raw.format)}`);
	}
	const migrated = migrate(raw);
	const artboardRaw = isRecord(migrated.artboard) ? migrated.artboard : {};
	const width = Math.max(1, asFinite(artboardRaw.width, DEFAULT_ARTBOARD_WIDTH));
	const height = Math.max(1, asFinite(artboardRaw.height, DEFAULT_ARTBOARD_HEIGHT));

	const datasets = (Array.isArray(migrated.datasets) ? migrated.datasets : [])
		.map(parseDataset)
		.filter((d): d is Dataset => !!d);
	const scalars = (Array.isArray(migrated.scalars) ? migrated.scalars : [])
		.map(parseScalar)
		.filter((s): s is Scalar => !!s);
	const marks = (Array.isArray(migrated.marks) ? migrated.marks : [])
		.map(parseMark)
		.filter((m): m is Mark => !!m);

	const doc: IgfxDocument = {
		format: IGFX_FORMAT,
		schemaVersion: asFinite(migrated.schemaVersion, IGFX_SCHEMA_VERSION),
		name: asString(migrated.name, 'Untitled') || 'Untitled',
		artboard: { width, height },
		theme: mergeTheme(migrated.theme),
		datasets,
		scalars,
		marks,
		timeline: parseTimeline(migrated.timeline)
	};
	const mediaBed = parseMediaBed(migrated.mediaBed);
	if (mediaBed) doc.mediaBed = mediaBed;
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
	if (!doc.timeline || !Number.isFinite(doc.timeline.durationMs) || doc.timeline.durationMs < 0) {
		errors.push('timeline.durationMs must be a non-negative number');
	}
	if (doc.timeline && (doc.timeline.posterMs < 0 || doc.timeline.posterMs > doc.timeline.durationMs)) {
		warnings.push('timeline.posterMs is outside [0, durationMs]');
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
		doc.marks.map((m) => m.id),
		'mark',
		errors
	);
	uniqueIds(
		doc.timeline.tracks.map((t) => t.id),
		'track',
		errors
	);
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
	const markIds = new Set(doc.marks.map((m) => m.id));
	for (const mark of doc.marks) {
		if (!MARK_KIND_SET.has(mark.kind)) {
			warnings.push(`Unknown mark kind "${mark.kind}" on "${mark.id}"`);
		}
		for (const [key, value] of Object.entries(mark.bindings)) {
			if (!isRecord(value) || typeof value.ref !== 'string') continue;
			const datasetMatch = /^dataset:([^.]+)\.(.+)$/.exec(value.ref);
			const scalarMatch = /^scalar:(.+)$/.exec(value.ref);
			if (datasetMatch) {
				const [, dsId, col] = datasetMatch;
				const ds = doc.datasets.find((d) => d.id === dsId);
				if (!datasetIds.has(dsId) || !ds) {
					warnings.push(`Mark "${mark.id}" binding ${key} missing dataset "${dsId}"`);
				} else if (!ds.columns.some((c) => c.id === col)) {
					warnings.push(`Mark "${mark.id}" binding ${key} missing column "${col}"`);
				}
			} else if (scalarMatch) {
				if (!scalarIds.has(scalarMatch[1])) {
					warnings.push(`Mark "${mark.id}" binding ${key} missing scalar "${scalarMatch[1]}"`);
				}
			} else {
				warnings.push(`Mark "${mark.id}" binding ${key} has unrecognized ref "${value.ref}"`);
			}
		}
		const forMark =
			(typeof mark.bindings.forMark === 'string' && mark.bindings.forMark) ||
			(typeof mark.style?.forMark === 'string' && mark.style.forMark) ||
			undefined;
		if ((mark.kind === 'legend' || mark.kind === 'axis') && forMark && !markIds.has(forMark)) {
			warnings.push(`Mark "${mark.id}" forMark "${forMark}" does not exist`);
		}
	}
	return { ok: errors.length === 0, errors, warnings };
}
