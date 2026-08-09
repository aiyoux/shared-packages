# Shared Packages

This repository contains packages that are genuinely shared across app and module repositories:

- `packages/ui`: Shared UI component library (Svelte components) plus its `date/` subpath — canonical date types/helpers used by the components.
- `packages/drawing-tools`: Headless 2D drawing primitives shared by Creative/sketcher apps.
- `packages/file-system`: Browser VFS (Dexie + OPFS), FileExplorer UI, and optional Backblaze B2 remote browser (`@shared-packages/file-system/b2`). Host apps keep thin control-plane proxy routes.
- `packages/component-library`: A demo/dev app for developing and previewing `ui`'s components. Not published.

`module-sdk`, `item-tree`, and `shell-core` used to live here but were modular-app-specific (a SurrealDB sync engine, offline cache, domain schedulers, the record model, domain UI editors) — they've moved into `modular-app` as first-party workspace packages (`repos/module-sdk`, `repos/item-tree`, `repos/shell-core`). Prefer generic reusable primitives and storage/UI infrastructure here; keep product-specific routes and session glue in consumer apps.

---

## Local Development Workflow (yalc)

For local development and cross-app sharing across projects under `~/Code` (e.g., `modular-app`, `sign-dictionary`), we use **`yalc`** to publish and link `ui` locally without registry overhead.

### 1. Register/Publish the Package Locally
To publish `ui` to your local yalc registry:
```bash
# From the root of shared-packages
npm install
npm run yalc:publish
```
This registers `@modular@shared-packages/ui` into the local `~/.yalc` store.

### 2. Consume the Package in Consumer Applications
In your consumer application (e.g., `~/Code/modular-app` or `~/Code/sign-dictionary`), link the package:

#### Option A: Link the package with `package.json` updates (Default)
Adds a reference to `.yalc/` directly into your `package.json` dependencies:
```bash
yalc add @modular@shared-packages/ui
npm install
```
*To undo this and revert to your original pre-yalc dependencies:*
```bash
yalc retreat --all
npm install
```

#### Option B: Clean/Pure local injection (No `package.json` modifications)
If you want to keep your `package.json` pointing to an NPM registry or Git version (e.g., `"^0.1.0"`) for remote deployments/CI, but override it locally:
```bash
yalc add @modular@shared-packages/ui --pure
```
*   `--pure` places the files inside `node_modules` without modifying your `package.json`.
*   Running `npm install` on any server or local repo will fetch from the registry normally, completely ignoring the yalc local override.

---

## Future Transition to a Remote NPM Registry

If you decide to publish these packages to a private or public NPM registry in the future (e.g., `@modular@shared-packages/ui` on npmjs.org or GitHub Packages):

1. **Publish to the Registry**:
   Set up authentication and publish all packages:
   ```bash
   npm publish --workspaces --access public
   ```
2. **Revert Yalc Locally**:
   Run the retreat command in your consumer applications to clean up the yalc configurations:
   ```bash
   yalc retreat --all
   ```
3. **Point to Registry**:
   Install standard semantic versions normally:
   ```bash
   npm install @modular@shared-packages/ui@latest
   ```
   If using pure injection (`yalc add --pure`), simply running `npm install` will fetch from the registry.

