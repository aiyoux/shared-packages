# @shared-packages/sticker-library

Emoji sticker catalog plus the picker UI built on it.

Two consumers today, which is why it lives here rather than in either of them:

- **scratch-pad hub** — the `/tools/stickers` shell.
- **svg-sketcher** — the sticker insert modal.

## Exports

| Entry | Contents |
|---|---|
| `@shared-packages/sticker-library` | `StickerPicker`, `StickerGlyph` (Svelte 5 components) |
| `@shared-packages/sticker-library/catalog` | the catalog data + lookup helpers, pure TS |

Import `/catalog` rather than the barrel from any plain-TS context — the barrel
re-exports `.svelte` files and needs the Svelte plugin to parse. This is the
same rule that applies to `@shared-packages/file-system/ui`.

## Changing it

Edit here. Consumers depend on this package via `file:` and HMR the change.
Run `npm install` in a consumer only when `exports` change. Never edit a
consumer's `node_modules/@shared-packages/sticker-library/` copy.
