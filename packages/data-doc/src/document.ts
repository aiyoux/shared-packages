import type {
	CellValue,
	DataDocument,
	DataDocView,
	DataRecord,
	DataView,
	FieldDef,
	FieldType,
	ViewClause,
	ViewCompare
} from './types.js';

export class DataParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DataParseError';
	}
}

const FIELD_TYPES = new Set<FieldType>(['string', 'int', 'float', 'boolean', 'date']);
const VIEW_OPS = new Set<ViewCompare>(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new DataParseError(`${field} must be a non-empty string`);
	return value;
}

function decodeInput(input: unknown): unknown {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			throw new DataParseError('invalid JSON');
		}
	}
	if (input instanceof Uint8Array) {
		return decodeInput(new TextDecoder().decode(input));
	}
	return input;
}

function cellValue(value: unknown): CellValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return null;
}

function parseField(raw: unknown, index: number): FieldDef {
	if (!isRecord(raw)) throw new DataParseError(`fields[${index}] must be an object`);
	const type = raw.type;
	if (typeof type !== 'string' || !FIELD_TYPES.has(type as FieldType)) {
		throw new DataParseError(`fields[${index}].type is unknown`);
	}
	return {
		id: nonEmpty(raw.id, `fields[${index}].id`),
		name: typeof raw.name === 'string' ? raw.name : '',
		type: type as FieldType
	};
}

function parseRecord(raw: unknown, index: number): DataRecord {
	if (!isRecord(raw)) throw new DataParseError(`records[${index}] must be an object`);
	const values: Record<string, CellValue> = {};
	if (isRecord(raw.values)) {
		for (const [key, value] of Object.entries(raw.values)) {
			if (!key) continue;
			values[key] = cellValue(value);
		}
	}
	return { id: nonEmpty(raw.id, `records[${index}].id`), values };
}

function parseClause(raw: unknown, index: number): ViewClause | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.fieldId !== 'string' || !raw.fieldId) return null;
	if (typeof raw.op !== 'string' || !VIEW_OPS.has(raw.op as ViewCompare)) return null;
	return { fieldId: raw.fieldId, op: raw.op as ViewCompare, value: cellValue(raw.value) };
}

function parseView(raw: unknown, index: number): DataView {
	if (!isRecord(raw)) throw new DataParseError(`views[${index}] must be an object`);
	const where = Array.isArray(raw.where)
		? raw.where.map(parseClause).filter((c): c is ViewClause => c != null)
		: [];
	const select =
		typeof raw.selectFieldId === 'string' && raw.selectFieldId ? raw.selectFieldId : undefined;
	return {
		id: nonEmpty(raw.id, `views[${index}].id`),
		name: typeof raw.name === 'string' ? raw.name : '',
		...(select ? { selectFieldId: select } : {}),
		where
	};
}

function optionalId(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	return value;
}

function optionalCreatedAt(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return value;
}

export function parseDataDocument(input: Uint8Array | string | unknown): DataDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new DataParseError('document must be an object');
	if (raw.schemaVersion !== 1) throw new DataParseError('schemaVersion must be 1');
	const fields = Array.isArray(raw.fields) ? raw.fields.map(parseField) : [];
	const fieldIds = new Set(fields.map((f) => f.id));
	const records = (Array.isArray(raw.records) ? raw.records.map(parseRecord) : []).map((record) => {
		const values: Record<string, CellValue> = {};
		for (const [key, value] of Object.entries(record.values)) {
			if (fieldIds.has(key)) values[key] = value;
		}
		return { ...record, values };
	});
	const views = (Array.isArray(raw.views) ? raw.views.map(parseView) : []).map((view) => ({
		...view,
		...(view.selectFieldId && fieldIds.has(view.selectFieldId)
			? { selectFieldId: view.selectFieldId }
			: {}),
		where: view.where.filter((c) => fieldIds.has(c.fieldId))
	}));
	const id = optionalId(raw.id);
	const createdAt = optionalCreatedAt(raw.createdAt);
	return {
		schemaVersion: 1,
		...(id ? { id } : {}),
		...(createdAt !== undefined ? { createdAt } : {}),
		fields,
		records,
		views: views.map((view) => {
			const next: DataView = { id: view.id, name: view.name, where: view.where };
			if (view.selectFieldId) next.selectFieldId = view.selectFieldId;
			return next;
		})
	};
}

function persistField(field: FieldDef): FieldDef {
	return { id: field.id, name: field.name, type: field.type };
}

function persistRecord(record: DataRecord): DataRecord {
	return { id: record.id, values: { ...record.values } };
}

function persistView(view: DataView): DataView {
	return {
		id: view.id,
		name: view.name,
		...(view.selectFieldId ? { selectFieldId: view.selectFieldId } : {}),
		where: view.where.map((c) => ({ fieldId: c.fieldId, op: c.op, value: c.value }))
	};
}

export function serializeDataDocument(doc: DataDocument): string {
	return JSON.stringify({
		schemaVersion: 1,
		...(doc.id ? { id: doc.id } : {}),
		...(doc.createdAt !== undefined ? { createdAt: doc.createdAt } : {}),
		fields: doc.fields.map(persistField),
		records: doc.records.map(persistRecord),
		views: doc.views.map(persistView)
	});
}

function mintId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ensureDataIdentity(doc: DataDocument): DataDocument {
	const id = optionalId(doc.id) ?? mintId();
	const createdAt = optionalCreatedAt(doc.createdAt) ?? Date.now();
	if (doc.id === id && doc.createdAt === createdAt) return doc;
	return { ...doc, id, createdAt };
}

export function emptyDataDocument(): DataDocument {
	const fieldId = mintId();
	return ensureDataIdentity({
		schemaVersion: 1,
		fields: [{ id: fieldId, name: 'Name', type: 'string' }],
		records: [],
		views: [{ id: mintId(), name: 'Names', selectFieldId: fieldId, where: [] }]
	});
}

export function parseDataView(raw: unknown): DataDocView | undefined {
	if (!isRecord(raw)) return undefined;
	const windows: Record<string, { role: string }> = {};
	if (isRecord(raw.windows)) {
		for (const [leafId, entry] of Object.entries(raw.windows)) {
			if (!isRecord(entry) || typeof entry.role !== 'string' || !entry.role) return undefined;
			windows[leafId] = { role: entry.role };
		}
	}
	const view: DataDocView = {};
	if (isRecord(raw.layout)) view.layout = raw.layout;
	if (Object.keys(windows).length) view.windows = windows;
	return view;
}
