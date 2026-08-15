# `@shared-packages/image`

Lazy-loaded browser image engines behind one convert / resize API:

- **native** — `createImageBitmap` + Canvas (`toBlob` / `convertToBlob`)
- **jSquash** (`@jsquash/jpeg`, `@jsquash/png`, `@jsquash/webp`, `@jsquash/resize`) — WASM, loaded only when selected

This is the library. Product UI (drop zone, engine picker, file-library save) stays in the consumer.

## Usage

```ts
import { listEngines, loadEngine, convertImage } from '@shared-packages/image';

const out = await convertImage('native', bytes, {
  format: 'jpeg',
  quality: 0.8,
  width: 800,
  name: 'photo.png'
});
```

`listEngines()` is sync and does not load WASM. `loadEngine(id)` / `convertImage`
dynamically import the chosen library on first use.

## Publish

From this repo root (`~/Code/shared-packages/<worktree>`):

```bash
npm run yalc:publish -w @shared-packages/image
```

Then in each consumer: `npx yalc add @shared-packages/image` the first time, then `npm run shared:pull`.
