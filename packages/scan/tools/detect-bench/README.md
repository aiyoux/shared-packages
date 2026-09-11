# detect-bench

A labelled corpus for `src/detect/algorithm.ts`. The unit tests in
`src/detect/algorithm.test.ts` pin the scoring model's behaviour and run in CI;
this bench runs the *whole* detector — contour finding included — against real
OpenCV, which CI does not have.

Run it whenever you touch detection, and especially before changing anything in
`docConstants()`.

```sh
node --experimental-strip-types --import ./register.mjs scenes.cjs   # build the corpus
node --experimental-strip-types --import ./register.mjs bench.mjs    # score it
```

It borrows `opencv.js` and `sharp` from a host app rather than adding
dependencies here. Defaults point at `scratch-pad/terminal`; override with
`SCAN_BENCH_HOST`, or `SCAN_BENCH_OPENCV` / `SCAN_BENCH_SHARP`.

## What the scenes are for

Each scene isolates a way document detection goes wrong. They are deliberately
not variations on one photo.

| scene | what it pins down |
| --- | --- |
| `mat-real` | The original bug: a real phone frame of paper on a green cutting mat. |
| `mat-synth` | Same failure, different geometry, so a fix cannot be fitted to the photo. |
| `tray-grey` | A large *neutral* competitor — colour cues cannot help here. |
| `book-beside` | A big dark rectangle next to the page rather than under it. |
| `stacked-pages` | Two real documents; the smaller one on top is the answer. |
| `desk-text` | A page dense with text: interior detail must not veto a document. |
| `fills-frame` | A close-up page that legitimately fills the frame. |
| `desk-plain`, `dark-surface`, `low-contrast`, `skew-strong` | Ordinary captures across lighting and perspective. |
| `no-doc-mat`, `no-doc-desk` | **No document present.** Detection must return `null`, or auto-capture fires on the furniture. |

## Calibration

Scores measured over this corpus: real documents land at 0.87–0.99, and scenes
with no document peak at 0.37. `acceptFloor` sits at 0.6, in the middle of that
gap. If a change narrows it, the change is wrong — widen the corpus rather than
lowering the floor.

The corpus is synthetic apart from `mat-real`. Synthetic scenes are clean, so
they flatter the detector; real photographs are the better evidence. Add them to
`fixtures/` with a measured ground-truth quad as you collect them.
