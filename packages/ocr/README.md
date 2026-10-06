# @shared-packages/ocr

One engine registry for every OCR surface: the tools (`/tools/ocr`,
`/tools/scan`, `/tools/translate`'s region reads) and sketcher's
Handwriting → text adapters. Engines run locally (Tesseract.js, PaddleOCR,
docTR OnnxTR CRNN — weights pinned in the browser model store) or ride the
monitor's AI chat as `ai-vision` (transport injected by the hub; this
package never talks to the network itself).

## Layout

- `src/registry.ts` — **the** engine table. Ids, labels, langs, which
  engines adapt to sketcher handwriting, per-language weight packs. Every
  selection surface renders from this; nothing redeclares it.
- `src/engine.ts` — lazy `ocrEngine(id)` loaders; heavy glue never loads at
  module scope.
- `src/models.ts` — pinned `ModelDef`s (`hwr:paddle`, `hwr:mindee`,
  `ocr:ppocr-jpn`). Ids and hashes are stable; installed weights stay valid.
- `src/engines/*` — runtimes. `paddle.ts` stages stage tarballs for
  paddleocr-js out of the store (`tarOf`); `onnxTrCrnn.ts` runs the
  detection-free CRNN directly on ORT.
- `src/aiVision.ts` — the monitor-driven recognizer; `createAiVisionEngine`
  takes the chat transport.
- `src/tesseract.ts` — the Tesseract.js runtime (worker cache, asset paths),
  verbatim from `@shared-packages/scan`, which now re-exports it.

## Adding an engine

1. Pin its weights as a `ModelDef` in `src/models.ts` — remote URLs with
   byte counts + Blake3 (stream them with `model-store/scripts/hash-catalog.mjs`),
   and prefer upstream-pinned commits so hashes can't drift.
2. Add the registry row in `src/registry.ts` (langs, `handwriting` if
   sketcher should adapt, `langModels` for per-language packs).
3. Add the lazy loader in `src/engine.ts` and the engine in `src/engines/`.
4. Gate quality: `scripts/ocr-quality/` in scratch-pad (extension of
   `scripts/hwr-quality/`) — synthetic per-language subsets scored against
   the incumbent engines on the same pixels; a sibling design doc records
   the numbers before the engine is selectable.
5. License row in the hub's `src/lib/licenses.ts`; `weightHint` and
   `license` ride the registry row.

## Candidate verdicts (recorded 2026-10-06)

- **PP-OCRv4 Japan rec** — shipped (`ocr:ppocr-jpn`, ~9.8 MB onnx + dict;
  RapidOCR SHA-256 `e1075a67…` verified). The v5 mobile rec already handles
  English; this is the dedicated Japanese pack.
- **PARSeq (OnnxTR)** — rejected on size: `Felix92/onnxtr-parseq` ≈96.6 MB
  and `parseq-multilingual-v1` ≈193.5 MB, vs 18.1 MB for the CRNN large we
  run. No "PARSeq MobileNet" exports exist. Revisit only WebGPU-only.
- **OnnxTR DBNet det** (`onnxtr-db-mobilenet-v3-large`, ~16 MB) — next
  candidate for a full-page docTR engine (det in front of a crop CRNN);
  needs its own two-stage engine + gate.
- **TrOCR / EasyOCR / MMOCR / Donut / Surya / Nougat** — no: sizes,
  provenance, or better served as monitor-side AI.