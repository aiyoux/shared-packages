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

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run `npm install` in a consumer only when `exports` change.
