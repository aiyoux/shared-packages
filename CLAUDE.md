# shared-packages

Canonical source for the `@modular-app/*` packages (`packages/item-tree`, `packages/module-sdk`, `packages/shell-core`, `packages/ui`, `packages/component-library`). This is the **only editable copy** — every consumer app (`~/Code/modular-app`, `~/Code/sign-dictionary`, and any future ones) gets code from here via a pinned `yalc` checkout under its own `.yalc/@modular-app/<pkg>/`, never by editing that checkout directly. Those repos have a hook that blocks edits under `.yalc/` for exactly this reason.

## Workflow: publish, don't push

After editing a package here, run **`npm run yalc:publish`** from this repo's root (delegates to each package's own `yalc:publish` script via npm workspaces). This snapshots the package into the local yalc store (`~/.yalc`) — it does **not** touch any consumer repo.

Consumers pull deliberately, on their own schedule (`npm run shared:pull` in that repo). This is a **lag-by-design** model: a consumer that hasn't pulled stays on its last-pinned version until someone there decides to update. Check `~/.yalc/installations.json` to see which repos currently consume a given package, so you know who *could* pull your change.

**Always publish before telling (or expecting) a consumer to pull.** A consumer's `yalc update`/`shared:pull` fetches the last-published snapshot from `~/.yalc` — if you skip publishing, a pull silently regresses that consumer to a stale snapshot instead of picking up your edit. (This bit us once already: a same-session scheduler rewrite in `module-sdk` got clobbered back to a pre-rewrite snapshot in `modular-app`'s `.yalc/` because publish had been skipped in favor of manually copying files.)

## Testing

Run each package's own test suite from its directory here (e.g. `cd packages/module-sdk && npx vitest run`) — not from a consumer's `.yalc` copy, which is read-only and not where fixes belong.

## If you're mid-refactor across multiple packages

It's fine for canonical to have uncommitted, unpublished, in-progress changes spanning several packages — that's normal working state here. Just be aware a consumer's `shared:pull` will only ever fetch what's been `yalc publish`ed, and `yalc-pull.sh` on the consumer side warns (non-fatally) if it detects canonical has uncommitted changes that might not be published yet — a nudge to publish first, not a guarantee everything's in sync.
