export {
  ALL_BARCODE_FORMAT_OPTIONS,
  BARCODE_FORMAT_OPTIONS,
  DEFAULT_JABCODE_COLORS,
  DEFAULT_QR_EC_LEVEL,
  GENERATOR_FORMAT_OPTIONS,
  JABCODE_COLOR_OPTIONS,
  barcodeFormatLabel,
  mapDetectedFormat,
  microQrCapacityHint,
  suggestGeneratorFormat,
  type BarcodeFormatOption,
  type BarcodeFormatType,
  type BarcodeWriteDetails,
  type GenerateBarcodeOptions,
  type NonJabScannerMode,
  type QrEcLevel,
  type ScannerMode
} from './types.js';

export { base64urlToBytes, bytesToBase64url, latin1ToBase64url } from './encoding.js';

export {
  barcodeDataUrlToPng,
  barcodeFileExtension,
  dataUrlToSvgMarkup,
  downloadDataUrl,
  isSvgDataUrl,
  moduleSideFromSvg,
  normalizeBarcodeSvg,
  svgToDataUrl
} from './svg.js';

export {
  ZXING_WRITER_WASM_URL,
  generateBarcode,
  generateBarcodeFallback,
  generateBarcodeFromBytes,
  generateBarcodeFromBytesFallback,
  generateBarcodeWithFallback,
  resolveGenOptions,
  writeBarcode
} from './generate.js';

export {
  ZXING_READER_WASM_URL,
  hasNativeBarcodeSupport,
  startZxingScan,
  stopZxingScan,
  type StartScanOptions
} from './scan.js';

export { decodeJabCode, generateJabCode, JAB_COLOR_OPTIONS, normalizeJabColors } from './jabcode.js';
export type { JabColorCount } from './jabcode.js';
