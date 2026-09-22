import type { CellValue, DataDocument, DataView, FieldDef, ViewClause } from './types.js';

export type ViewRow = {
	recordId: string;
	value: CellValue;
	values: Record<string, CellValue>;
};

export type ViewResult =
	| { ok: false; message: string }
	| { ok: true; viewId: string; field: FieldDef | null; rows: ViewRow[] };

function asNumber(value: CellValue): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function compare(clause: ViewClause, cell: CellValue, type: FieldDef['type']): boolean {
	const left = cell ?? null;
	const right = clause.value;
	if (clause.op === 'contains') {
		return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
	}
	if (type === 'int' || type === 'float') {
		const a = asNumber(left);
		const b = asNumber(right);
		if (a === null || b === null) return false;
		if (clause.op === 'eq') return a === b;
		if (clause.op === 'neq') return a !== b;
		if (clause.op === 'lt') return a < b;
		if (clause.op === 'lte') return a <= b;
		if (clause.op === 'gt') return a > b;
		return a >= b;
	}
	if (clause.op === 'eq') return left === right;
	if (clause.op === 'neq') return left !== right;
	const a = left === null || left === undefined ? '' : String(left);
	const b = right === null || right === undefined ? '' : String(right);
	if (clause.op === 'lt') return a < b;
	if (clause.op === 'lte') return a <= b;
	if (clause.op === 'gt') return a > b;
	return a >= b;
}

function matches(doc: DataDocument, view: DataView, values: Record<string, CellValue>): boolean {
	for (const clause of view.where) {
		const field = doc.fields.find((f) => f.id === clause.fieldId);
		if (!field) return false;
		if (!compare(clause, values[field.id] ?? null, field.type)) return false;
	}
	return true;
}

/** Run one named view. The document is not modified. */
export type ViewScalar = 'string' | 'int' | 'float';

/** The socket shape a consumer should declare for this view. Dates and booleans travel as strings. */
export function viewOutputShape(
	doc: DataDocument,
	viewId: string
): { scalar: ViewScalar; many: boolean } | null {
	const view = doc.views.find((v) => v.id === viewId);
	if (!view?.selectFieldId) return null;
	const field = doc.fields.find((f) => f.id === view.selectFieldId);
	if (!field) return null;
	const scalar: ViewScalar = field.type === 'int' ? 'int' : field.type === 'float' ? 'float' : 'string';
	return { scalar, many: view.cardinality !== 'one' };
}

export function evaluateView(doc: DataDocument, viewId: string): ViewResult {
	const view = doc.views.find((v) => v.id === viewId);
	if (!view) return { ok: false, message: 'View not found.' };
	const field = view.selectFieldId ? doc.fields.find((f) => f.id === view.selectFieldId) ?? null : null;
	if (view.selectFieldId && !field) return { ok: false, message: 'View field is missing.' };
	const rows: ViewRow[] = [];
	for (const record of doc.records) {
		if (!matches(doc, view, record.values)) continue;
		rows.push({
			recordId: record.id,
			value: field ? (record.values[field.id] ?? null) : null,
			values: { ...record.values }
		});
	}
	return { ok: true, viewId: view.id, field, rows };
}
