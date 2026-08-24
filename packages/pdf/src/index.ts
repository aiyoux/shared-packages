export type {
	PdfHandle,
	PdfInterpretResult,
	PdfInterpretStats,
	PdfIrElement,
	PdfIrGroupElement,
	PdfIrImageElement,
	PdfIrPathElement,
	PdfIrRasterChip,
	PdfIrTextElement,
	PdfPageFit,
	PdfPageSize,
	PdfRasterResult,
	PdfTransform
} from './types.js';

export { openPdf, pageCount, pageSizePt, destroy, resetPdfEngineForTests } from './engine.js';
export { renderRaster } from './raster.js';
export { interpretPage } from './interpret.js';
export { irToSvg } from './svg.js';
export { paintIr } from './paint.js';
export {
	parsePageRange,
	calculatePageFit,
	clampPageDimension,
	PDF_FILE_SIZE_WARN_BYTES,
	PDF_PAGE_COUNT_WARN,
	PDF_PAGE_DIM_MIN,
	PDF_PAGE_DIM_MAX
} from './range.js';
