export {
	STICKER_ID_ALIASES,
	STICKER_LIBRARY,
	STICKER_MOJIS,
	STICKER_STYLES,
	getStickerById,
	getStickerVariant,
	makeStickerId,
	resolveStickerId,
	stickersForStyle,
	type StickerMoji,
	type StickerMojiId,
	type StickerPath,
	type StickerStyle,
	type StickerStyleId,
	type StickerTemplate
} from './catalog';

export { default as StickerGlyph } from './StickerGlyph.svelte';
export { default as StickerPicker } from './StickerPicker.svelte';
