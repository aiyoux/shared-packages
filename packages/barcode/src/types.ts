/** Retail 1D formats (numeric GTIN / UPC / EAN). */
export type LinearBarcodeFormatType = 'ean13' | 'ean8' | 'upca' | 'upce';

/** All supported barcode formats. `qrmini` and `jabcode` are generator-oriented. */
export type BarcodeFormatType =
  | 'qr'
  | 'qrmini'
  | 'aztec'
  | 'datamatrix'
  | 'jabcode'
  | LinearBarcodeFormatType;

/**
 * Scanner modes. `eanupc` is a detect-any-retail-1D group (not a generator format).
 * Individual `ean13` / `ean8` / `upca` / `upce` lock the reader to that variant.
 */
export type ScannerMode =
  | 'smart'
  | 'qr'
  | 'qrmini'
  | 'datamatrix'
  | 'aztec'
  | 'jabcode'
  | 'eanupc'
  | LinearBarcodeFormatType;

export type BarcodeFormatOption = {
  value: BarcodeFormatType;
  label: string;
  /** When true, typically hidden from signaling / short-payload pickers */
  generatorOnly?: boolean;
  /** Retail 1D — digits only; omit from URL / signaling pickers. */
  linear?: boolean;
};

/**
 * Canonical format list — single source for generator + consumer UIs.
 * `generatorOnly` entries (QR Mini, JAB Code) are exclusive to full generators;
 * short-payload / signaling pickers usually drop them.
 * `linear` entries (EAN / UPC) are exclusive to product / inventory pickers.
 */
export const ALL_BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = [
  { value: 'qr', label: 'QR Code' },
  { value: 'qrmini', label: 'QR Mini (Micro QR)', generatorOnly: true },
  { value: 'datamatrix', label: 'Data Matrix' },
  { value: 'aztec', label: 'Aztec' },
  { value: 'ean13', label: 'EAN-13', linear: true },
  { value: 'ean8', label: 'EAN-8', linear: true },
  { value: 'upca', label: 'UPC-A', linear: true },
  { value: 'upce', label: 'UPC-E', linear: true },
  { value: 'jabcode', label: 'JAB Code', generatorOnly: true }
];

/** Format picker without QR Mini / JAB / 1D (signaling, compact text payloads). */
export const BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS.filter(
  (o) => !o.generatorOnly && !o.linear
);

/** Retail 1D picker (EAN-13 / EAN-8 / UPC-A / UPC-E). */
export const LINEAR_BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS.filter(
  (o) => o.linear
);

/**
 * Product picker: 2D (QR / Data Matrix / Aztec) plus retail 1D.
 * Drops QR Mini and JAB.
 */
export const PRODUCT_BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS.filter(
  (o) => !o.generatorOnly
);

/** Full generator format picker (includes QR Mini and JAB). */
export const GENERATOR_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS;

export function isLinearBarcodeFormat(
  format: string | null | undefined
): format is LinearBarcodeFormatType {
  return format === 'ean13' || format === 'ean8' || format === 'upca' || format === 'upce';
}

/** Strip spaces / dashes / other non-digits so "590 1234 12345 7" encodes. */
export function normalizeLinearDigits(text: string): string {
  return (text ?? '').replace(/\D/g, '');
}

/** JAB color-count options. */
export const JABCODE_COLOR_OPTIONS: { value: number; label: string }[] = [
  { value: 4, label: '4 colors' },
  { value: 8, label: '8 colors (recommended)' },
  { value: 16, label: '16 colors' },
  { value: 32, label: '32 colors' },
  { value: 64, label: '64 colors' },
  { value: 128, label: '128 colors' }
];

export const DEFAULT_JABCODE_COLORS = 8;

/** QR error correction. Default M balances size vs screen/camera reliability. */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';
export const DEFAULT_QR_EC_LEVEL: QrEcLevel = 'M';

export type GenerateBarcodeOptions = {
  jabcodeColors?: number;
  /** Standard QR only. Micro QR always uses L. Default M. */
  qrEcLevel?: QrEcLevel;
  /** Module scale for PNG fallback only (SVG is always scale 1). */
  scale?: number;
};

export type BarcodeWriteDetails = {
  dataUrl: string;
  /** Approximate module canvas side from SVG (null for PNG-only). */
  moduleSide: number | null;
};

/** Non-JAB scanner sub-modes (includes the EAN/UPC group). */
export type NonJabScannerMode = Exclude<ScannerMode, 'jabcode'>;

export function barcodeFormatLabel(format: BarcodeFormatType): string {
  return ALL_BARCODE_FORMAT_OPTIONS.find((o) => o.value === format)?.label ?? format;
}

const LINEAR_DIGIT_LENGTH: Record<LinearBarcodeFormatType, { min: number; max: number; label: string }> =
  {
    ean13: { min: 12, max: 13, label: 'EAN-13' },
    ean8: { min: 7, max: 8, label: 'EAN-8' },
    upca: { min: 11, max: 12, label: 'UPC-A' },
    upce: { min: 6, max: 8, label: 'UPC-E' }
  };

/**
 * EAN / UPC only encode digits of a fixed length (checksum optional — zxing
 * will add it when one digit short). Returns null if it looks plausible.
 */
export function eanUpcCapacityHint(
  text: string,
  format: LinearBarcodeFormatType
): string | null {
  const spec = LINEAR_DIGIT_LENGTH[format];
  const digits = normalizeLinearDigits(text);
  if (!digits) {
    return `${spec.label} needs ${spec.min}–${spec.max} digits (you have none).`;
  }
  if (digits.length < spec.min || digits.length > spec.max) {
    return `${spec.label} needs ${spec.min}–${spec.max} digits (you have ${digits.length}).`;
  }
  return null;
}

/** Map native BarcodeDetector / zxing-wasm format strings to our format ids. */
export function mapDetectedFormat(
  raw: string | undefined | null,
  mode: ScannerMode = 'smart'
): BarcodeFormatType {
  if (
    mode === 'qr' ||
    mode === 'qrmini' ||
    mode === 'datamatrix' ||
    mode === 'aztec' ||
    mode === 'jabcode' ||
    isLinearBarcodeFormat(mode)
  ) {
    return mode;
  }
  const f = (raw ?? '').toLowerCase().replace(/[_\s-]/g, '');
  if (f.includes('jab')) return 'jabcode';
  if (f.includes('datamatrix') || f === 'matrix') return 'datamatrix';
  if (f.includes('aztec')) return 'aztec';
  if (f.includes('ean8')) return 'ean8';
  if (f.includes('ean13') || f === 'ean' || f === 'eanupc') return 'ean13';
  if (f.includes('upce')) return 'upce';
  if (f.includes('upca') || f.includes('upc')) return 'upca';
  if (f.includes('microqr') || f.includes('micro')) return 'qrmini';
  if (f.includes('rmqr')) return 'qr';
  if (f.includes('qr')) return 'qr';
  return 'qr';
}

/**
 * Micro QR (M1–M4) is intentionally tiny. Lowercase / mixed text uses byte mode,
 * which tops out around ~15 data bytes at M4-L — far below the ~35 alphanumeric figure.
 * Returns null if it looks plausible; otherwise a short reason for the UI.
 */
export function microQrCapacityHint(text: string): string | null {
  const t = text ?? '';
  if (!t) return null;
  const isAlnum = /^[0-9A-Z $%*+\-./:]*$/.test(t);
  if (isAlnum) {
    if (t.length > 21) {
      return `QR Mini max is roughly 21 alphanumeric characters (you have ${t.length}). Use standard QR.`;
    }
    return null;
  }
  const bytes = new TextEncoder().encode(t).length;
  if (bytes > 15) {
    return `QR Mini holds ~15 bytes in byte mode (lowercase/URLs). Yours is ${bytes} bytes — use standard QR, or shorten / use UPPERCASE.`;
  }
  return null;
}

/** Suggest a generator format for the current content (null = no strong suggestion). */
export function suggestGeneratorFormat(text: string): {
  format: BarcodeFormatType;
  reason: string;
} | null {
  const t = text.trim();
  if (!t) return null;

  const digits = normalizeLinearDigits(t);
  const stripped = t.replace(/[\s-]/g, '');
  if (digits.length >= 6 && digits === stripped) {
    if (digits.length === 13) {
      return { format: 'ean13', reason: '13 digits — EAN-13 (retail GTIN).' };
    }
    if (digits.length === 12) {
      return { format: 'upca', reason: '12 digits — UPC-A (retail).' };
    }
    if (digits.length === 8) {
      return { format: 'ean8', reason: '8 digits — EAN-8 (compact retail).' };
    }
    if (digits.length === 6 || digits.length === 7) {
      return { format: 'upce', reason: `${digits.length} digits — UPC-E (compact UPC).` };
    }
  }

  const miniBlocked = microQrCapacityHint(t);
  const bytes = new TextEncoder().encode(t).length;

  if (!miniBlocked && bytes <= 15) {
    return {
      format: 'qrmini',
      reason: 'Short enough for QR Mini (compact tag).'
    };
  }
  if (bytes <= 200) {
    if (miniBlocked) {
      return {
        format: 'qr',
        reason: 'Too large for QR Mini — standard QR is the best default.'
      };
    }
    return null;
  }
  if (bytes <= 800) {
    return {
      format: 'datamatrix',
      reason: 'Longer payload — Data Matrix is often denser than QR for bulk text.'
    };
  }
  return {
    format: 'jabcode',
    reason: 'Very large payload — try JAB (more colors) or Data Matrix.'
  };
}
