# `@shared-packages/vectorize`

Lazy raster → SVG engines for the hub Images tool.

- **VTracer 1.0** — our `wasm32-unknown-unknown` build of the same crate the desktop app uses (`simplify`, cutout, watershed, adaptive B/W).
- **Potrace** — `esm-potrace-wasm` (GPL-2.0).

Rebuild WASM after crate changes:

```bash
npm run build:wasm -w @shared-packages/vectorize
```

Consumers depend on this package via `file:`. Edit here and they HMR. Run `npm install` in a consumer only when `exports` change.
