export type {
	CellValue,
	DataDocument,
	DataDocView,
	DataRecord,
	DataView,
	DataWindowData,
	FieldDef,
	FieldType,
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

export { evaluateView, type ViewResult, type ViewRow } from './eval.js';
