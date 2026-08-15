# `@shared-packages/barcode`

Browser barcode **generate** and **scan** API:

- QR, Micro QR, Data Matrix, Aztec via vendored `zxing-wasm` (no CDN fetch)
- JAB Code via a rebuilt Emscripten module (lazy-loaded)
- Native `BarcodeDetector` when the browser actually supports the requested format

This is the library. Product UI (format pickers, camera chrome) and app-specific
signaling (Connections offer/answer payloads, magic-link QR choice) stay in the
consumer.

## Usage

```ts
import {
  generateBarcodeWithFallback,
  startZxingScan,
  stopZxingScan
} from '@shared-packages/barcode';

const dataUrl = await generateBarcodeWithFallback('https://example.com', 'qr');

await startZxingScan(videoEl, (text, format) => {
  console.log(format, text);
}, {
  overlayCanvas,
  forceWasm: true,
  mode: 'smart'
});
```

Consumers that need to reject partial reads (e.g. Connections transfer payloads)
pass `validate` to `startZxingScan` — that check is not built into this package.

## Vendored wasm

`src/wasm/zxing_{writer,reader}.wasm` are copies of `node_modules/zxing-wasm/dist/**`.
Refresh them when upgrading `zxing-wasm`; `src/zxing.wasm.test.ts` fails if they drift.

## Publish

From this repo root (`~/Code/shared-packages/<worktree>`):

```bash
npm run yalc:publish -w @shared-packages/barcode
```

Then in each consumer: `npm run shared:pull`.
