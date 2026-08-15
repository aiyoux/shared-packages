# `@shared-packages/compress`

Lazy-loaded browser compression engines behind one pack / expand API:

- **fflate** — pure JS gzip / deflate / zlib / ZIP
- **ZipKit** (`@myrialabs/zipkit`) — one WASM engine, many codecs + ZIP
- **AddMaple** — three SIMD WASM modules (`@addmaple/gzip`, `@addmaple/brotli`, `@addmaple/lz4`)

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

## Publish

From this repo root (`~/Code/shared-packages/<worktree>`):

```bash
npm run yalc:publish -w @shared-packages/compress
```

Then in each consumer: `npm run shared:pull` (or `npx yalc add @shared-packages/compress` the first time).
