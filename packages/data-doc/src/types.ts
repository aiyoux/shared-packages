export type FieldType = 'string' | 'int' | 'float' | 'boolean' | 'date';

export type FieldDef = {
	id: string;
	name: string;
	type: FieldType;
};

/** A cell. Dates are `YYYY-MM-DD` strings so they sort and compare as text. */
export type CellValue = string | number | boolean | null;

export type DataRecord = {
	id: string;
	values: Record<string, CellValue>;
};

export type ViewCompare = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

export type ViewClause = {
	fieldId: string;
	op: ViewCompare;
	value: CellValue;
};

/**
 * A named transform over the records. `where` clauses are AND-ed. `selectFieldId`
 * is the column the view returns; omit it to return every field of each match.
 */
export type DataView = {
	id: string;
	name: string;
	selectFieldId?: string;
	where: ViewClause[];
};

export type DataDocument = {
	schemaVersion: 1;
	id?: string;
	createdAt?: number;
	fields: FieldDef[];
	records: DataRecord[];
	views: DataView[];
};

export type DataWindowData = { role: string };

export type DataDocView = {
	layout?: unknown;
	windows?: Record<string, DataWindowData>;
};
