/** All supported barcode formats. `qrmini` and `jabcode` are generator-oriented. */
export type BarcodeFormatType = 'qr' | 'qrmini' | 'aztec' | 'datamatrix' | 'jabcode';

export type ScannerMode = 'smart' | 'qr' | 'qrmini' | 'datamatrix' | 'aztec' | 'jabcode';

export type BarcodeFormatOption = {
  value: BarcodeFormatType;
  label: string;
  /** When true, typically hidden from signaling / short-payload pickers */
  generatorOnly?: boolean;
};

/**
 * Canonical format list — single source for generator + consumer UIs.
 * `generatorOnly` entries (QR Mini, JAB Code) are exclusive to full generators;
 * short-payload / signaling pickers usually drop them.
 */
export const ALL_BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = [
  { value: 'qr', label: 'QR Code' },
  { value: 'qrmini', label: 'QR Mini (Micro QR)', generatorOnly: true },
  { value: 'datamatrix', label: 'Data Matrix' },
  { value: 'aztec', label: 'Aztec' },
  { value: 'jabcode', label: 'JAB Code', generatorOnly: true }
];

/** Format picker without QR Mini / JAB (signaling, compact payloads). */
export const BARCODE_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS.filter(
  (o) => !o.generatorOnly
);

/** Full generator format picker (includes QR Mini and JAB). */
export const GENERATOR_FORMAT_OPTIONS: BarcodeFormatOption[] = ALL_BARCODE_FORMAT_OPTIONS;

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

/** Non-JAB scanner sub-modes. */
export type NonJabScannerMode = 'smart' | 'qr' | 'qrmini' | 'datamatrix' | 'aztec';

export function barcodeFormatLabel(format: BarcodeFormatType): string {
  return ALL_BARCODE_FORMAT_OPTIONS.find((o) => o.value === format)?.label ?? format;
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
    mode === 'jabcode'
  ) {
    return mode;
  }
  const f = (raw ?? '').toLowerCase().replace(/[_\s-]/g, '');
  if (f.includes('jab')) return 'jabcode';
  if (f.includes('datamatrix') || f === 'matrix') return 'datamatrix';
  if (f.includes('aztec')) return 'aztec';
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
