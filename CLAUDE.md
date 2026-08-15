# shared-packages

Canonical source for the published shared packages:

| Package | Path | Consumers |
|---------|------|-----------|
| `@shared-packages/ui` | `packages/ui` | `~/Code/modular-app`, `~/Code/sign-dictionary` |
| `@shared-packages/file-system` | `packages/file-system` | `~/Code/scratch-pad` (all worktrees) |
| `@shared-packages/barcode` | `packages/barcode` | `~/Code/scratch-pad` (generate + scan API) |
| `@shared-packages/compress` | `packages/compress` | `~/Code/scratch-pad` (lazy fflate / ZipKit / AddMaple pack+expand) |
| `@shared-packages/crypto` | `packages/crypto` | `~/Code/scratch-pad` (Web Crypto / libsodium hash + .spvault) |
| `@shared-packages/video` | `packages/video` | `~/Code/scratch-pad` Language Hub (trim/encode + players) |

Plus `packages/component-library`, the dev/demo app for `ui` (not published).

This is the **only editable copy** of these packages. Every consumer gets them from here via a pinned `yalc` checkout under its own `.yalc/@shared-packages/<pkg>/`, never by editing that checkout directly. Consumers enforce this with a `PreToolUse` hook that blocks edits under `.yalc/`, a drift check wired into `npm run check`, and — in scratch-pad — a deploy gate, because a direct edit there appears to work and is then silently reverted by the next publish.

That has already cost real work twice: a `module-sdk` scheduler rewrite in modular-app, and the `file-system` VFS work in scratch-pad (recursive trash restore, generation-check-before-write, `opfs.listTmp` mtimes, `serialize`'s defensive buffer copy, `sanitizeName`'s `/g` flag). The latter was recovered from stale consumer checkouts and now lives in `packages/file-system` — if those implementations look "extra" next to what you'd write, they are the correct ones.

`module-sdk`, `item-tree`, and `shell-core` used to live here too but were modular-app-specific business logic (sync engine, offline cache, schedulers, record model) rather than shared UI-library code — they moved into `~/Code/modular-app` as first-party workspace packages (`repos/module-sdk`, `repos/item-tree`, `repos/shell-core`), edited directly there with no publish/pull cycle. Keep it that way: nothing app-specific belongs back in this repo.

## Workflow: publish, don't push

After editing a package here, run **`npm run yalc:publish`** from this repo's root (delegates to each package's own `yalc:publish` script via npm workspaces). This snapshots the package into the local yalc store (`~/.yalc`) — it does **not** touch any consumer repo.

Consumers pull deliberately, on their own schedule (`npm run shared:pull` in that repo). This is a **lag-by-design** model: a consumer that hasn't pulled stays on its last-pinned version until someone there decides to update. Check `~/.yalc/installations.json` to see which repos currently consume a given package, so you know who *could* pull your change.

**Always publish before telling (or expecting) a consumer to pull.** A consumer's `yalc update`/`shared:pull` fetches the last-published snapshot from `~/.yalc` — if you skip publishing, a pull silently regresses that consumer to a stale snapshot instead of picking up your edit. (This bit us once already: a same-session scheduler rewrite in `module-sdk` got clobbered back to a pre-rewrite snapshot in `modular-app`'s `.yalc/` because publish had been skipped in favor of manually copying files.)

## Testing

Run each package's own test suite from its directory here (e.g. `cd packages/module-sdk && npx vitest run`) — not from a consumer's `.yalc` copy, which is read-only and not where fixes belong.

## If you're mid-refactor across multiple packages

It's fine for canonical to have uncommitted, unpublished, in-progress changes spanning several packages — that's normal working state here. Just be aware a consumer's `shared:pull` will only ever fetch what's been `yalc publish`ed, and `yalc-pull.sh` on the consumer side warns (non-fatally) if it detects canonical has uncommitted changes that might not be published yet — a nudge to publish first, not a guarantee everything's in sync.
