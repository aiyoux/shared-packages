import type { ObjectSample } from './motion.js';
import { childrenOf, objectToMark } from './objects.js';
import { seriesColor as userSeriesColor, seriesPointPose, visiblePointChildren } from './series.js';
import { resolveColorToken } from './theme.js';
import type {
	AnyMark,
	BindingRef,
	Dataset,
	IgfxDocument,
	IgfxObject,
	IgfxScene,
	Mark,
	Scalar,
	Theme
} from './types.js';
import { MAX_DATASET_COLUMNS, MAX_DATASET_ROWS } from './types.js';

export interface BoundSeries {
	categories: string[];
	xs: number[];
	ys: number[];
	values: number[];
	color: string;
	datasetLabel?: string;
	datasetId?: string;
}

export interface BoundMark {
	series: BoundSeries | null;
	text: string;
	value: number | null;
	label: string;
	prefix: string;
	suffix: string;
	forMark: string;
	title: string;
	missing: boolean;
}

export interface BindingWarning {
	message: string;
}

function isBindingRef(value: unknown): value is BindingRef {
	return !!value && typeof value === 'object' && typeof (value as BindingRef).ref === 'string';
}

export function bindingOf(
	bindings: Record<string, BindingRef | string | number>,
	key: string
): BindingRef | string | number | undefined {
	return bindings[key];
}

function datasetById(doc: IgfxDocument, id: string): Dataset | undefined {
	return doc.datasets.find((d) => d.id === id);
}

function scalarById(doc: IgfxDocument, id: string): Scalar | undefined {
	return doc.scalars.find((s) => s.id === id);
}

function cappedRows(dataset: Dataset): Record<string, string | number | null>[] {
	return dataset.rows.slice(0, MAX_DATASET_ROWS);
}

function columnExists(dataset: Dataset, columnId: string): boolean {
	return dataset.columns.slice(0, MAX_DATASET_COLUMNS).some((c) => c.id === columnId);
}

export function parseDataRef(
	ref: string
): { kind: 'dataset'; datasetId: string; column: string } | { kind: 'scalar'; scalarId: string } | null {
	const dataset = /^dataset:([^.]+)\.(.+)$/.exec(ref);
	if (dataset) return { kind: 'dataset', datasetId: dataset[1], column: dataset[2] };
	const scalar = /^scalar:(.+)$/.exec(ref);
	if (scalar) return { kind: 'scalar', scalarId: scalar[1] };
	return null;
}

function coerceNumber(value: string | number | boolean | null | undefined): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
		const t = Date.parse(value);
		if (Number.isFinite(t)) return t;
	}
	return null;
}

function coerceString(value: string | number | boolean | null | undefined): string {
	if (value === null || value === undefined) return '';
	return String(value);
}

function columnValues(dataset: Dataset, columnId: string): (string | number | null)[] {
	return cappedRows(dataset).map((row) => row[columnId] ?? null);
}

function resolveScalarValue(
	doc: IgfxDocument,
	ref: BindingRef,
	warnings: string[],
	markId: string,
	key: string
): string | number | boolean | null {
	const parsed = parseDataRef(ref.ref);
	if (!parsed || parsed.kind !== 'scalar') {
		warnings.push(`Mark "${markId}" ${key} is not a scalar ref`);
		return null;
	}
	const scalar = scalarById(doc, parsed.scalarId);
	if (!scalar) {
		warnings.push(`Mark "${markId}" missing scalar "${parsed.scalarId}"`);
		return null;
	}
	return scalar.value;
}

function resolveColumn(
	doc: IgfxDocument,
	ref: BindingRef,
	warnings: string[],
	markId: string,
	key: string
): { dataset: Dataset; values: (string | number | null)[] } | null {
	const parsed = parseDataRef(ref.ref);
	if (!parsed || parsed.kind !== 'dataset') {
		warnings.push(`Mark "${markId}" ${key} is not a dataset column ref`);
		return null;
	}
	const dataset = datasetById(doc, parsed.datasetId);
	if (!dataset) {
		warnings.push(`Mark "${markId}" missing dataset "${parsed.datasetId}"`);
		return null;
	}
	if (!columnExists(dataset, parsed.column)) {
		warnings.push(`Mark "${markId}" missing column "${parsed.column}"`);
		return null;
	}
	return { dataset, values: columnValues(dataset, parsed.column) };
}

function literalOrRefString(
	doc: IgfxDocument,
	raw: BindingRef | string | number | undefined,
	warnings: string[],
	markId: string,
	key: string
): string {
	if (raw === undefined) return '';
	if (typeof raw === 'string') return raw;
	if (typeof raw === 'number') return String(raw);
	const value = resolveScalarValue(doc, raw, warnings, markId, key);
	return coerceString(value);
}

function literalOrRefNumber(
	doc: IgfxDocument,
	raw: BindingRef | string | number | undefined,
	warnings: string[],
	markId: string,
	key: string
): number | null {
	if (raw === undefined) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'string') return coerceNumber(raw);
	return coerceNumber(resolveScalarValue(doc, raw, warnings, markId, key));
}

function resolveForMark(mark: Mark): string {
	const fromBinding = mark.bindings.forMark;
	if (typeof fromBinding === 'string') return fromBinding;
	if (isBindingRef(fromBinding)) return fromBinding.ref;
	const fromStyle = mark.style?.forMark;
	if (typeof fromStyle === 'string') return fromStyle;
	return '';
}

function emptyBound(partial?: Partial<BoundMark>): BoundMark {
	return {
		series: null,
		text: '',
		value: null,
		label: '',
		prefix: '',
		suffix: '',
		forMark: '',
		title: '',
		missing: false,
		...partial
	};
}

function seriesColor(
	theme: Theme,
	mark: Mark,
	doc: IgfxDocument,
	warnings: string[]
): string {
	const raw = mark.bindings.color;
	if (raw === undefined) return resolveColorToken(theme, 0);
	if (typeof raw === 'number' || typeof raw === 'string') {
		return resolveColorToken(theme, raw);
	}
	if (isBindingRef(raw)) {
		const value = resolveScalarValue(doc, raw, warnings, mark.id, 'color');
		if (typeof value === 'number' || typeof value === 'string') {
			return resolveColorToken(theme, value);
		}
	}
	return resolveColorToken(theme, 0);
}

export function bindMark(
	doc: IgfxDocument,
	mark: AnyMark,
	warnings: string[],
	theme: Theme = doc.theme
): BoundMark {
	if (mark.kind === 'scene3d') {
		const raw = mark.bindings.values;
		if (!raw) return emptyBound();
		if (!isBindingRef(raw)) {
			warnings.push(`Mark "${mark.id}" values is not a dataset column ref`);
			return emptyBound({ missing: true });
		}
		const col = resolveColumn(doc, raw, warnings, mark.id, 'values');
		if (!col) return emptyBound({ missing: true });
		return emptyBound({
			series: {
				categories: [],
				values: col.values.map((v) => coerceNumber(v) ?? 0),
				xs: [],
				ys: [],
				color: seriesColor(theme, mark as unknown as Mark, doc, warnings),
				datasetLabel: col.dataset.label,
				datasetId: col.dataset.id
			}
		});
	}
	switch (mark.kind) {
		case 'bar': {
			const catRaw = mark.bindings.category;
			const valRaw = mark.bindings.value;
			if (!isBindingRef(catRaw) || !isBindingRef(valRaw)) {
				warnings.push(`Mark "${mark.id}" missing category/value bindings`);
				return emptyBound({ missing: true });
			}
			const cats = resolveColumn(doc, catRaw, warnings, mark.id, 'category');
			const vals = resolveColumn(doc, valRaw, warnings, mark.id, 'value');
			if (!cats || !vals) return emptyBound({ missing: true });
			const n = Math.min(cats.values.length, vals.values.length);
			return emptyBound({
				series: {
					categories: cats.values.slice(0, n).map(coerceString),
					values: vals.values.slice(0, n).map((v) => coerceNumber(v) ?? 0),
					xs: [],
					ys: [],
					color: seriesColor(theme, mark, doc, warnings),
					datasetLabel: vals.dataset.label,
					datasetId: vals.dataset.id
				}
			});
		}
		case 'line': {
			const xRaw = mark.bindings.x;
			const yRaw = mark.bindings.y;
			if (!isBindingRef(xRaw) || !isBindingRef(yRaw)) {
				warnings.push(`Mark "${mark.id}" missing x/y bindings`);
				return emptyBound({ missing: true });
			}
			const xs = resolveColumn(doc, xRaw, warnings, mark.id, 'x');
			const ys = resolveColumn(doc, yRaw, warnings, mark.id, 'y');
			if (!xs || !ys) return emptyBound({ missing: true });
			const n = Math.min(xs.values.length, ys.values.length);
			return emptyBound({
				series: {
					categories: [],
					values: [],
					xs: xs.values.slice(0, n).map((v) => coerceNumber(v) ?? 0),
					ys: ys.values.slice(0, n).map((v) => coerceNumber(v) ?? 0),
					color: seriesColor(theme, mark, doc, warnings),
					datasetLabel: ys.dataset.label,
					datasetId: ys.dataset.id
				}
			});
		}
		case 'stat': {
			const value = literalOrRefNumber(doc, mark.bindings.value, warnings, mark.id, 'value');
			if (value === null && mark.bindings.value !== undefined && mark.bindings.value !== null) {
				// literal 0 is fine; only missing/unresolved refs are empty
			}
			const missing = mark.bindings.value === undefined || (isBindingRef(mark.bindings.value) && value === null);
			if (missing) {
				warnings.push(`Mark "${mark.id}" missing value`);
			}
			return emptyBound({
				missing,
				value: missing ? null : value,
				label: literalOrRefString(doc, mark.bindings.label, warnings, mark.id, 'label'),
				prefix: literalOrRefString(doc, mark.bindings.prefix, warnings, mark.id, 'prefix'),
				suffix: literalOrRefString(doc, mark.bindings.suffix, warnings, mark.id, 'suffix')
			});
		}
		case 'text': {
			const raw = mark.bindings.text;
			if (raw === undefined) {
				warnings.push(`Mark "${mark.id}" missing text`);
				return emptyBound({ text: '' });
			}
			return emptyBound({
				text: literalOrRefString(doc, raw, warnings, mark.id, 'text')
			});
		}
		case 'legend':
		case 'axis': {
			const forMark = resolveForMark(mark);
			if (!forMark) {
				warnings.push(`Mark "${mark.id}" missing forMark`);
				return emptyBound({ missing: true, title: literalOrRefString(doc, mark.bindings.title, warnings, mark.id, 'title') });
			}
			return emptyBound({
				forMark,
				title: literalOrRefString(doc, mark.bindings.title, warnings, mark.id, 'title')
			});
		}
		default:
			return emptyBound({ missing: true });
	}
}

export interface BindObjectCtx {
	scene: IgfxScene;
	sampled?: Map<string, ObjectSample>;
}

function bindUserSeries(obj: IgfxObject, theme: Theme, ctx?: BindObjectCtx): BoundMark {
	const color = userSeriesColor(obj, theme);
	const children = ctx ? childrenOf(ctx.scene, obj.id) : [];
	const visible = visiblePointChildren(children, ctx?.sampled);
	const poses = visible.map((point) => seriesPointPose(point, ctx?.sampled?.get(point.id)));
	const mode = obj.series?.mode ?? 'bars';
	if (mode === 'bars') {
		return emptyBound({
			series: {
				categories: visible.map((point) => point.point?.label ?? point.name),
				values: poses.map((p) => p.pv),
				xs: [],
				ys: [],
				color,
				datasetLabel: obj.name
			}
		});
	}
	return emptyBound({
		series: {
			categories: [],
			values: [],
			xs: poses.map((p) => p.px),
			ys: poses.map((p) => p.py),
			color,
			datasetLabel: obj.name
		}
	});
}

export function bindObject(
	doc: IgfxDocument,
	obj: IgfxObject,
	warnings: string[],
	theme: Theme = doc.theme,
	ctx?: BindObjectCtx
): BoundMark {
	if (obj.kind === 'series') return bindUserSeries(obj, theme, ctx);
	const mark = objectToMark(obj);
	if (!mark) return emptyBound();
	return bindMark(doc, mark, warnings, theme);
}
