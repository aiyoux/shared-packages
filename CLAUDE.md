# shared-packages

Canonical source for the published shared packages:

| Package | Path | Consumers |
|---------|------|-----------|
| `@shared-packages/ui` | `packages/ui` | `~/Code/modular-app`, `~/Code/sign-dictionary` |
| `@shared-packages/file-system` | `packages/file-system` | `~/Code/scratch-pad` (all worktrees) |
| `@shared-packages/barcode` | `packages/barcode` | `~/Code/scratch-pad` (generate + scan API) |
| `@shared-packages/compress` | `packages/compress` | `~/Code/scratch-pad` (lazy fflate / ZipKit / AddMaple pack+expand) |
| `@shared-packages/crypto` | `packages/crypto` | `~/Code/scratch-pad` (Web Crypto / libsodium hash + .spvault) |
| `@shared-packages/image` | `packages/image` | `~/Code/scratch-pad` (native Canvas / jSquash convert+resize) |
| `@shared-packages/video` | `packages/video` | `~/Code/scratch-pad` hub Video tool + Language Hub (lazy WebCodecs / FFmpeg trim+export) |
| `@shared-packages/composition` | `packages/composition` | `~/Code/scratch-pad` (clock, clip protocol, composite; no infographic/video import) |
| `@shared-packages/scan` | `packages/scan` | `~/Code/scratch-pad` hub Scan tool (lazy OpenCV.js detect/warp + optional OCR) |
| `@shared-packages/scene-bake` | `packages/scene-bake` | `~/Code/scratch-pad` sketcher temp-bake + infographic `scene3d` (software SVG encode + hidden-line worker) |

Plus `packages/component-library`, the dev/demo app for `ui` (not published).

This is the **only editable copy** of these packages. Consumers depend on them via `file:` paths that resolve here. Do not edit a consumer's `node_modules/@shared-packages/<pkg>/` copy — that is a link into this tree, and a direct edit there is still an edit here (or a broken install). Fixes belong in this repo.

That has already cost real work twice: a `module-sdk` scheduler rewrite in modular-app, and the `file-system` VFS work in scratch-pad (recursive trash restore, generation-check-before-write, `opfs.listTmp` mtimes, `serialize`'s defensive buffer copy, `sanitizeName`'s `/g` flag). The latter was recovered from stale consumer checkouts and now lives in `packages/file-system` — if those implementations look "extra" next to what you'd write, they are the correct ones.

`module-sdk`, `item-tree`, and `shell-core` used to live here too but were modular-app-specific business logic (sync engine, offline cache, schedulers, record model) rather than shared UI-library code — they moved into `~/Code/modular-app` as first-party workspace packages (`repos/module-sdk`, `repos/item-tree`, `repos/shell-core`), edited directly there with no publish/pull cycle. Keep it that way: nothing app-specific belongs back in this repo.

## Workflow: edit here, consumers HMR

There is no snapshot publish step. Consumers use `file:` SoT, so a running consumer Vite/SvelteKit dev server HMR-picks up ordinary source edits in this repo.

Run `npm install` in a consumer only when a package's `exports` map (or other `package.json` fields npm resolves) changes. Source-only edits do not need a consumer install.

## Testing

Run each package's own test suite from its directory here (e.g. `cd packages/file-system && npx vitest run`).

## If you're mid-refactor across multiple packages

It's fine for this repo to have uncommitted, in-progress changes spanning several packages — that's normal working state here. Consumers on `file:` see those edits live.
