export type {
	CellValue,
	DataDocument,
	DataDocView,
	DataRecord,
	DataView,
	DataWindowData,
	FieldDef,
	FieldType,
	ViewCardinality,
	ViewClause,
	ViewCompare
} from './types.js';

export {
	DataParseError,
	emptyDataDocument,
	ensureDataIdentity,
	parseDataDocument,
	parseDataView,
	serializeDataDocument
} from './document.js';

export { applyDataOp, type DataOp } from './ops.js';

export { evaluateView, viewOutputShape, type ViewResult, type ViewRow, type ViewScalar } from './eval.js';
