# `@shared-packages/compress`

Lazy-loaded browser compression engines behind one pack / expand API:

- **fflate** — pure JS gzip / deflate / zlib / ZIP
- **ZipKit** (`@myrialabs/zipkit`) — one WASM engine, many codecs + ZIP
- **AddMaple** — three SIMD WASM modules (`@addmaple/gzip`, `@addmaple/brotli`, `@addmaple/lz4`)
- **zip.js** (`@zip.js/zip.js`) — ZIP with Zip64 / encryption / Deflate64 (BSD-3-Clause)
- **libarchive** (`libarchive-wasm`) — extract-only ZIP, TAR, 7z, RAR (MIT)

This is the library. Product UI (drop zone, engine picker) stays in the consumer.

## Usage

```ts
import {
  listEngines,
  loadEngine,
  packFiles,
  expandBytes,
  detectFormat
} from '@shared-packages/compress';

const packed = await packFiles('fflate', [{ name: 'note.txt', data: bytes }], 'gzip');
const [out] = packed;
const files = await expandBytes('fflate', out.data, 'gzip', out.name);
```

`listEngines()` is sync and does not load WASM. `loadEngine(id)` / `packFiles` /
`expandBytes` dynamically import the chosen library on first use.

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run `npm install` in a consumer only when `exports` change.
