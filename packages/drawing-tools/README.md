# @shared-packages/drawing-tools

Headless 2D drawing primitives shared by `~/Code/svg-sketcher` and
`~/Code/web_social_games`. Pure TypeScript logic + types — no Svelte, no DOM.
The erase worker is a separate entry (`./worker`).

Extracted from svg-sketcher's `src/lib/utils/` (brush, path, raster, clipping,
eraser, eraseDelta, id) and the 2D subset of `src/lib/types/scene.ts`. The 3D
caricature pipeline (three.js, bake, mesh, camera, hiddenLine, svgBake,
tempBake) is app-specific and stays in svg-sketcher.

## Entries

- `@shared-packages/drawing-tools` — barrel: types, brush, path, raster,
  clipping, eraseDelta, eraser, id.
- `@shared-packages/drawing-tools/worker` — `eraser.worker.ts` (off-main-thread
  erase; loads clipper2-wasm and injects it via `setClipper2Module`).
- `@shared-packages/drawing-tools/types` — the 2D drawing model
  (`PathData`, `LayerData`, `ImportedImage`, `EraserPath`) and the re-exported
  `Ring`/`Polygon`/`MultiPolygon` geometry types.

## Clipping engines

`clipping.ts` runs Clipper2 (wasm) as the fast path and falls back to
`polygon-clipping` (Martinez, pure JS) if Clipper2 isn't installed/active or
throws — the safety net the erase regression tests run on. `clipper2-wasm` is
a runtime dependency so the fast path is available; `polygon-clipping` is the
fallback and the source of the polygon structural types.

## Tests

```
cd packages/drawing-tools
npm install
npm test
```

Mirrors svg-sketcher's `node --test` runner (Node >=22.7 strips TS). The 13
moved tests + 3 fixtures are the regression suite that svg-sketcher's
Phase-2 consumer swap must keep green.

## Local sharing

Consumers depend on this package via `file:`. Edit here and they HMR. Run
`npm install` in a consumer only when `exports` change.