/**
 * Non-JAB barcodes: zxing-wasm writer.
 * JAB: separate module, lazy-loaded only when used.
 *
 * zxing-wasm defaults to fetching its `.wasm` from a public CDN at runtime, so
 * barcode generation depended on a third party being both up and honest — and it
 * cannot pass a same-origin CSP.
 *
 * The binaries are vendored next to this module and imported as Vite assets, so
 * every consumer that bundles this package emits and serves its own copy at a
 * correct URL.
 *
 * They are copies of `node_modules/zxing-wasm/dist/**` and must be refreshed
 * when that dependency is upgraded; `zxing.wasm.test.ts` fails if they drift.
 */
import writerWasmUrl from './wasm/zxing_writer.wasm?url';
import type { EcLevel } from 'zxing-wasm/writer';
import { bytesToBase64url } from './encoding.js';
import { moduleSideFromSvg, svgToDataUrl } from './svg.js';
import {
  DEFAULT_JABCODE_COLORS,
  DEFAULT_QR_EC_LEVEL,
  type BarcodeFormatType,
  type BarcodeWriteDetails,
  type GenerateBarcodeOptions,
  type QrEcLevel
} from './types.js';

export const ZXING_WRITER_WASM_URL = writerWasmUrl;

const locateWriterWasm = (path: string, prefix: string): string =>
  path.endsWith('.wasm') ? ZXING_WRITER_WASM_URL : prefix + path;

const WRITE_FORMAT: Record<Exclude<BarcodeFormatType, 'jabcode'>, string> = {
  qr: 'QRCode',
  qrmini: 'MicroQRCode',
  datamatrix: 'DataMatrix',
  aztec: 'Aztec'
};

export function resolveGenOptions(
  third?: number | GenerateBarcodeOptions
): Required<Pick<GenerateBarcodeOptions, 'jabcodeColors' | 'qrEcLevel' | 'scale'>> {
  if (typeof third === 'number') {
    return {
      jabcodeColors: third,
      qrEcLevel: DEFAULT_QR_EC_LEVEL,
      scale: 4
    };
  }
  return {
    jabcodeColors: third?.jabcodeColors ?? DEFAULT_JABCODE_COLORS,
    qrEcLevel: third?.qrEcLevel ?? DEFAULT_QR_EC_LEVEL,
    scale: third?.scale ?? 4
  };
}

function ecLevelForFormat(
  format: Exclude<BarcodeFormatType, 'jabcode'>,
  qrEcLevel: QrEcLevel
): EcLevel | undefined {
  if (format === 'qr') return qrEcLevel;
  if (format === 'qrmini') return 'L';
  if (format === 'aztec') return '33%';
  return undefined;
}

/**
 * Generate QR / Data Matrix / Aztec / Micro QR via zxing-wasm (lazy-loaded).
 * Accepts string or raw bytes (binary is denser for DM/Aztec).
 * Prefers SVG; PNG only if SVG missing.
 */
export async function writeBarcode(
  input: string | Uint8Array,
  format: Exclude<BarcodeFormatType, 'jabcode'>,
  options: { scale?: number; qrEcLevel?: QrEcLevel } = {}
): Promise<BarcodeWriteDetails | null> {
  const scale = options.scale ?? 4;
  const qrEcLevel = options.qrEcLevel ?? DEFAULT_QR_EC_LEVEL;
  const ecLevel = ecLevelForFormat(format, qrEcLevel);
  try {
    const mod = await import('zxing-wasm/writer');
    // Must run before the first writeBarcode call, which instantiates the module.
    mod.setZXingModuleOverrides({ locateFile: locateWriterWasm });
    const { writeBarcode: zxingWrite } = mod;
    const writeOpts = {
      format: WRITE_FORMAT[format] as 'QRCode' | 'MicroQRCode' | 'DataMatrix' | 'Aztec',
      scale: 1,
      addQuietZones: true,
      ecLevel,
      forceSquareDataMatrix: format === 'datamatrix' ? true : undefined
    };
    const result = await zxingWrite(input, writeOpts);
    if (result.error) {
      console.warn(`[barcode] zxing write ${format} error:`, result.error);
      return null;
    }
    if (result.svg && result.svg.trim().length > 0) {
      return {
        dataUrl: svgToDataUrl(result.svg),
        moduleSide: moduleSideFromSvg(result.svg)
      };
    }

    const pngResult =
      scale === 1
        ? result
        : await zxingWrite(input, {
            ...writeOpts,
            scale
          });
    if (pngResult.error || !pngResult.image) {
      console.warn(`[barcode] zxing write ${format}: no image or svg`);
      return null;
    }
    const buffer = await pngResult.image.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return {
      dataUrl: `data:${pngResult.image.type || 'image/png'};base64,${btoa(binary)}`,
      moduleSide: null
    };
  } catch (err) {
    console.warn(`[barcode] zxing write ${format} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Generate a barcode from compressed / raw payload bytes.
 * Prefer raw bytes for Data Matrix / Aztec (denser). QR still uses base64url text
 * unless the caller passes a string via `base64urlString`.
 */
export async function generateBarcodeFromBytes(
  bytes: Uint8Array,
  format: BarcodeFormatType,
  jabcodeColors?: number,
  base64urlString?: string
): Promise<string | null> {
  if (format === 'datamatrix' || format === 'aztec') {
    return generateBarcode(bytes, format, { jabcodeColors, scale: 4 });
  }
  const data = base64urlString ?? bytesToBase64url(bytes);
  return generateBarcode(data, format, jabcodeColors);
}

export async function generateBarcodeFromBytesFallback(
  bytes: Uint8Array,
  format: BarcodeFormatType,
  jabcodeColors?: number,
  base64urlString?: string
): Promise<string | null> {
  if (format === 'datamatrix' || format === 'aztec') {
    return generateBarcode(bytes, format, { jabcodeColors, scale: 6 });
  }
  const data = base64urlString ?? bytesToBase64url(bytes);
  return generateBarcodeFallback(data, format, jabcodeColors);
}

export async function generateBarcode(
  data: string | Uint8Array,
  format: BarcodeFormatType,
  options?: number | GenerateBarcodeOptions
): Promise<string | null> {
  const opts = resolveGenOptions(options);
  if (format === 'jabcode') {
    const { generateJabCode } = await import('./jabcode.js');
    if (typeof data !== 'string') {
      return await generateJabCode(bytesToBase64url(data), opts.jabcodeColors);
    }
    return await generateJabCode(data, opts.jabcodeColors);
  }
  const written = await writeBarcode(data, format, {
    scale: opts.scale,
    qrEcLevel: opts.qrEcLevel
  });
  return written?.dataUrl ?? null;
}

export async function generateBarcodeFallback(
  data: string | Uint8Array,
  format: BarcodeFormatType,
  options?: number | GenerateBarcodeOptions
): Promise<string | null> {
  const opts = resolveGenOptions(options);
  if (format === 'jabcode') {
    return generateBarcode(data, format, { ...opts, scale: 6 });
  }
  const written = await writeBarcode(data, format, {
    scale: 6,
    qrEcLevel: opts.qrEcLevel
  });
  return written?.dataUrl ?? null;
}

/**
 * Generate a barcode, retrying with the larger-scale fallback if the primary fails.
 */
export async function generateBarcodeWithFallback(
  data: string | Uint8Array,
  format: BarcodeFormatType,
  options?: number | GenerateBarcodeOptions
): Promise<string | null> {
  const opts = resolveGenOptions(options);
  const primary = await generateBarcode(data, format, opts);
  if (primary) return primary;
  return generateBarcodeFallback(data, format, opts);
}
