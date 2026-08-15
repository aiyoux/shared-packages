/**
 * Non-JAB barcodes: native BarcodeDetector or zxing-wasm reader.
 * JAB: separate module, lazy-loaded only when used.
 *
 * See generate.ts for why the wasm is vendored rather than fetched from a CDN.
 */
import readerWasmUrl from './wasm/zxing_reader.wasm?url';
import { bytesToBase64url } from './encoding.js';
import { mapDetectedFormat, type BarcodeFormatType, type NonJabScannerMode, type ScannerMode } from './types.js';

export const ZXING_READER_WASM_URL = readerWasmUrl;

const locateReaderWasm = (path: string, prefix: string): string =>
  path.endsWith('.wasm') ? ZXING_READER_WASM_URL : prefix + path;

let nativeDetector: unknown = null;
let scanLoopHandle: number | null = null;
let scanCanvas: HTMLCanvasElement | null = null;

const NATIVE_FORMATS: Record<NonJabScannerMode, string[]> = {
  qr: ['qr_code'],
  qrmini: [],
  datamatrix: ['data_matrix'],
  aztec: ['aztec'],
  smart: ['qr_code', 'data_matrix', 'aztec']
};

const WASM_FORMATS: Record<NonJabScannerMode, string[]> = {
  qr: ['QRCode'],
  qrmini: ['MicroQRCode'],
  datamatrix: ['DataMatrix'],
  aztec: ['Aztec'],
  smart: ['QRCode', 'MicroQRCode', 'DataMatrix', 'Aztec']
};

export type StartScanOptions = {
  overlayCanvas?: HTMLCanvasElement | null;
  forceWasm?: boolean;
  mode?: ScannerMode;
  /**
   * Return false to keep scanning (e.g. reject corrupt / partial payloads).
   * When omitted, any non-empty trimmed text is accepted.
   */
  validate?: (text: string, format: BarcodeFormatType) => boolean | Promise<boolean>;
};

/**
 * Whether this browser can run a native BarcodeDetector for the given non-JAB mode.
 * Used by the UI to lock "Force WASM" when native is unavailable.
 */
export async function hasNativeBarcodeSupport(mode: NonJabScannerMode = 'smart'): Promise<boolean> {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false;
  try {
    let formats = [...(NATIVE_FORMATS[mode] ?? NATIVE_FORMATS.smart)];
    if (formats.length === 0) return false;
    const BD = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    if (typeof BD.getSupportedFormats === 'function') {
      const supported: string[] = await BD.getSupportedFormats();
      formats = formats.filter((f) => supported.includes(f));
      if (formats.length === 0) return false;
    }
    new BD({ formats });
    return true;
  } catch {
    return false;
  }
}

type BarcodeDetectorCtor = {
  new (opts: { formats: string[] }): { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
  getSupportedFormats?: () => Promise<string[]>;
};

type DetectedBarcode = {
  rawValue: string;
  format?: string;
  cornerPoints?: { x: number; y: number }[];
};

async function getNativeDetector(mode: NonJabScannerMode): Promise<{
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
} | null> {
  if (!(await hasNativeBarcodeSupport(mode))) return null;
  try {
    let formats = [...(NATIVE_FORMATS[mode] ?? NATIVE_FORMATS.smart)];
    const BD = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    if (typeof BD.getSupportedFormats === 'function') {
      const supported: string[] = await BD.getSupportedFormats();
      formats = formats.filter((f) => supported.includes(f));
    }
    nativeDetector = new BD({ formats });
    return nativeDetector as { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
  } catch {
    return null;
  }
}

function getWasmReaderOptions(mode: NonJabScannerMode) {
  return {
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    formats: WASM_FORMATS[mode] ?? WASM_FORMATS.smart,
    maxNumberOfSymbols: 1
  };
}

function enhanceContrastCopy(source: ImageData): ImageData {
  const copy = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  const data = copy.data;
  const contrast = 1.35;
  const intercept = 128 * (1 - contrast);
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const val = Math.min(255, Math.max(0, gray * contrast + intercept));
    data[i] = data[i + 1] = data[i + 2] = val;
  }
  return copy;
}

function parseWasmResult(
  r: {
    text: string;
    bytes?: Uint8Array;
    format?: string;
    position?: {
      topLeft?: { x: number; y: number };
      topRight?: { x: number; y: number };
      bottomRight?: { x: number; y: number };
      bottomLeft?: { x: number; y: number };
    };
  },
  mode: NonJabScannerMode
): { text: string; points: { x: number; y: number }[]; format: BarcodeFormatType } {
  let text = r.text;
  if (r.bytes && r.bytes.length > 0) {
    const printableAscii = r.bytes.every((b) => b >= 0x20 && b <= 0x7e);
    text = printableAscii ? new TextDecoder().decode(r.bytes) : bytesToBase64url(r.bytes);
  }
  const pos = r.position;
  const points = pos?.topLeft
    ? [pos.topLeft, pos.topRight, pos.bottomRight, pos.bottomLeft].filter(
        (p): p is { x: number; y: number } => !!p
      )
    : [];
  return {
    text,
    points,
    format: mapDetectedFormat(String(r.format ?? ''), mode)
  };
}

let readBarcodesFn: typeof import('zxing-wasm/reader').readBarcodes | null = null;
async function getReadBarcodes() {
  if (!readBarcodesFn) {
    const mod = await import('zxing-wasm/reader');
    mod.setZXingModuleOverrides({ locateFile: locateReaderWasm });
    readBarcodesFn = mod.readBarcodes;
  }
  return readBarcodesFn;
}

/**
 * Start continuous barcode scanning from a video element.
 *
 * - `mode === 'jabcode'`: color JAB only (no grayscale / no native / no WASM).
 * - Non-JAB (mutually exclusive backends — no cross-fallback):
 *   - forceWasm = false → native only (or WASM if native unavailable on this browser)
 *   - forceWasm = true  → WASM only
 * Dense matrix codes (DM / Aztec) are scanned on the original color frame;
 * QR / smart use a mild contrast pass.
 */
export async function startZxingScan(
  video: HTMLVideoElement,
  onResult: (data: string, format: BarcodeFormatType) => void,
  options: StartScanOptions = {}
): Promise<void> {
  const overlayCanvas = options.overlayCanvas ?? null;
  const forceWasm = options.forceWasm ?? false;
  const mode = options.mode ?? 'smart';
  const validate = options.validate;

  let hasResult = false;
  const canvas = document.createElement('canvas');
  scanCanvas = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const useJab = mode === 'jabcode';
  const nonJabMode: NonJabScannerMode =
    mode === 'qr' || mode === 'qrmini' || mode === 'datamatrix' || mode === 'aztec' ? mode : 'smart';
  const useContrast = nonJabMode === 'qr' || nonJabMode === 'smart';

  let detector: { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> } | null = null;
  let wasmOpts: ReturnType<typeof getWasmReaderOptions> | null = null;
  if (!useJab) {
    if (forceWasm) {
      wasmOpts = getWasmReaderOptions(nonJabMode);
    } else {
      detector = await getNativeDetector(nonJabMode);
      if (!detector) {
        wasmOpts = getWasmReaderOptions(nonJabMode);
      }
    }
  }

  const decodeJab = useJab ? (await import('./jabcode.js')).decodeJabCode : null;
  const readBarcodes = wasmOpts ? await getReadBarcodes() : null;

  const loop = async () => {
    if (hasResult || video.readyState !== video.HAVE_ENOUGH_DATA) {
      scanLoopHandle = requestAnimationFrame(loop);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      let detected: {
        text: string;
        points: { x: number; y: number }[];
        format: BarcodeFormatType;
      } | null = null;

      if (useJab && decodeJab) {
        const maxSide = 960;
        let jabCanvas = canvas;
        const longest = Math.max(canvas.width, canvas.height);
        if (longest > maxSide && canvas.width > 0 && canvas.height > 0) {
          const scale = maxSide / longest;
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.round(canvas.width * scale));
          tmp.height = Math.max(1, Math.round(canvas.height * scale));
          const tctx = tmp.getContext('2d');
          if (tctx) {
            tctx.imageSmoothingEnabled = true;
            tctx.imageSmoothingQuality = 'high';
            tctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
            jabCanvas = tmp;
          }
        }
        const colorDataUrl = jabCanvas.toDataURL('image/png');
        const jabResult = await decodeJab(colorDataUrl);
        if (jabResult) {
          detected = { text: jabResult, points: [], format: 'jabcode' };
        }
      } else {
        const original = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const scanData = useContrast ? enhanceContrastCopy(original) : original;
        if (useContrast) {
          ctx.putImageData(scanData, 0, 0);
        }

        if (detector) {
          try {
            const results = await detector.detect(canvas);
            if (results && results.length > 0) {
              detected = {
                text: results[0].rawValue,
                points: results[0].cornerPoints ?? [],
                format: mapDetectedFormat(results[0].format, nonJabMode)
              };
            }
          } catch {
            // native detector failed this frame
          }
        } else if (wasmOpts && readBarcodes) {
          const results = await readBarcodes(scanData, wasmOpts as Parameters<typeof readBarcodes>[1]);
          if (results && results.length > 0) {
            detected = parseWasmResult(results[0], nonJabMode);
          }
        }
      }

      if (detected && !hasResult) {
        if (validate) {
          const ok = await validate(detected.text, detected.format);
          if (!ok) {
            if (overlayCanvas) clearOverlay(overlayCanvas);
            scanLoopHandle = requestAnimationFrame(loop);
            return;
          }
        } else if (!detected.text || !detected.text.trim()) {
          scanLoopHandle = requestAnimationFrame(loop);
          return;
        }

        if (overlayCanvas && detected.points.length > 0) {
          drawOverlay(overlayCanvas, video, detected.points);
        }
        hasResult = true;
        const payload = detected.text;
        const format = detected.format;
        setTimeout(() => onResult(payload, format), 500);
      } else if (overlayCanvas && !detected) {
        clearOverlay(overlayCanvas);
      }
    } catch {
      // detection failed, keep scanning
    }

    scanLoopHandle = requestAnimationFrame(loop);
  };

  loop();
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  points: { x: number; y: number }[]
) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!points || points.length === 0) return;

  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = '#00ff00';
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function clearOverlay(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function stopZxingScan() {
  if (scanLoopHandle) {
    cancelAnimationFrame(scanLoopHandle);
    scanLoopHandle = null;
  }
  nativeDetector = null;
  scanCanvas = null;
}
