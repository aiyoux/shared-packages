# `@shared-packages/scan`

Browser **document scan** core: lazy **OpenCV.js** page detect + perspective warp, optional enhance / OCR, multi-page PDF.

Product chrome (camera, overlay, corner handles, session list) stays in the consumer.

## API

```ts
import { loadScanEngine, commitScan, pagesToPdf, QuadLock } from '@shared-packages/scan';

const engine = await loadScanEngine({ opencvUrl: '/vendor/opencv.js' });
const quad = await engine.detectQuad(frame);
const page = await commitScan(fullRes, quad, { enhance: true, ocr: false });
const pdf = await pagesToPdf([page]);
```

`loadScanEngine()` fetches `opencv.js` on the main thread (progress via `onProgress`) then parses and initializes it in a Web Worker so the UI does not freeze. `detectQuad` / `warp` / `enhance` are async RPCs into that worker.

`loadScanEngine()` / `commitScan()` / `recognizeText()` / `pagesToPdf()` dynamically import their libraries on first use.

The OCR recognizers (`recognizeText` / `recognizeDetailed` and the engine
registry behind them) now live in [`@shared-packages/ocr`](../ocr/README.md) —
this package re-exports them for compatibility; the engine table, engines and
model defs are declared there.

## Detectors

```ts
const engine = await loadScanEngine({
  detector: 'docquad', // 'opencv' | 'scanic' | 'docquad' | 'docaligner' | 'yolo-pose'
  modelUrl: 'https://…/docquad.onnx' // required for docquad, docaligner, yolo-pose
});
```

`SCAN_DETECTORS` / `SCAN_DETECTOR_ORDER` / `resolveDetectorId()` in
`src/detectors.ts` are the single registry: label, runtime, license, weight
provenance, and whether a model URL is required. `opencv` is the default and
needs no weights. Learned detectors download weights on first use into the
browser HTTP cache and run in onnxruntime-web; warp is the shared pure-JS
perspective warp and enhance delegates to the OpenCV worker. Selection is the
consumer's job (persist the exact id, repair only unknown ids to `opencv`,
never silently swap a working detector) — see the scan tool's detector picker.
No weight URLs are invented here: configure per deployment after checking each
model's license.

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run `npm install` in a consumer only when `exports` change.
