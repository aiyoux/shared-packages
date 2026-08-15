# `@shared-packages/scan`

Browser **document scan** core: lazy **OpenCV.js** page detect + perspective warp, optional enhance / OCR, multi-page PDF.

Product chrome (camera, overlay, corner handles, session list) stays in the consumer.

## API

```ts
import { loadScanEngine, commitScan, pagesToPdf, QuadLock } from '@shared-packages/scan';

const engine = await loadScanEngine(); // pulls OpenCV.js once
const quad = engine.detectQuad(frame);
const page = await commitScan(fullRes, quad, { enhance: true, ocr: false });
const pdf = await pagesToPdf([page]);
```

`loadScanEngine()` / `commitScan()` / `recognizeText()` / `pagesToPdf()` dynamically import their libraries on first use.

## Publish

```bash
npm run yalc:publish -w @shared-packages/scan
```
