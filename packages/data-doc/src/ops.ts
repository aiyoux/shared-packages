import type {
	CellValue,
	DataDocument,
	DataRecord,
	DataView,
	FieldDef,
	FieldType,
	ViewClause
} from './types.js';

export type DataOp =
	| { t: 'put-field'; field: FieldDef }
	| { t: 'remove-field'; fieldId: string }
	| { t: 'put-record'; record: DataRecord }
	| { t: 'remove-record'; recordId: string }
	| { t: 'set-cell'; recordId: string; fieldId: string; value: CellValue }
	| { t: 'put-view'; view: DataView }
	| { t: 'remove-view'; viewId: string };

const FIELD_TYPES = new Set<FieldType>(['string', 'int', 'float', 'boolean', 'date']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sameValue(a: CellValue, b: CellValue): boolean {
	return a === b;
}

function coerce(type: FieldType, value: CellValue): CellValue | undefined {
	if (value === null) return null;
	if (type === 'string') return typeof value === 'string' ? value : String(value);
	if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
	if (type === 'int') {
		const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(n) ? Math.trunc(n) : undefined;
	}
	if (type === 'float') {
		const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(n) ? n : undefined;
	}
	if (typeof value === 'string' && DATE.test(value)) return value;
	return undefined;
}

function stripField(doc: DataDocument, fieldId: string): DataDocument {
	return {
		...doc,
		fields: doc.fields.filter((f) => f.id !== fieldId),
		records: doc.records.map((record) => {
			if (!(fieldId in record.values)) return record;
			const values = { ...record.values };
			delete values[fieldId];
			return { ...record, values };
		}),
		views: doc.views.map((view) => ({
			...view,
			...(view.selectFieldId === fieldId ? {} : { selectFieldId: view.selectFieldId }),
			where: view.where.filter((c) => c.fieldId !== fieldId)
		})).map((view) => {
			const next: DataView = { id: view.id, name: view.name, where: view.where };
			if (view.selectFieldId && view.selectFieldId !== fieldId) next.selectFieldId = view.selectFieldId;
			if (view.cardinality) next.cardinality = view.cardinality;
			return next;
		})
	};
}

export function applyDataOp(doc: DataDocument, op: DataOp): DataDocument {
	switch (op.t) {
		case 'put-field': {
			if (!FIELD_TYPES.has(op.field.type) || !op.field.id) return doc;
			const field: FieldDef = { id: op.field.id, name: op.field.name, type: op.field.type };
			const index = doc.fields.findIndex((f) => f.id === field.id);
			if (index < 0) return { ...doc, fields: [...doc.fields, field] };
			const prev = doc.fields[index]!;
			if (prev.name === field.name && prev.type === field.type) return doc;
			const fields = doc.fields.slice();
			fields[index] = field;
			let next: DataDocument = { ...doc, fields };
			if (prev.type !== field.type) {
				next = {
					...next,
					records: next.records.map((record) => {
						if (!(field.id in record.values)) return record;
						const coerced = coerce(field.type, record.values[field.id] ?? null);
						const values = { ...record.values };
						if (coerced === undefined) delete values[field.id];
						else values[field.id] = coerced;
						return { ...record, values };
					})
				};
			}
			return next;
		}
		case 'remove-field': {
			if (!doc.fields.some((f) => f.id === op.fieldId)) return doc;
			return stripField(doc, op.fieldId);
		}
		case 'put-record': {
			if (!op.record.id) return doc;
			const known = new Set(doc.fields.map((f) => f.id));
			const values: Record<string, CellValue> = {};
			for (const [key, value] of Object.entries(op.record.values)) {
				if (!known.has(key)) continue;
				const field = doc.fields.find((f) => f.id === key);
				if (!field) continue;
				const coerced = coerce(field.type, value);
				if (coerced !== undefined) values[key] = coerced;
			}
			const record: DataRecord = { id: op.record.id, values };
			const index = doc.records.findIndex((r) => r.id === record.id);
			if (index < 0) return { ...doc, records: [...doc.records, record] };
			const prev = doc.records[index]!;
			if (JSON.stringify(prev.values) === JSON.stringify(record.values)) return doc;
			const records = doc.records.slice();
			records[index] = record;
			return { ...doc, records };
		}
		case 'remove-record': {
			if (!doc.records.some((r) => r.id === op.recordId)) return doc;
			return { ...doc, records: doc.records.filter((r) => r.id !== op.recordId) };
		}
		case 'set-cell': {
			const field = doc.fields.find((f) => f.id === op.fieldId);
			const index = doc.records.findIndex((r) => r.id === op.recordId);
			if (!field || index < 0) return doc;
			const coerced = coerce(field.type, op.value);
			if (coerced === undefined) return doc;
			const record = doc.records[index]!;
			if (sameValue(record.values[field.id] ?? null, coerced) && (coerced !== null || field.id in record.values)) {
				if (record.values[field.id] === coerced) return doc;
			}
			if (record.values[field.id] === coerced) return doc;
			const values = { ...record.values, [field.id]: coerced };
			const records = doc.records.slice();
			records[index] = { ...record, values };
			return { ...doc, records };
		}
		case 'put-view': {
			if (!op.view.id) return doc;
			const known = new Set(doc.fields.map((f) => f.id));
			const where: ViewClause[] = op.view.where.filter((c) => known.has(c.fieldId));
			const view: DataView = {
				id: op.view.id,
				name: op.view.name,
				...(op.view.selectFieldId && known.has(op.view.selectFieldId)
					? { selectFieldId: op.view.selectFieldId }
					: {}),
				...(op.view.cardinality === 'one' || op.view.cardinality === 'many'
					? { cardinality: op.view.cardinality }
					: {}),
				where
			};
			const index = doc.views.findIndex((v) => v.id === view.id);
			if (index < 0) return { ...doc, views: [...doc.views, view] };
			const prev = doc.views[index]!;
			if (JSON.stringify(prev) === JSON.stringify(view)) return doc;
			const views = doc.views.slice();
			views[index] = view;
			return { ...doc, views };
		}
		case 'remove-view': {
			if (!doc.views.some((v) => v.id === op.viewId)) return doc;
			return { ...doc, views: doc.views.filter((v) => v.id !== op.viewId) };
		}
		default: {
			const never: never = op;
			void never;
			return doc;
		}
	}
}
