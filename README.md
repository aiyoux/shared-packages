# Shared Packages

This repository contains packages that are genuinely shared across app and module repositories:

- `packages/ui`: Shared UI component library (Svelte components) plus its `date/` subpath — canonical date types/helpers used by the components.
- `packages/drawing-tools`: Headless 2D drawing primitives shared by Creative/sketcher apps.
- `packages/file-system`: Browser VFS (Dexie + OPFS), FileExplorer UI, and optional Backblaze B2 remote browser (`@shared-packages/file-system/b2`). Host apps keep thin control-plane proxy routes.
- `packages/barcode`: Browser barcode generate + scan API (QR / Micro QR / Data Matrix / Aztec / JAB). Vendored `zxing-wasm` — no CDN. Product UI and signaling stay in the consumer.
- `packages/component-library`: A demo/dev app for developing and previewing `ui`'s components. Not published.

`module-sdk`, `item-tree`, and `shell-core` used to live here but were modular-app-specific (a SurrealDB sync engine, offline cache, domain schedulers, the record model, domain UI editors) — they've moved into `modular-app` as first-party workspace packages (`repos/module-sdk`, `repos/item-tree`, `repos/shell-core`). Prefer generic reusable primitives and storage/UI infrastructure here; keep product-specific routes and session glue in consumer apps.

---

## Local Development Workflow (`file:`)

Consumers under `~/Code` (e.g. `modular-app`, `sign-dictionary`, `scratch-pad`) depend on these packages via `file:` paths that resolve to this repo. This tree is the source of truth. There is no snapshot publish step.

1. Edit a package here. A running consumer Vite/SvelteKit dev server HMR-picks up the change.
2. Run `npm install` in a consumer only when a package's `exports` map (or other `package.json` fields npm resolves) changes. Ordinary source edits do not need a consumer install.

Do not edit a consumer's `node_modules/@shared-packages/...` copy. Fixes belong here.

---

## Future Transition to a Remote NPM Registry

If you decide to publish these packages to a private or public NPM registry in the future (e.g. `@shared-packages/ui` on npmjs.org or GitHub Packages):

1. **Publish to the Registry**:
   Set up authentication and publish all packages:
   ```bash
   npm publish --workspaces --access public
   ```
2. **Point consumers at the registry**:
   Replace the `file:` dependency with a published version:
   ```bash
   npm install @shared-packages/ui@latest
   ```
